// MUST be the first import — installs BigInt#toJSON before any response
// serialization can observe the default (which throws).
import './patches.ts'
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
import { createFolioFactory } from './domains/folio/folio.factory.ts'
import { createFolioRoutes } from './domains/folio/folio.routes.ts'
import { createGuestFactory } from './domains/guest/guest.factory.ts'
import { createGuestRoutes } from './domains/guest/guest.routes.ts'
import { createMeRoutes } from './domains/me/me.routes.ts'
import { createNotificationFactory } from './domains/notification/notification.factory.ts'
import { createPaymentFactory } from './domains/payment/payment.factory.ts'
import { createPaymentRoutes } from './domains/payment/payment.routes.ts'
import { createStubPaymentProvider } from './domains/payment/provider/stub-provider.ts'
import { createPropertyFactory } from './domains/property/property.factory.ts'
import { createPropertyRoutes } from './domains/property/property.routes.ts'
import { createRateFactory } from './domains/rate/rate.factory.ts'
import { createRateRoutes } from './domains/rate/rate.routes.ts'
import { createRatePlanFactory } from './domains/ratePlan/ratePlan.factory.ts'
import { createRatePlanRoutes } from './domains/ratePlan/ratePlan.routes.ts'
import { createRefundFactory } from './domains/refund/refund.factory.ts'
import { createRefundRoutes } from './domains/refund/refund.routes.ts'
import { createRoomFactory } from './domains/room/room.factory.ts'
import { createRoomRoutes } from './domains/room/room.routes.ts'
import { createRoomTypeFactory } from './domains/roomType/roomType.factory.ts'
import { createRoomTypeRoutes } from './domains/roomType/roomType.routes.ts'
import { env } from './env.ts'
import { onError } from './errors/on-error.ts'
import type { AppEnv } from './factory.ts'
import { listAdapters, registerAdapter } from './lib/adapters/index.ts'
import { logger } from './logger.ts'
import { createIdempotencyRepo } from './middleware/idempotency.repo.ts'
import { idempotencyMiddleware } from './middleware/idempotency.ts'
import { createOtelIngest } from './otel-ingest.ts'
import { createAdminNotificationsRoutes } from './routes/admin/notifications.ts'
import { createAdminTaxRoutes } from './routes/admin/tax.ts'
import { createActivityCdcHandler, startCdcConsumer } from './workers/cdc-consumer.ts'
import { createCancelFeeFinalizerHandler } from './workers/handlers/cancel-fee-finalizer.ts'
import { createCheckoutFinalizerHandler } from './workers/handlers/checkout-finalizer.ts'
import { createFolioBalanceHandler } from './workers/handlers/folio-balance.ts'
import { createFolioCreatorHandler } from './workers/handlers/folio-creator.ts'
import { createNotificationHandler } from './workers/handlers/notification.ts'
import { createPaymentStatusHandler } from './workers/handlers/payment-status.ts'
import { createRefundCreatorHandler } from './workers/handlers/refund-creator.ts'
import { createEmailAdapter } from './workers/lib/postbox-adapter.ts'
import { startNightAuditCron } from './workers/night-audit.cron.ts'
import { startNotificationCron } from './workers/notification-cron.ts'
import { startNotificationDispatcher } from './workers/notification-dispatcher.ts'

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
const notificationFactory = createNotificationFactory(sql, activityFactory.repo)
const guestFactory = createGuestFactory(sql)
const folioFactory = createFolioFactory(sql)
// V1 demo: stub payment provider (synchronous-success autocapture mirror of SBP).
// Real provider wiring (ЮKassa / T-Kassa / СБП) lands in Phase 3 alongside the
// webhook handler. Switch via env `PAYMENT_PROVIDER` when those impls ship.
const paymentProvider = createStubPaymentProvider()
registerAdapter({
	name: 'payment.stub',
	category: 'payment',
	mode: 'mock',
	description:
		'In-process payment stub (synchronous-success autocapture, mirrors СБП rail). ' +
		'Replace with payment.yookassa in Phase 3 (M9).',
})
const paymentFactory = createPaymentFactory(sql, paymentProvider, folioFactory.service)
const refundFactory = createRefundFactory(sql, paymentFactory.repo, paymentProvider)
const idempotency = idempotencyMiddleware(createIdempotencyRepo(sql))

