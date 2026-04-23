import { YDBError } from '@ydbjs/error'
import { Hono } from 'hono'
import { contextStorage } from 'hono/context-storage'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { pinoLogger } from 'hono-pino'
import { z } from 'zod'
import { auth } from './auth.ts'
import { sql } from './db/index.ts'
import { createPropertyFactory } from './domains/property/property.factory.ts'
import { createPropertyRoutes } from './domains/property/property.routes.ts'
import { createRatePlanFactory } from './domains/ratePlan/ratePlan.factory.ts'
import { createRatePlanRoutes } from './domains/ratePlan/ratePlan.routes.ts'
import { createRoomFactory } from './domains/room/room.factory.ts'
import { createRoomRoutes } from './domains/room/room.routes.ts'
import { createRoomTypeFactory } from './domains/roomType/roomType.factory.ts'
import { createRoomTypeRoutes } from './domains/roomType/roomType.routes.ts'
import { env } from './env.ts'
import { DomainError } from './errors/domain.ts'
import { HTTP_STATUS_MAP } from './errors/http-mapping.ts'
import type { AppEnv } from './factory.ts'
import { logger } from './logger.ts'

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

// Global error handler. Domain errors map via HTTP_STATUS_MAP (404/409/403/400);
// YDBError → 503 DB_ERROR (upstream problem, client may retry);
// ZodError here means repo-row schema drift (user input is validated by
// @hono/zod-validator middleware before reaching handlers) — log + 500;
// everything else is unexpected — log the cause chain + 500 INTERNAL.
app.onError((err, c) => {
	if (err instanceof DomainError) {
		const status = HTTP_STATUS_MAP[err.code] ?? 500
		c.var.logger.warn({ err, code: err.code, status }, 'domain error')
		return c.json({ error: { code: err.code, message: err.message } }, status)
	}
	if (err instanceof YDBError) {
		c.var.logger.error({ err, ydbCode: err.code }, 'YDB error')
		return c.json({ error: { code: 'DB_ERROR', message: 'Database temporarily unavailable' } }, 503)
	}
	if (err instanceof z.ZodError) {
		c.var.logger.error({ err: err.flatten() }, 'schema drift in repo row')
		return c.json({ error: { code: 'INTERNAL', message: 'Internal data shape mismatch' } }, 500)
	}
	c.var.logger.error({ err }, 'unhandled error')
	return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500)
})

// Better Auth mounts its own router at /api/auth/** (sign-up/email, sign-in/email,
// sign-out, get-session, organization/create, organization/invite, etc.).
// We proxy all /api/auth/* requests to auth.handler; it handles method and body parsing.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

const routes = app
	.route('/api/v1/properties', createPropertyRoutes(propertyFactory))
	.route('/api/v1', createRoomTypeRoutes(roomTypeFactory))
	.route('/api/v1', createRoomRoutes(roomFactory))
	.route('/api/v1', createRatePlanRoutes(ratePlanFactory))
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
