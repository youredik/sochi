import { Hono } from 'hono'
import { contextStorage } from 'hono/context-storage'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { pinoLogger } from 'hono-pino'
import { auth } from './auth.ts'
import { driver, sql } from './db/index.ts'
import { createActivityFactory } from './domains/activity/activity.factory.ts'
import { createActivityRoutes } from './domains/activity/activity.routes.ts'
import { createAvailabilityFactory } from './domains/availability/availability.factory.ts'
import { createAvailabilityRoutes } from './domains/availability/availability.routes.ts'
import { createBookingFactory } from './domains/booking/booking.factory.ts'
import { createBookingRoutes } from './domains/booking/booking.routes.ts'
import { createPropertyFactory } from './domains/property/property.factory.ts'
import { createPropertyRoutes } from './domains/property/property.routes.ts'
import { createRateFactory } from './domains/rate/rate.factory.ts'
import { createRateRoutes } from './domains/rate/rate.routes.ts'
import { createRatePlanFactory } from './domains/ratePlan/ratePlan.factory.ts'
import { createRatePlanRoutes } from './domains/ratePlan/ratePlan.routes.ts'
import { createRoomFactory } from './domains/room/room.factory.ts'
import { createRoomRoutes } from './domains/room/room.routes.ts'
import { createRoomTypeFactory } from './domains/roomType/roomType.factory.ts'
import { createRoomTypeRoutes } from './domains/roomType/roomType.routes.ts'
import { env } from './env.ts'
import { onError } from './errors/on-error.ts'
import type { AppEnv } from './factory.ts'
import { logger } from './logger.ts'
import { createIdempotencyRepo } from './middleware/idempotency.repo.ts'
import { idempotencyMiddleware } from './middleware/idempotency.ts'
import { createActivityCdcHandler, startCdcConsumer } from './workers/cdc-consumer.ts'

/**
 * Hono app with method-chained routes for type-safe RPC.
 * Export type `AppType = typeof routes` — NOT `typeof app`.
 */
const app = new Hono<AppEnv>()

// Domain factories (one place to wire sql → repo → service).
const propertyFactory = createPropertyFactory(sql)
const roomTypeFactory = createRoomTypeFactory(sql, propertyFactory.service)
const roomFactory = createRoomFactory(sql, propertyFactory.service, roomTypeFactory.service)
const ratePlanFactory = createRatePlanFactory(sql, propertyFactory.service, roomTypeFactory.service)
const rateFactory = createRateFactory(sql, ratePlanFactory.service)
const availabilityFactory = createAvailabilityFactory(sql, roomTypeFactory.service)
const bookingFactory = createBookingFactory(
	sql,
	rateFactory.repo,
	propertyFactory.service,
	roomTypeFactory.service,
	ratePlanFactory.service,
)
const activityFactory = createActivityFactory(sql)
const idempotency = idempotencyMiddleware(createIdempotencyRepo(sql))

// CDC consumer — populates the polymorphic `activity` table by diffing
// oldImage/newImage from the `booking/booking_events` changefeed. Started
// in-process for MVP; portable to a Serverless Container post-MVP without
// touching the writer side (ALTER TABLE ... ADD CHANGEFEED stays the
// single source of truth). See memory `project_event_architecture.md`.
// Consumer name registered via migration 0005.
const bookingCdcConsumer = startCdcConsumer(driver, {
	topic: 'booking/booking_events',
	consumer: 'activity_writer',
	handler: createActivityCdcHandler(activityFactory.repo, 'booking'),
	label: 'activity:booking',
})

// Graceful shutdown: SIGTERM (Serverless Container / K8s) drains the CDC
// loop before the process exits so in-flight activity INSERTs commit and
// the topic cursor advances cleanly (no message replay on restart).
const shutdown = async (signal: NodeJS.Signals) => {
	logger.info({ signal }, 'shutdown: stopping CDC consumers + YDB driver')
	await bookingCdcConsumer.stop()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

const trustedOrigins = env.BETTER_AUTH_TRUSTED_ORIGINS.split(',')
	.map((o) => o.trim())
	.filter((o) => o.length > 0)

// contextStorage MUST be the very first middleware — it snapshots `c.var` into
// an AsyncLocalStorage so deeply-nested code (repos, background tasks spawned
// during a request) can read `requestId`/`tenantId`/`logger` without threading
// them through every parameter. See `src/context.ts`.
app.use('*', contextStorage())

// Request ID runs next so every subsequent middleware (pino logger, services)
// can read `c.var.requestId`. Echoed as `X-Request-Id` response header.
app.use('*', requestId())

// Structured request/response logging with per-request child logger in c.var.logger.
// hono-pino picks up `requestId` from the context automatically via referRequestIdKey.
app.use('*', pinoLogger({ pino: logger }))

app.use(
	'*',
	cors({
		origin: trustedOrigins.length > 0 ? trustedOrigins : env.BETTER_AUTH_URL,
		credentials: true,
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		// `traceparent`/`tracestate` prepare us for OpenTelemetry W3C context propagation;
		// `x-request-id` so frontends can correlate their own UUIDs if they choose.
		allowHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'traceparent', 'tracestate'],
		exposeHeaders: ['X-Request-Id'],
		maxAge: 86400,
	}),
)

// Global error handler — domain/YDB/Zod → mapped JSON; fallback 500. Shared
// with middleware/route tests via `src/errors/on-error.ts`.
app.onError(onError)

// Better Auth mounts its own router at /api/auth/** (sign-up/email, sign-in/email,
// sign-out, get-session, organization/create, organization/invite, etc.).
// We proxy all /api/auth/* requests to auth.handler; it handles method and body parsing.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

const routes = app
	.route('/api/v1/properties', createPropertyRoutes(propertyFactory))
	.route('/api/v1', createRoomTypeRoutes(roomTypeFactory))
	.route('/api/v1', createRoomRoutes(roomFactory))
	.route('/api/v1', createRatePlanRoutes(ratePlanFactory))
	.route('/api/v1', createRateRoutes(rateFactory))
	.route('/api/v1', createAvailabilityRoutes(availabilityFactory))
	.route('/api/v1', createBookingRoutes(bookingFactory, idempotency))
	.route('/api/v1', createActivityRoutes(activityFactory))
	.get('/health', (c) =>
		c.json(
			{
				status: 'ok' as const,
				service: 'horeca-backend',
				time: new Date().toISOString(),
			},
			200,
		),
	)
	.get('/health/db', async (c) => {
		// Unified shape so the Hono RPC client sees a single response type,
		// not a union. `error` is always present on the type (optional string).
		try {
			const result = await sql<[{ ok: number }]>`SELECT 1 AS ok`
			const ok = result[0]?.[0]?.ok === 1
			return c.json(
				{
					status: ok ? ('ok' as const) : ('degraded' as const),
					ydb: { connected: ok, error: undefined as string | undefined },
					time: new Date().toISOString(),
				},
				ok ? 200 : 503,
			)
		} catch (error) {
			c.var.logger.error({ err: error }, 'YDB health check failed')
			return c.json(
				{
					status: 'degraded' as const,
					ydb: { connected: false, error: String(error) as string | undefined },
					time: new Date().toISOString(),
				},
				503,
			)
		}
	})

export type AppType = typeof routes
export { app }