// CDC consumers — exactly-once projection pipeline.
//
// Each consumer runs `createTopicTxReader` inside `startCdcConsumer`'s
// outer `sql.begin`, atomically committing the topic offset and the
// projection writes in the same datashard transaction. See
// `workers/cdc-consumer.ts` header for the full architecture.
//
// Consumer registrations (`ALTER TOPIC ... ADD CONSUMER`) live in
// migrations 0005 (booking) + 0015 (12 payment-domain consumers).
// Total wired: 13 consumers across 6 changefeeds.
//
// Handlers/factories live in `workers/cdc-consumer.ts` (activity) and
// `workers/handlers/*.ts` (4 payment-domain projections). All take a
// minimal `HandlerLogger` interface — pino satisfies it directly.

// activity_writer fan-out: 6 topics × same factory with per-domain objectType.
const bookingCdcConsumer = startCdcConsumer(driver, sql, {
	topic: 'booking/booking_events',
	consumer: 'activity_writer',
	projection: createActivityCdcHandler(activityFactory.repo, 'booking'),
	label: 'activity:booking',
})
const folioActivityConsumer = startCdcConsumer(driver, sql, {
	topic: 'folio/folio_events',
	consumer: 'activity_writer',
	projection: createActivityCdcHandler(activityFactory.repo, 'folio'),
	label: 'activity:folio',
})
const paymentActivityConsumer = startCdcConsumer(driver, sql, {
	topic: 'payment/payment_events',
	consumer: 'activity_writer',
	projection: createActivityCdcHandler(activityFactory.repo, 'payment'),
	label: 'activity:payment',
})
const refundActivityConsumer = startCdcConsumer(driver, sql, {
	topic: 'refund/refund_events',
	consumer: 'activity_writer',
	projection: createActivityCdcHandler(activityFactory.repo, 'refund'),
	label: 'activity:refund',
})
const receiptActivityConsumer = startCdcConsumer(driver, sql, {
	topic: 'receipt/receipt_events',
	consumer: 'activity_writer',
	projection: createActivityCdcHandler(activityFactory.repo, 'receipt'),
	label: 'activity:receipt',
})
const disputeActivityConsumer = startCdcConsumer(driver, sql, {
	topic: 'dispute/dispute_events',
	consumer: 'activity_writer',
	projection: createActivityCdcHandler(activityFactory.repo, 'dispute'),
	label: 'activity:dispute',
})

// folio_balance_writer fan-out: 3 topics × same factory with per-source key
// extraction. folio source is a no-op (would loop) — handler returns early.
const folioBalanceFromFolio = startCdcConsumer(driver, sql, {
	topic: 'folio/folio_events',
	consumer: 'folio_balance_writer',
	projection: createFolioBalanceHandler(logger, 'folio'),
	label: 'folio_balance:folio',
})
const folioBalanceFromPayment = startCdcConsumer(driver, sql, {
	topic: 'payment/payment_events',
	consumer: 'folio_balance_writer',
	projection: createFolioBalanceHandler(logger, 'payment'),
	label: 'folio_balance:payment',
})
const folioBalanceFromRefund = startCdcConsumer(driver, sql, {
	topic: 'refund/refund_events',
	consumer: 'folio_balance_writer',
	projection: createFolioBalanceHandler(logger, 'refund'),
	label: 'folio_balance:refund',
})

// notification_writer fan-out: 3 topics — payment + receipt + booking.
const notificationFromPayment = startCdcConsumer(driver, sql, {
	topic: 'payment/payment_events',
	consumer: 'notification_writer',
	projection: createNotificationHandler(logger, 'payment'),
	label: 'notification:payment',
})
const notificationFromReceipt = startCdcConsumer(driver, sql, {
	topic: 'receipt/receipt_events',
	consumer: 'notification_writer',
	projection: createNotificationHandler(logger, 'receipt'),
	label: 'notification:receipt',
})
// M7.B.3 — booking_confirmed notification on booking INSERT (status=confirmed).
const notificationFromBooking = startCdcConsumer(driver, sql, {
	topic: 'booking/booking_events',
	consumer: 'notification_writer',
	projection: createNotificationHandler(logger, 'booking'),
	label: 'notification:booking',
})

// payment_status_writer: 1 topic — refund_events. Derives parent
// payment.status from cumulative refund projection (canon #23).
const paymentStatusConsumer = startCdcConsumer(driver, sql, {
	topic: 'refund/refund_events',
	consumer: 'payment_status_writer',
	projection: createPaymentStatusHandler(logger),
	label: 'payment_status:refund',
})

// refund_creator_writer: 1 topic — dispute_events. Auto-creates refund
// on dispute.lost transition (canon #15 refund-causality-required).
const refundCreatorConsumer = startCdcConsumer(driver, sql, {
	topic: 'dispute/dispute_events',
	consumer: 'refund_creator_writer',
	projection: createRefundCreatorHandler(logger),
	label: 'refund_creator:dispute',
})

// folio_creator on booking — auto-create `guest` folio per new booking
// (M7.A.1, 2026-04-25). Apaleo canon: folio created upfront, charges accumulate
// via night-audit cron (M7.A.2). Idempotent via ixFolioBooking pre-check.
const folioCreatorConsumer = startCdcConsumer(driver, sql, {
	topic: 'booking/booking_events',
	consumer: 'folio_creator_writer',
	projection: createFolioCreatorHandler(logger),
	label: 'folio_creator:booking',
})

// tourism_tax_writer on booking — post 2% (Сочи 2026) tourism-tax line при
// status → checked_out. Apaleo Russia / TravelLine canon: at-checkout single
// line, не per-night. НК РФ ст. 418, min-floor 100₽ × ночей × номеров.
// Idempotent via deterministic folioLine.id `tax_<bookingId>`.
const tourismTaxConsumer = startCdcConsumer(driver, sql, {
	topic: 'booking/booking_events',
	consumer: 'tourism_tax_writer',
	projection: createCheckoutFinalizerHandler(logger),
	label: 'tourism_tax:booking',
})

// cancel_fee_writer on booking — post cancellation/no-show fee from booking
// snapshot at status → cancelled / no_show. Fee snapshotted at booking creation
// per rate plan policy (Apaleo canon — guest sees policy active when booking).
// Idempotent via deterministic folioLine.id `cancelFee_/noShowFee_<bookingId>`.
const cancelFeeConsumer = startCdcConsumer(driver, sql, {
	topic: 'booking/booking_events',
	consumer: 'cancel_fee_writer',
	projection: createCancelFeeFinalizerHandler(logger),
	label: 'cancel_fee:booking',
})

// Night-audit cron — posts per-night accommodation lines on `in_house`
// bookings at 03:00 Europe/Moscow. Boot catch-up handles restart-during-window
// gaps. Idempotent via deterministic folioLine.id (PK collision = no-op).
// Tests bypass via NODE_ENV=test (integration calls runNightAudit directly).
const nightAuditCron = process.env.NODE_ENV === 'test' ? null : startNightAuditCron(sql, logger, {})

// Notification dispatcher — polls notificationOutbox для pending rows and
// sends through the email adapter chosen by env (M7.fix.2):
//   POSTBOX_ENABLED=true + creds  → Yandex Cloud Postbox (production)
//   POSTBOX_ENABLED=false + SMTP  → Mailpit (local dev — http://localhost:8125)
//   neither                       → StubAdapter (CI / e2e log-only)
// Tests bypass via NODE_ENV=test (integration calls pollOnce directly с
// inline StubAdapter).
const notificationDispatcher =
	process.env.NODE_ENV === 'test'
		? null
		: startNotificationDispatcher(sql, createEmailAdapter(env, logger), logger, {
				fromAddress: `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_FROM_ADDRESS}>`,
			})

// Notification cron — fires checkin_reminder (24h before checkIn at 18:00 MSK)
// and review_request (24h after checkOut at 11:00 MSK). Hourly cron picks up
// eligible bookings and writes notificationOutbox rows; dispatcher sends.
// Idempotent via UNIQUE(tenantId, sourceEventDedupKey).
const notificationCron =
	process.env.NODE_ENV === 'test' ? null : startNotificationCron(sql, logger, {})

const allCdcConsumers = [
	bookingCdcConsumer,
	folioActivityConsumer,
	paymentActivityConsumer,
	refundActivityConsumer,
	receiptActivityConsumer,
	disputeActivityConsumer,
	folioBalanceFromFolio,
	folioBalanceFromPayment,
	folioBalanceFromRefund,
	notificationFromPayment,
	notificationFromReceipt,
	notificationFromBooking,
	paymentStatusConsumer,
	refundCreatorConsumer,
	folioCreatorConsumer,
	tourismTaxConsumer,
	cancelFeeConsumer,
] as const

// Graceful shutdown: SIGTERM (Serverless Container / K8s) drains the CDC
// loop before the process exits so in-flight activity INSERTs commit and
// the topic cursor advances cleanly (no message replay on restart).
/**
 * Graceful shutdown — drains in-flight CDC consumers so activity INSERTs
 * commit cleanly and the topic cursor advances before the process exits
 * (no message replay on restart). Exported for smoke/E2E harnesses that
 * need programmatic teardown in addition to SIGTERM/SIGINT delivery.
 */
export async function stopApp(): Promise<void> {
	logger.info({ count: allCdcConsumers.length }, 'shutdown: stopping CDC consumers + YDB driver')
	await Promise.all(allCdcConsumers.map((c) => c.stop()))
	if (nightAuditCron) await nightAuditCron.stop()
	if (notificationDispatcher) await notificationDispatcher.stop()
	if (notificationCron) await notificationCron.stop()
}
process.once('SIGTERM', () => {
	void stopApp()
})
process.once('SIGINT', () => {
	void stopApp()
})

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
		allowHeaders: [
			'Content-Type',
			'Authorization',
			'x-request-id',
			'traceparent',
			'tracestate',
			'Idempotency-Key',
		],
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

const otelIngest = createOtelIngest()

const routes = app
	.route('/api/otel', otelIngest)
	.route('/api/v1/properties', createPropertyRoutes(propertyFactory))
	.route('/api/v1', createRoomTypeRoutes(roomTypeFactory))
	.route('/api/v1', createRoomRoutes(roomFactory))
	.route('/api/v1', createRatePlanRoutes(ratePlanFactory))
	.route('/api/v1', createRateRoutes(rateFactory))
	.route('/api/v1', createAvailabilityRoutes(availabilityFactory))
	.route('/api/v1', createBookingRoutes(bookingFactory, idempotency))
	.route('/api/v1', createActivityRoutes(activityFactory))
	.route('/api/v1', createGuestRoutes(guestFactory, idempotency))
	.route('/api/v1', createMeRoutes())
	.route('/api/v1', createFolioRoutes(folioFactory, idempotency))
	.route('/api/v1', createPaymentRoutes(paymentFactory, idempotency))
	.route('/api/v1', createRefundRoutes(refundFactory, idempotency))
	.route('/api/admin', createAdminTaxRoutes(bookingFactory))
	.route('/api/admin', createAdminNotificationsRoutes(notificationFactory.service))
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
	// Truthful runtime view of every registered external-integration adapter.
	// Operators use this for go-live verification: «what's mock, sandbox, live?»
	// Returns 200 in `APP_MODE=sandbox` regardless of contents; in
	// `APP_MODE=production` returns 503 if any adapter is non-live (without
	// the explicit whitelist) — same contract as the startup gate.
	.get('/health/adapters', (c) => {
		const adapters = listAdapters().map((a) => ({
			name: a.name,
			category: a.category,
			mode: a.mode,
			description: a.description,
			providerVersion: a.providerVersion ?? null,
		}))
		const whitelist = new Set(env.APP_MODE_PERMITTED_MOCK_ADAPTERS)
		const offenders = adapters.filter(
			(a) => (a.mode === 'mock' || a.mode === 'sandbox') && !whitelist.has(a.name),
		)
		const isReady = env.APP_MODE === 'sandbox' || offenders.length === 0
		return c.json(
			{
				status: isReady ? ('ok' as const) : ('degraded' as const),
				appMode: env.APP_MODE,
				adapters,
				offendersInProduction: offenders.map((o) => o.name),
				time: new Date().toISOString(),
			},
			isReady ? 200 : 503,
		)
	})

export type AppType = typeof routes
export { app }
