// MUST be the first import — installs BigInt#toJSON before any response
// serialization can observe the default (which throws).
import './patches.ts'
import { newId } from '@horeca/shared'
import { Hono } from 'hono'
import { contextStorage } from 'hono/context-storage'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
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
import { createPropertyBlockFactory } from './domains/property-block/property-block.factory.ts'
import { createPropertyBlockRoutes } from './domains/property-block/property-block.routes.ts'
import { createGuestPortalRepo } from './domains/booking/guest-portal.repo.ts'
import { createGuestPortalRoutes } from './domains/booking/guest-portal.routes.ts'
import { createChannelFactory } from './domains/channel/channel.factory.ts'
import { registerOstrovokEtgWithChannelFactory } from './domains/channel/ostrovok-etg/ostrovok-etg.factory.ts'
import { registerTravellineWithChannelFactory } from './domains/channel/travelline/travelline.factory.ts'
import { registerYandexTravelWithChannelFactory } from './domains/channel/yandex-travel/yandex-travel.factory.ts'
import { createMockArchiveBuilder } from './domains/epgu/archive/mock-archive.ts'
import { createMigrationRegistrationFactory } from './domains/epgu/registration/registration.factory.ts'
import { createMigrationRegistrationRoutes } from './domains/epgu/registration/registration.routes.ts'
import { createMockRklCheck } from './domains/epgu/rkl/mock-rkl.ts'
import { createMockEpguTransport } from './domains/epgu/transport/mock-epgu.ts'
import { createVisionAdapterFromEnv } from './domains/epgu/vision/vision.factory.ts'
import { createVisionRoutes } from './domains/epgu/vision/vision.routes.ts'
import { createConsentRevokeRoutes } from './domains/epgu/passport-scan/consent/consent-revoke.routes.ts'
import { createGuestDocumentRoutes } from './domains/guest/guest-document.routes.ts'
import { createPassportDataExportRoutes } from './domains/epgu/passport-scan/dsar/passport-data-export.routes.ts'
import { createPassportScanFactory } from './domains/epgu/passport-scan/passport-scan.factory.ts'
import { createPassportPhotoStorageFromEnv } from './domains/epgu/passport-scan/storage/passport-photo-storage.factory.ts'
import { createFolioFactory } from './domains/folio/folio.factory.ts'
import { createDaDataAdapter } from './domains/identity/dadata/factory.ts'
import { createDemoInboxRoutes } from './domains/demo/inbox.routes.ts'
import { createDemoSmsInboxRoutes } from './domains/demo/sms-inbox.routes.ts'
import { demoInboxRateLimiter } from './middleware/demo-inbox-rate-limit.ts'
import { magicLinkRateLimit, orgCreateRateLimit } from './middleware/auth-signup-rate-limit.ts'
import { initDemoInboxSms } from './workers/lib/demo-inbox-sms-adapter.ts'
import { createIdentityRoutes } from './domains/identity/identity.routes.ts'
import { createOnboardingFactory } from './domains/onboarding/onboarding.factory.ts'
import { createOnboardingRoutes } from './domains/onboarding/onboarding.routes.ts'
import { createFolioRoutes } from './domains/folio/folio.routes.ts'
import { createGuestFactory } from './domains/guest/guest.factory.ts'
import { createGuestRoutes } from './domains/guest/guest.routes.ts'
import { createMeRoutes } from './domains/me/me.routes.ts'
import { createNotificationFactory } from './domains/notification/notification.factory.ts'
import { RumBuffer } from './domains/observability/rum.repo.ts'
import { createRumRoutes } from './domains/observability/rum.routes.ts'
import { createPaymentFactory } from './domains/payment/payment.factory.ts'
import { createPaymentRoutes } from './domains/payment/payment.routes.ts'
import { createPaymentWebhookEventRepo } from './domains/payment/payment-webhook-event.repo.ts'
import { createPaymentWebhookRoutes } from './domains/payment/payment-webhook.routes.ts'
import { createPaymentProviderFromEnv } from './domains/payment/provider/factory.ts'
import { createPropertyFactory } from './domains/property/property.factory.ts'
import { createPropertyRoutes } from './domains/property/property.routes.ts'
import { createPropertyContentFactory } from './domains/property/property-content.factory.ts'
import { createPropertyContentRoutes } from './domains/property/property-content.routes.ts'
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
import { createTenantComplianceFactory } from './domains/tenant/compliance.factory.ts'
import { createTenantComplianceRoutes } from './domains/tenant/compliance.routes.ts'
import { createWidgetBookingCreateFactory } from './domains/widget/booking-create.factory.ts'
import { createWidgetBookingCreateRoutes } from './domains/widget/booking-create.routes.ts'
import { createBookingFindRepo } from './domains/widget/booking-find.repo.ts'
import { createBookingFindRoutes } from './domains/widget/booking-find.routes.ts'
import { createEmbedFactory } from './domains/widget/embed.factory.ts'
import { createEmbedRoutes } from './domains/widget/embed.routes.ts'
import { createIframeHtmlRoutes } from './domains/widget/iframe-html.routes.ts'
import { createMagicLinkFactory } from './domains/widget/magic-link.factory.ts'
import { createMagicLinkConsumeRoutes } from './domains/widget/magic-link-consume.routes.ts'
import { createWidgetFactory } from './domains/widget/widget.factory.ts'
import { createWidgetRoutes } from './domains/widget/widget.routes.ts'
import { env } from './env.ts'
import { onError } from './errors/on-error.ts'
import type { AppEnv } from './factory.ts'
import { listAdapters, registerAdapter } from './lib/adapters/index.ts'
import { createMagicLinkSecretResolver } from './lib/magic-link/secret.ts'
import { createReadinessEvaluator } from './lib/readiness.ts'
import { logger } from './logger.ts'
import { loadTenantMode } from './middleware/demo-lock.ts'
import { createIdempotencyRepo } from './middleware/idempotency.repo.ts'
import { idempotencyMiddleware } from './middleware/idempotency.ts'
import { createOtelIngest } from './otel-ingest.ts'
import { createAdminChannelRoutes } from './routes/admin/channels.ts'
import { createAdminNotificationsRoutes } from './routes/admin/notifications.ts'
import { createAdminTaxRoutes } from './routes/admin/tax.ts'
import { createBookingSseCdcHandler } from './sse/booking-cdc-projection.ts'
import { createBookingEventBroadcaster } from './sse/booking-event-broadcaster.ts'
import { broadcastShutdown, createSseRoutes } from './sse/sse.routes.ts'
import { createActivityCdcHandler, startCdcConsumer } from './workers/cdc-consumer.ts'
import { startDemoRefreshCron } from './workers/demo-refresh.cron.ts'
import { createCancelFeeFinalizerHandler } from './workers/handlers/cancel-fee-finalizer.ts'
import { createChannelBroadcastHandler } from './workers/handlers/channel-broadcast.ts'
import { createCheckoutFinalizerHandler } from './workers/handlers/checkout-finalizer.ts'
import { createFolioBalanceHandler } from './workers/handlers/folio-balance.ts'
import { createFolioCreatorHandler } from './workers/handlers/folio-creator.ts'
import { createSlotReconciliationHandler } from './workers/handlers/slot-reconciliation.ts'
import { createMigrationRegistrationEnqueuerHandler } from './workers/handlers/migration-registration-enqueuer.ts'
import { createNotificationHandler } from './workers/handlers/notification.ts'
import { createOpsMetricsRoutes } from './domains/observability/ops-metrics.routes.ts'
import { createPassportScanAuditProjectorHandler } from './workers/handlers/passport-scan-audit-projector.ts'
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
const propertyContentFactory = createPropertyContentFactory(sql)
const tenantComplianceFactory = createTenantComplianceFactory(sql)
const roomTypeFactory = createRoomTypeFactory(sql, propertyFactory.service)
const roomFactory = createRoomFactory(sql, propertyFactory.service, roomTypeFactory.service)
const ratePlanFactory = createRatePlanFactory(sql, propertyFactory.service, roomTypeFactory.service)
const rateFactory = createRateFactory(sql, ratePlanFactory.service)
const availabilityFactory = createAvailabilityFactory(sql, roomTypeFactory.service)
// guestFactory создаётся ДО bookingFactory — booking.service.checkIn (Sprint C+
// Round 7 2026-05-24) wants guestDocumentRepo для 109-ФЗ ст. 22 hard-gate.
// guestFactory deps = только sql, безопасно поднять выше.
const guestFactory = createGuestFactory(sql)
const bookingFactory = createBookingFactory(
	sql,
	rateFactory.repo,
	propertyFactory.service,
	roomTypeFactory.service,
	ratePlanFactory.service,
	// G8 (2026-05-16) — roomService wired для assign-room + auto-assign endpoints.
	roomFactory.service,
	// Default clock (realTimeProvider) — production runtime.
	undefined,
	// Sprint C+ Round 6 Legal P0 fix 2026-05-24 — ПП-1951 КСР hard-gate.
	// booking.service.create вызывает complianceRepo.assertKsrRegistryNumber
	// PresentPresent перед всем остальным; throws KsrRegistryNumberMissingError
	// → HTTP 428 для tenants без реестрового номера.
	tenantComplianceFactory.repo,
	// Sprint C+ Round 7 Senior P0 fix 2026-05-24 — 109-ФЗ ст. 22 hard-gate.
	// booking.service.checkIn rejects foreign-citizen check-in без active
	// guestDocument → throws PassportScanRequiredError → HTTP 428. Mirrors
	// frontend booking-edit-sheet hard-gate против direct API bypass.
	guestFactory.documentRepo,
)
// G9 (2026-05-16) — property-block (OOO/maintenance) domain. Depends on
// booking.repo (block-over-booking overlap check) + roomService + property.
const propertyBlockFactory = createPropertyBlockFactory(
	sql,
	bookingFactory.repo,
	propertyFactory.service,
	roomFactory.service,
)
const activityFactory = createActivityFactory(sql)
const notificationFactory = createNotificationFactory(sql, activityFactory.repo)
const folioFactory = createFolioFactory(sql)
// M9.widget.1 — public booking widget read surface (no auth, no tenant
// middleware — slug-resolved tenant per request).
const widgetFactory = createWidgetFactory(sql)
// M9.widget.4 — public booking widget commit (Screen 3 Guest+Pay). Composes
// widget/guest/booking/payment services. Stub-provider в demo, live ЮKassa
// в C2 — ZERO domain code changes (factory binding).
// Wiring deferred ниже после payment factory.
// M8.A.5 — миграционный учёт МВД (функция 1.1).
// Mock adapters wired по умолчанию (APP_MODE=mock|sandbox); swap на live
// = factory binding в registry. Behaviour-faithful per research/epgu-rkl.md.
const epguTransport = createMockEpguTransport()
registerAdapter({
	name: 'epgu.mock',
	category: 'epgu',
	mode: 'mock',
	description:
		'In-process behaviour-faithful Скала-ЕПГУ simulator (FSM, 14 status codes, ' +
		'8 error categories, P95=20m P99=60m polling cadence). Replace with ' +
		'gost-tls / svoks / proxy-via-partner transport in M8.A.live.',
})
const rklAdapter = createMockRklCheck()
registerAdapter({
	name: 'rkl.mock',
	category: 'rkl',
	mode: 'mock',
	description:
		'In-process Контур.ФМС simulator (99/0.5/0.5 distribution clean/match/inconclusive, ' +
		'50-300ms latency, daily registry revision). Replace with HTTP client in M8.A.live.',
})
// P2 (2026-05-19) — env-driven Vision adapter: mock | yandex.
// mock      → `vision.mock`   mode='mock'   (default dev/test)
// yandex    → `vision.yandex` mode='sandbox' (APP_MODE=sandbox)
//                              mode='live'    (APP_MODE=production)
// Endpoint canon: https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText
// (Vision passport-model migrated к OCR namespace Q1 2026).
const visionResult = createVisionAdapterFromEnv({
	visionProvider: env.VISION_PROVIDER,
	appMode: env.APP_MODE,
	ycVisionApiKey: env.YC_VISION_API_KEY,
	ycVisionFolderId: env.YC_VISION_FOLDER_ID,
})
const visionOcrAdapter = visionResult.adapter

// Passport photo storage — YC Object Storage native (Sprint B 2026-05-22).
// 90-day retention bucket lifecycle policy в Terraform — auto-delete без cron.
const passportPhotoStorageResult = createPassportPhotoStorageFromEnv({
	storageProvider: env.PASSPORT_PHOTO_STORAGE,
	appMode: env.APP_MODE,
	s3Endpoint: env.S3_ENDPOINT,
	s3Region: env.S3_REGION,
	s3AccessKeyId: env.S3_ACCESS_KEY_ID,
	s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
	s3Bucket: env.S3_BUCKET_PASSPORT_SCANS ?? env.S3_BUCKET,
})
const passportPhotoStorage = passportPhotoStorageResult.adapter

// Sprint C: passport-scan factory — owns consent + audit repos + atomic write
// helper + RTBF cascade. Routes import factory type, not `sql` directly
// (depcruise `no-routes-to-db` enforcement).
const passportScanFactory = createPassportScanFactory(sql)

registerAdapter(visionResult.metadata)
// DaData identity-lookup adapter — auto-fills ИНН → org name/address/tax regime
// в 2-step onboarding wizard. Mock-вариант возвращает canonical demo dataset
// (Сочи/Сириус/Красная Поляна) для demo тенантов per [[demo_strategy]];
// real-вариант hits suggestions.dadata.ru when DADATA_API_KEY is set.
const dadata = createDaDataAdapter({ apiKey: env.DADATA_API_KEY })
registerAdapter(dadata.metadata)

// Demo inbox adapter — registered ONLY when DEMO_DEPLOYMENT=true so the
// production deployment never carries a Mock email adapter (which would
// fail `assertProductionReady()` без explicit whitelist). The actual
// adapter instance is the singleton owned by `postbox-adapter.ts` factory;
// registry entry is purely для /api/health/adapters introspection.
if (env.DEMO_DEPLOYMENT) {
	registerAdapter({
		name: 'email.demo-inbox',
		category: 'email',
		mode: 'mock',
		description:
			'In-process Demo Inbox — captures magic-link emails per recipient for the public demo flow ' +
			'per [[demo_strategy]] + [[behaviour_faithful_mock_canon]]. ' +
			'Activated by DEMO_DEPLOYMENT=true env var; paired с frontend VITE_DEMO_DEPLOYMENT=true.',
	})
	// P3 (2026-05-19): SMS demo inbox singleton init — symmetric к email canon.
	// SMS adapter is capture-only; production SMS provider (Yandex Cloud
	// Notification Service) lands в P3.live с opt-in verified-destination
	// flow per AWS End User Messaging Sandbox pattern (research 2026-05-19).
	initDemoInboxSms()
	registerAdapter({
		name: 'sms.demo-inbox',
		category: 'sms',
		mode: 'mock',
		description:
			'In-process Demo SMS Inbox — captures booking confirmations / OTPs per E.164 phone ' +
			'for the public demo flow. Production = Yandex Cloud Notification Service (SNS-compat) ' +
			'in P3.live. Activated by DEMO_DEPLOYMENT=true; paired с frontend VITE_DEMO_DEPLOYMENT=true.',
	})
}
// Bulk-inventory onboarding factory — single-tx property + roomType + N rooms
// + ratePlan create, replays via Idempotency-Key middleware.
const onboardingFactory = createOnboardingFactory(sql)
// M8.A.5.archive — behaviour-faithful Скала-ЕПГУ archive builder. Demo
// тенанты используют ВСЕГДА (Mock pipeline end-to-end). Real КриптоПро CSP
// integration land в M8.B при МВД ОВМ onboarding completion. Swap = factory
// binding изменение, без domain-code changes.
const archiveBuilder = createMockArchiveBuilder()
registerAdapter({
	name: 'archive.mock',
	category: 'epgu',
	mode: 'mock',
	description:
		'Behaviour-faithful Скала-ЕПГУ archive builder (req.xml + attach.xml + ' +
		'до 6 scans + ГОСТ-shaped placeholder signatures). Real КриптоПро CSP ' +
		'integration в M8.B (требует МВД ОВМ onboarding agreement + commercial license).',
})
const migrationRegistrationFactory = createMigrationRegistrationFactory({
	sql,
	transport: epguTransport,
	rkl: rklAdapter,
	archive: archiveBuilder,
	idGen: () => newId('migrationRegistration'),
})
// P1.1 (2026-05-18) — env-driven payment provider selection: stub | yookassa.
// stub        → `payment.stub`     mode='mock'  (default in dev/test)
// yookassa    → `payment.yookassa` mode='sandbox' (APP_MODE=sandbox)
//                                   mode='live'    (APP_MODE=production)
// P1.2 lands the real ЮKassa REST impl (initiate/capture/refund/verifyWebhook).
// P1.3 lands the webhook handler route. See plans/demo-live-integrations-plan.md.
const paymentProviderResult = createPaymentProviderFromEnv({
	paymentProvider: env.PAYMENT_PROVIDER,
	appMode: env.APP_MODE,
	yookassaShopId: env.YOOKASSA_SHOP_ID,
	yookassaSecretKey: env.YOOKASSA_SECRET_KEY,
	yookassaSecretKeyPrevious: env.YOOKASSA_SECRET_KEY_PREVIOUS,
	yookassaApiBase: env.YOOKASSA_API_BASE,
	// `return_url` для confirmation redirect — derive от PUBLIC_BASE_URL.
	// PCI SAQ-A path: HTTPS-only в production (Yandex Cloud сертификаты).
	yookassaReturnUrl: `${env.PUBLIC_BASE_URL}/booking/payment-return`,
})
const paymentProvider = paymentProviderResult.provider
registerAdapter(paymentProviderResult.metadata)
const paymentFactory = createPaymentFactory(sql, paymentProvider, folioFactory.service)
const refundFactory = createRefundFactory(sql, paymentFactory.repo, paymentProvider)
// P1 (2026-05-18) — inbound webhook event inbox (paymentWebhookEvent table,
// PK 3D dedup with 30d TTL). NO CHANGEFEED — sink for verified webhooks,
// downstream transitions emit via payment_events / refund_events.
const paymentWebhookEventRepo = createPaymentWebhookEventRepo(sql)
const idempotency = idempotencyMiddleware(createIdempotencyRepo(sql))

// M9.widget.4 — booking-create factory (composes widget/guest/booking/payment).
const widgetBookingCreateFactory = createWidgetBookingCreateFactory({
	sql,
	widgetService: widgetFactory.service,
	guestService: guestFactory.service,
	bookingService: bookingFactory.service,
	paymentService: paymentFactory.service,
})

// M9.widget.5 / A3.1.b — magic-link factory + cookie secret resolver shared
// across magic-link consume routes (and future booking-find / guest-portal).
// Phase 1: cookie secret = magicLinkSecret (same value, dual purpose).
// Phase 2 Track B5/Lockbox: dedicated cookie-signing secret.
const magicLinkFactory = createMagicLinkFactory(sql)
const magicLinkSecretResolver = createMagicLinkSecretResolver(sql)

// M9.widget.6 / А4.3 — embed widget factory: per-tenant `publicEmbedDomains`
// allowlist + `widgetReleaseAudit` append-only log + bundles loaded from
// `apps/widget-embed/dist/` at startup + `clientCommitToken` HMAC sliding-
// window rotation (D25). Production deploys must override the dev-stub
// secrets via `COMMIT_TOKEN_HMAC_CURRENT` + `COMMIT_TOKEN_HMAC_PREVIOUS`
// seeded from Yandex Lockbox.
const embedFactory = createEmbedFactory({
	sql,
	currentSecretBase64: env.COMMIT_TOKEN_HMAC_CURRENT,
	previousSecretBase64: env.COMMIT_TOKEN_HMAC_PREVIOUS,
})

// M9.widget.7 / A5.2 — RUM (Real User Monitoring) edge buffer.
// Capacity 5000 (D9). Drained by YC Monitoring exporter (wired в M11+ alongside
// Lockbox IAM credentials); current build no-ops the exporter — buffer is
// observable via /api/rum/v1/web-vitals POST volume.
const rumBuffer = new RumBuffer({ capacity: 5000 })

// M10 / A7.1.fix — channel manager runtime: 5 repos + per-tenant LRU adapter
// cache (lru-cache@11.3.6) + dispatcher worker (Hookdeck tiered retry) + inbound
// webhook routes (Standard Webhooks signature + IP-allowlist fallback). Adapter
// implementations land in A7.2 (TravelLine) / A7.3 (Yandex.Travel) / A7.4
// (Ostrovok ETG) — they call channelFactory.registerAdapterFactory() +
// .registerHttpAttempt() at module-eval. Dispatcher is OFF in tests (NODE_ENV=test
// integration calls dispatcher.processRow directly with inline mocks).
const channelFactory = createChannelFactory(sql, {
	enableDispatcher: process.env.NODE_ENV !== 'test',
})

// M10 / A7.2 — TravelLine Mock adapter registered. Live-flip = swap factory body
// в `travelline.factory.ts` к live HTTP client; ZERO domain code changes.
registerTravellineWithChannelFactory(channelFactory)
registerAdapter({
	name: 'channel.travelline.mock',
	category: 'channel',
	mode: 'mock',
	description:
		'Behaviour-faithful TravelLine Mock (D1-D5: source-of-truth ARI / polling-not-webhook / ' +
		'OAuth Client-Credentials JWT 15min / 3rps-15rpm-300rph per-IP rate-limit / verify→create ' +
		'two-step + 24h CreateBookingToken + Checksum / tlRoomTypeId-tlRatePlanId mapping). ' +
		'Replace with live HTTP client adapter in M10.live (партнёр TL onboarding).',
})

// M10 / A7.3 — Yandex.Travel Mock (Bnovo CM passthrough emulation).
// Live-flip = onboard via partnered CM (Bnovo) — direct YT API self-build is
// breach of YT partner agreement (D6).
registerYandexTravelWithChannelFactory(channelFactory)
registerAdapter({
	name: 'channel.yandex-travel.mock',
	category: 'channel',
	mode: 'mock',
	description:
		'Behaviour-faithful Yandex.Travel Mock impersonating Bnovo CM passthrough (D6: NO direct ' +
		'YT API). HMAC-SHA256 signature + 300s replay window + IP-allowlist gate (D25.c). ' +
		'152-ФЗ residency (RU photo hosts only) + 3-checkbox granular consent + RUB-only currency. ' +
		'Replace with Bnovo HTTP client adapter in M10.live (CM partner onboarding).',
})

// M10 / A7.4 — Ostrovok ETG Mock (5-stage SM + 4-brand fan-out).
// Live-flip = swap factory body к raw HTTP client с Basic Auth via YC Lockbox
// creds (ETG SDK does NOT exist on npm — confirmed empirical 2026-05-04, D7).
registerOstrovokEtgWithChannelFactory(channelFactory)
registerAdapter({
	name: 'channel.ostrovok-etg.mock',
	category: 'channel',
	mode: 'mock',
	description:
		'Behaviour-faithful Ostrovok ETG Mock (D7-D10: HTTP Basic Auth id:uuid / 5-stage SM ' +
		'search→prebook→book→start→check / partner_order_id UUID v4 rotation on double_booking_form ' +
		'(cap 3 retries) / webhook terminal-only opt-in / stuck-in-book 90s non-3DS, 600s 3DS / ' +
		'4-brand fan-out RateHawk|ZenHotels|B2B.Ostrovok|Ostrovok / 3 commercial models / ' +
		'rg_ext photos / sandbox demo-hotel hid=8473727). Replace with raw HTTP client in M10.live.',
})

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
// M8.A.5.cdc.B — миграционный учёт audit projection. FSM transitions
// 0 → 17 → 3/4/10 эмитят statusChange activities (statusCode column,
// per STATUS_FIELD_BY_OBJECT_TYPE override в cdc-handlers.ts).
const migrationRegistrationActivityConsumer = startCdcConsumer(driver, sql, {
	topic: 'migrationRegistration/migrationRegistration_events',
	consumer: 'activity_writer',
	projection: createActivityCdcHandler(activityFactory.repo, 'migrationRegistration'),
	label: 'activity:migrationRegistration',
})

// M10 / A7.1.fix — channel manager outbound retry log.
// Each pending → sent | dlq | disabled transition projects к activity для
// admin overlay timeline (A7.5).
const channelDispatchActivityConsumer = startCdcConsumer(driver, sql, {
	topic: 'channelDispatch/channelDispatch_events',
	consumer: 'activity_writer',
	projection: createActivityCdcHandler(activityFactory.repo, 'channelDispatch'),
	label: 'activity:channelDispatch',
})

// M10 / A7.1.fix — channel manager inbound webhook log.
// Each idempotent receive (accepted/duplicate/tampered) projects к activity
// для forensic + operator alerting on tamper events.
const channelInboxActivityConsumer = startCdcConsumer(driver, sql, {
	topic: 'channelInbox/channelInbox_events',
	consumer: 'activity_writer',
	projection: createActivityCdcHandler(activityFactory.repo, 'channelInbox'),
	label: 'activity:channelInbox',
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

// migration_registration_enqueuer on booking — auto-create draft
// migrationRegistration row при check-in (status: * → in_house) для
// последующего ЕПГУ submission (Боль 1.1, штраф 500k ₽ за non-compliance
// с 1.1.2026). Per Постановление №1668: 24h deadline ОТ check-in moment.
// Graceful skip если tenant epgu config неполный (МВД ОВМ onboarding pending)
// или нет guestDocument для primaryGuestId. Idempotent via
// idxMigRegTenantBooking pre-check.
const migrationRegistrationEnqueuerConsumer = startCdcConsumer(driver, sql, {
	topic: 'booking/booking_events',
	consumer: 'migration_registration_enqueuer',
	projection: createMigrationRegistrationEnqueuerHandler(logger),
	label: 'migration_registration_enqueuer:booking',
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

// M10 / A7.5 — channel broadcast on booking INSERT. Fans out к per-channel
// dispatch row через orchestrateAriBroadcast (D16-D20 RU compliance gates).
// Skipped channels logged INFO с audit reason. Migration 0059 ALTER TOPIC adds
// consumer.
const channelBroadcastConsumer = startCdcConsumer(driver, sql, {
	topic: 'booking/booking_events',
	consumer: 'channel_broadcast_writer',
	projection: createChannelBroadcastHandler({
		connectionRepo: channelFactory.connectionRepo,
		dispatchRepo: channelFactory.dispatchRepo,
	}),
	label: 'channel_broadcast:booking',
})

// G10 (2026-05-16) — SSE booking event dispatcher.
// CDC consumer reads booking_events топик и публикует в in-memory
// broadcaster, который держит subscriber registry + 60s ring buffer per
// propertyId. SSE route subscribes per-client → live fan-out + Last-Event-
// ID replay. Single-instance only (multi-replica нужен per-instance
// consumer-name или shared bus per `[[no-half-measures]]` deferred).
const bookingEventBroadcaster = createBookingEventBroadcaster()
const sseBookingConsumer = startCdcConsumer(driver, sql, {
	topic: 'booking/booking_events',
	consumer: 'sse_booking_writer',
	projection: createBookingSseCdcHandler(bookingEventBroadcaster),
	label: 'sse:booking',
})

// Variant 3 «absolute strongest» overbooking-prevention (2026-05-18) —
// reconciles `roomTypeNightSlot` rows для booking INSERTs that bypassed
// `booking.repo.create` (seed scripts, future channel-push handlers, raw
// UPSERT). Within seconds of bypass-write, slot rows materialize и DB-level
// PK invariant activates. Per migration 0064.
const slotReconciliationConsumer = startCdcConsumer(driver, sql, {
	topic: 'booking/booking_events',
	consumer: 'slot_reconciliation_writer',
	projection: createSlotReconciliationHandler(logger),
	label: 'slot_reconciliation:booking',
})

// Sprint C+ 5-expert audit fix 2026-05-23d (YDB P0 + Senior P1-1):
// Migration 0069 reserved `passportScanAuditProjector` consumer on TWO topics
// (photoConsentLog + passportOcrAudit changefeeds) WITHOUT a worker. With Tier-A
// retention PT24H (Serverless empirical canon, 0014a), unread events expire
// after 24h → first worker deploy replays nothing = silent CDC data loss.
// Minimal projector below consumes both topics, advances offsets, emits a
// structured `passport_scan_audit_changefeed` log per event so Roskomnadzor
// inspection can prove the audit feed is being projected (152-ФЗ ст.21 ч.4).
// M11+ will swap projection to write append-only `passportOcrAuditScrubLog`
// event table for separation between mutable consent table and immutable journal.
const passportConsentAuditProjector = startCdcConsumer(driver, sql, {
	topic: 'photoConsentLog/photoConsentLogChanges',
	consumer: 'passportScanAuditProjector',
	projection: createPassportScanAuditProjectorHandler('photoConsentLog', logger),
	label: 'passport_scan_audit:consent',
})
const passportOcrAuditProjector = startCdcConsumer(driver, sql, {
	topic: 'passportOcrAudit/passportOcrAuditChanges',
	consumer: 'passportScanAuditProjector',
	projection: createPassportScanAuditProjectorHandler('passportOcrAudit', logger),
	label: 'passport_scan_audit:ocr',
})

// Night-audit cron — posts per-night accommodation lines on `in_house`
// bookings at 03:00 Europe/Moscow. Boot catch-up handles restart-during-window
// gaps. Idempotent via deterministic folioLine.id (PK collision = no-op).
// Tests bypass via NODE_ENV=test (integration calls runNightAudit directly).
const nightAuditCron = process.env.NODE_ENV === 'test' ? null : startNightAuditCron(sql, logger, {})

// Demo refresh cron (M8.A.demo.runtime) — restores «Гостиница Сириус» demo
// tenant к canonical golden state every 6h. Disabled в test (script run
// directly через `pnpm seed:demo` для integration tests). Per
// project_demo_strategy.md (always-on demo product surface 2026-04-28).
const demoRefreshCron =
	process.env.NODE_ENV === 'test' ? null : startDemoRefreshCron(sql, logger, {})

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
	migrationRegistrationEnqueuerConsumer,
	migrationRegistrationActivityConsumer,
	channelDispatchActivityConsumer,
	channelInboxActivityConsumer,
	tourismTaxConsumer,
	cancelFeeConsumer,
	channelBroadcastConsumer,
	sseBookingConsumer,
	slotReconciliationConsumer,
	passportConsentAuditProjector,
	passportOcrAuditProjector,
] as const

/**
 * Graceful shutdown — drains in-flight CDC consumers so activity INSERTs
 * commit cleanly and the topic cursor advances before the process exits
 * (no message replay on restart). Exported for smoke/E2E harnesses AND
 * the production entrypoint (`index.ts main()`), which is the SINGLE owner
 * of SIGTERM/SIGINT handlers. Module import is side-effect-free — registering
 * signal handlers here previously raced с `index.ts` `shutdown()` (fire-and-
 * forget vs await), corrupting in-flight CDC writes during k8s drain.
 *
 * Drain order matters: SSE shutdown event FIRST (clients begin reconnecting
 * к other replicas), then CDC consumers, then crons / dispatchers. YDB driver
 * close is the caller's responsibility — it must happen AFTER stopApp() так
 * the consumers can finalize their writes.
 */
export async function stopApp(): Promise<void> {
	// G10 (2026-05-16) graceful shutdown canon (R2 ≥ 2026-05-16 + sse-starlette
	// v3.4.4 + OneUptime 2026): emit `event: shutdown` к ALL active SSE
	// subscribers BEFORE we tear down the broadcaster. Client reconnects
	// after `reconnectInMs` к the new replica. Synchronous publish → completes
	// within K8s `terminationGracePeriodSeconds` budget.
	const activeSubs = bookingEventBroadcaster.totalSubscriberCount()
	if (activeSubs > 0) {
		logger.info({ activeSubs }, 'shutdown: broadcasting SSE shutdown к active subscribers')
		broadcastShutdown(bookingEventBroadcaster)
	}
	logger.info({ count: allCdcConsumers.length }, 'shutdown: stopping CDC consumers + YDB driver')
	await Promise.all(allCdcConsumers.map((c) => c.stop()))
	if (nightAuditCron) await nightAuditCron.stop()
	if (demoRefreshCron) await demoRefreshCron.stop()
	if (notificationDispatcher) await notificationDispatcher.stop()
	if (notificationCron) await notificationCron.stop()
	await channelFactory.stopDispatcher()
}

// Round 7 v3 2026-05-25 — CORS resolver moved к ./cors.ts для pure-function
// isolation. cors.test.ts imports от cors.ts напрямую → не triggerит CDC
// consumer side-effects во время parallel bun test. Was causing test-fast
// cube fail в Run #97 + #98.
import { resolveCorsOrigin } from './cors.ts'

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

// Sprint B 2026-05-22 — native Hono security headers (Strict-Transport-Security,
// X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy).
// Defaults are sane для backend API: blocks framing, content-type sniffing, MITM.
// Не включаем CSP (не serve HTML — frontend has own CSP in index.html).
app.use(
	'*',
	secureHeaders({
		// HSTS — force HTTPS на год; в dev без HTTPS browser ignores но header
		// безвредный. Production behind YC ALB сразу включает.
		strictTransportSecurity: 'max-age=31536000; includeSubDomains',
		// X-Frame-Options: DENY — backend API не должен embed в iframe (clickjacking).
		xFrameOptions: 'DENY',
		// MIME-sniffing — отключаем (defense-in-depth дополнительно к magic-byte).
		xContentTypeOptions: 'nosniff',
		// Referrer: strict-origin-when-cross-origin (canon 2026 web baseline).
		referrerPolicy: 'strict-origin-when-cross-origin',
		// CSP не задаём — это API не HTML, frontend имеет свой CSP в index.html.
	}),
)

// Sprint C+1 Round 2 self-review batch 7 (bodyLimit full sweep):
// global defense-in-depth bodyLimit 16MB на ALL routes BEFORE per-route
// overrides. 16MB > max per-route (vision 8MB) — global cannot reject
// images that per-route would accept. Per-route caps still apply (vision
// 8MB, booking 512KB, guest 256KB, identity 4KB, compliance 16KB) и
// run later в chain → stricter limit wins.
//
// Globe cap protects routes БЕЗ explicit per-route bodyLimit от 100MB+
// adversarial JSON-bomb / slow-loris that would crash node before any
// зод validation. Hono bodyLimit reads Content-Length pre-decode → reject
// before alloc.
import { bodyLimit as honoBodyLimit } from 'hono/body-limit'

const GLOBAL_BODY_LIMIT_BYTES = 16 * 1024 * 1024
app.use(
	'*',
	honoBodyLimit({
		maxSize: GLOBAL_BODY_LIMIT_BYTES,
		onError: (c) =>
			c.json(
				{
					error: {
						code: 'PAYLOAD_TOO_LARGE',
						message: `Тело запроса превышает глобальный лимит ${Math.floor(GLOBAL_BODY_LIMIT_BYTES / 1024 / 1024)} МБ`,
					},
				},
				413,
			),
	}),
)

// Round 7 v3 2026-05-25 — CORS resolver imported from ./cors.ts (см. comment
// at top of file). Function-style origin returns matched value or null;
// Hono omits ACAO header entirely для untrusted origins → preflight fails.

app.use(
	'*',
	cors({
		origin: resolveCorsOrigin,
		credentials: true,
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		// `traceparent`/`tracestate` prepare us for OpenTelemetry W3C context propagation;
		// `x-request-id` so frontends can correlate their own UUIDs if they choose.
		allowHeaders: [
			'Content-Type',
			'Authorization',
			'X-Bypass-Token',
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
//
// Sprint C+ Round 6 2026-05-24 — Security red team P0 vector #2:
//   Edge-level rate-limit BEFORE BA handler. Captcha gate (in auth.ts hooks)
//   only fires after BA reaches the endpoint; floods at the URL шарик level
//   bypass captcha pipeline economics. Per-IP throttle drops 100-email-bot
//   tenant-creation attack before Vision/Postbox cost-burn accrues.
//     - POST /api/auth/sign-in/magic-link: 5/10min/IP
//     - POST /api/auth/organization/create: 3/hour/IP
app.use('/api/auth/sign-in/magic-link', magicLinkRateLimit)
app.use('/api/auth/organization/create', orgCreateRateLimit)
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

const otelIngest = createOtelIngest()

// B11 (2026-05-19): cached readiness evaluator — one instance per process,
// 2s TTL + AbortSignal-bounded YDB probe. Survives across requests so k8s/ALB
// probe-storms drop к single YDB roundtrip per cache window. See lib/readiness.ts.
const readinessEvaluator = createReadinessEvaluator({
	appMode: env.APP_MODE,
	permittedMockAdapters: env.APP_MODE_PERMITTED_MOCK_ADAPTERS,
	get adapters() {
		// Live-evaluate adapters list — registry mutates during boot before
		// первый probe arrives; static snapshot would miss late registrations.
		return listAdapters()
	},
	probeYdb: async (signal) => {
		// AbortSignal not directly threaded к porsager-style template tag —
		// race wrapper aborts the await regardless if YDB driver hangs.
		const probe = sql<[{ ok: number }]>`SELECT 1 AS ok`
		const result = await Promise.race([
			probe,
			new Promise<never>((_, reject) => {
				signal.addEventListener(
					'abort',
					() => reject(new Error('readiness: YDB probe aborted by AbortSignal')),
					{ once: true },
				)
			}),
		])
		return result[0]?.[0]?.ok === 1
	},
	logger,
})

const routes = app
	.route('/api/otel', otelIngest)
	// M9.widget.7 / A5.2 — RUM ingest. Public, anonymous, CORS *. Mounted
	// BEFORE auth middleware so embedded widgets can POST without credentials.
	.route('/api/rum', createRumRoutes({ buffer: rumBuffer }))
	// PUBLIC widget read surface — NO auth middleware, slug-resolved tenant.
	// Mounted FIRST в chain so anonymous clients get clean 200/404 ответы
	// без 401 от authMiddleware.
	.route('/api/public/widget', createWidgetRoutes(widgetFactory.service))
	// M9.widget.4 — public booking commit (POST /:slug/booking)
	.route(
		'/api/public/widget',
		createWidgetBookingCreateRoutes({
			service: widgetBookingCreateFactory.service,
			idempotency,
		}),
	)
	// M9.widget.5 / A3.1.b — magic-link two-step consume:
	//   GET  /api/public/booking/jwt/:jwt/render  — verify + JSON, no consume
	//   POST /api/public/booking/jwt/:jwt/consume — atomic consume + Set-Cookie
	// Apple MPP / Slack unfurl prefetch DoS защита через split GET (read-only)
	// vs POST (mutating).
	.route(
		'/api/public',
		createMagicLinkConsumeRoutes({
			magicLinkService: magicLinkFactory.service,
			resolveCookieSecret: (tenantId) => magicLinkSecretResolver.resolve(tenantId),
		}),
	)
	// M9.widget.5 / A3.1.c — booking-find (POST «найти бронь по ref+email»):
	// timing-safe Promise.allSettled padding 800ms + tuple-key (email, ref)
	// rate-limit 5/15min + always 200 OK unified body. On match: issues
	// view-scope JWT + writes notificationOutbox row (existing dispatcher
	// CDC consumer sends email).
	.route(
		'/api/public/widget',
		createBookingFindRoutes({
			magicLinkService: magicLinkFactory.service,
			repo: createBookingFindRepo(sql),
		}),
	)
	// M9.widget.6 / А4.4 — iframe fallback HTML wrapper. MOUNTED FIRST так
	// чтобы более-общий `:tenantSlug/:propertyId/:hashfile` pattern в
	// `embed.routes` не съел `/iframe/<slug>/<prop>.html` URL'ы.
	//   GET /api/embed/v1/iframe/:tenantSlug/:propertyId.html
	// Per-tenant CSP frame-ancestors from publicEmbedDomains (D11) +
	// COOP same-origin-allow-popups (D34) + Permissions-Policy minimal-trust.
	.route('/api/embed', createIframeHtmlRoutes({ service: embedFactory.service }))
	// M10 / A7.1.fix — public inbound channel webhooks. NO auth — sender is
	// the channel itself (TL/YT/ETG). Raw body bytes verified via Standard
	// Webhooks signature (multi-key kid rotation) OR IP-allowlist fallback
	// (ЮKassa-style channels). Idempotent receive via channelInbox UNIQUE
	// (source, eventId).
	.route('/api/channel/webhooks', channelFactory.webhookRoutes)
	// M9.widget.6 / А4.3.b — embed widget bundle delivery + clientCommitToken
	// + admin kill-switch. 4 routes per plan §A4.3:
	//   GET  /api/embed/v1/:tenantSlug/:propertyId/:hash.js     facade
	//   GET  /api/embed/v1/_chunk/booking-flow/:hash.js         lazy chunk
	//   POST /api/embed/v1/:tenantSlug/:propertyId/commit-token HMAC sign
	//   POST /api/embed/v1/_kill                                admin revoke
	// Path-segment `:hash` validates against bundle SHA-384 (D23).
	.route('/api/embed', createEmbedRoutes({ service: embedFactory.service }))
	// M9.widget.5 / A3.3 — guest portal: GET view + POST cancel routes.
	// Cookie-auth via __Host-guest_session (set by /consume route at A3.1.b).
	// Cancel route enforces ПП РФ № 1912 п. 16 boundary canon (pre_checkin →
	// 100% refund; day_of_or_later → max 1-night charge).
	.route(
		'/api/public',
		createGuestPortalRoutes({
			repo: createGuestPortalRepo(sql),
			bookingService: bookingFactory.service,
			resolveCookieSecret: (tenantId) => magicLinkSecretResolver.resolve(tenantId),
		}),
	)
	.route('/api/v1/properties', createPropertyRoutes(propertyFactory))
	.route('/api/v1', createPropertyContentRoutes(propertyContentFactory, idempotency))
	.route('/api/v1', createTenantComplianceRoutes(tenantComplianceFactory, idempotency))
	.route('/api/v1', createRoomTypeRoutes(roomTypeFactory))
	.route('/api/v1', createRoomRoutes(roomFactory))
	.route('/api/v1', createRatePlanRoutes(ratePlanFactory))
	.route('/api/v1', createRateRoutes(rateFactory))
	.route('/api/v1', createAvailabilityRoutes(availabilityFactory))
	.route('/api/v1', createBookingRoutes(bookingFactory, idempotency))
	.route(
		'/api/v1',
		createPropertyBlockRoutes(
			propertyBlockFactory,
			bookingFactory.repo,
			roomFactory.service,
			idempotency,
		),
	)
	// G10 (2026-05-16) — SSE real-time для chessboard. EventSource subscribes
	// per propertyId; CDC consumer fans booking events out via broadcaster.
	.route('/api/v1', createSseRoutes(bookingEventBroadcaster, propertyFactory.service))
	.route('/api/v1', createActivityRoutes(activityFactory))
	.route('/api/v1', createGuestRoutes(guestFactory, idempotency))
	// Sprint C+ Senior P0-1 fix 2026-05-23d: from-scan endpoint that INSERTs
	// guestDocument после operator confirms entities в UI. Closes dead-code
	// gap exposed by 5-expert audit — previously RTBF cascade + DSAR list
	// had no rows. Endpoint receives photoConsentLogId from preceding scan
	// response and links the new row, so cascade can actually scrub.
	.route(
		'/api/v1',
		createGuestDocumentRoutes({
			guestRepo: guestFactory.repo,
			documentRepo: guestFactory.documentRepo,
		}),
	)
	.route(
		'/api/v1',
		createMeRoutes((tenantId) => loadTenantMode(sql, tenantId)),
	)
	.route('/api/v1', createFolioRoutes(folioFactory, idempotency))
	.route('/api/v1', createPaymentRoutes(paymentFactory, idempotency))
	// P1 (2026-05-18) — public webhook endpoint для ЮKassa (IP allowlist gate,
	// NO HMAC per canon 2026-05-19). NO auth/tenant middleware — webhook handler
	// derives tenantId from cross-tenant `findTenantByProviderPaymentId` lookup.
	.route(
		'/api/v1/payments/webhook',
		createPaymentWebhookRoutes({
			yookassaProvider: paymentProvider,
			paymentRepo: paymentFactory.repo,
			paymentService: paymentFactory.service,
			webhookEventRepo: paymentWebhookEventRepo,
			logger,
			trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS,
		}),
	)
	.route('/api/v1', createRefundRoutes(refundFactory, idempotency))
	.route('/api/v1', createMigrationRegistrationRoutes(migrationRegistrationFactory, idempotency))
	.route(
		'/api/v1',
		createVisionRoutes({
			visionAdapter: visionOcrAdapter,
			rklAdapter,
			idempotency,
			guestRepo: guestFactory.repo,
			photoStorage: passportPhotoStorage,
			passportScanFactory, // Sprint C: factory encapsulates sql + atomic consent+audit writes
		}),
	)
	// Sprint C: RTBF endpoint — 152-ФЗ ст.20 (право отзыва) + ст.21 ч.5
	// (30 дней на уничтожение). Our endpoint destroys immediately << SLA.
	// Self-review I4 fix: idempotency middleware added — double-click revoke
	// dedupes на backend per Stripe canon (avoid second cascade running).
	.route(
		'/api/v1',
		createConsentRevokeRoutes({
			passportScanFactory,
			photoStorage: passportPhotoStorage,
			idempotency,
		}),
	)
	// Sprint C: DSAR endpoint — 152-ФЗ ст.14 (30 рабочих дней)
	.route(
		'/api/v1',
		createPassportDataExportRoutes({ passportScanFactory, guestRepo: guestFactory.repo }),
	)
	.route('/api/v1', createIdentityRoutes(dadata.adapter))
	.route('/api/v1', createOnboardingRoutes(onboardingFactory, idempotency))
	// Sprint C+ Senior P1-6 fix 2026-05-23d: ops-metrics drain endpoint
	// (Prometheus-style). Token-gated via INTERNAL_OPS_TOKEN.
	.route('/api', createOpsMetricsRoutes({ internalToken: env.INTERNAL_OPS_TOKEN }))
	// Demo inbox public route. Always mounted at the public path, but the
	// handler itself рассматривает `env.DEMO_DEPLOYMENT` — when false, returns
	// 404 (route literally has no inbox to surface). Belt-and-braces поверх
	// the email-factory env-gating per [[demo_strategy]]: production deployments
	// can't accidentally leak captures because the singleton is never created.
	.use('/api/public/demo/*', demoInboxRateLimiter)
	.route('/api/public/demo', createDemoInboxRoutes({ enabled: env.DEMO_DEPLOYMENT }))
	.route('/api/public/demo', createDemoSmsInboxRoutes({ enabled: env.DEMO_DEPLOYMENT }))
	.route('/api/admin', createAdminTaxRoutes(bookingFactory))
	.route('/api/admin', createAdminNotificationsRoutes(notificationFactory.service))
	// M10 / A7.5.fix — admin channel-status overlay backing endpoint.
	// GET /api/admin/channels — list channelConnection rows для current tenant.
	.route('/api/admin', createAdminChannelRoutes(channelFactory))
	.get('/health', (c) =>
		// `service: 'sochi-horeca'` = canonical marker per
		// `feedback_no_disrupt_other_dev.md` + symmetric boundary с stankoff-v2
		// (`project_inter_project_port_allocation.md`). Test harnesses + cross-
		// project tooling verify this marker before reusing port — protects от
		// accidentally hitting другой dev server на shared host.
		//
		// `commit` поле (опциональное, env-driven) — позволяет cross-project
		// agents distinguish running revision без git. Source: `GIT_COMMIT_SHA`
		// env var (set by deploy pipeline / CI; locally undefined = dev build).
		c.json(
			{
				status: 'ok' as const,
				service: 'sochi-horeca' as const,
				project: 'horeca-backend',
				version: '0.0.1',
				commit: process.env.GIT_COMMIT_SHA ?? 'dev',
				time: new Date().toISOString(),
			},
			200,
		),
	)
	// B5 (2026-05-19): Bun production canon (Q2 2026) — liveness vs readiness
	// split per Kubernetes / Yandex Cloud ALB health-check contract:
	//
	//   /health/live  — process pulse. ALB liveness probe binds here. Returns
	//                   200 unconditionally если process is reachable. Fail =
	//                   process restart (not just traffic-drain).
	//   /health/ready — readiness probe. ALB traffic-routing binds here. 200
	//                   only когда YDB reachable + all registered adapters
	//                   are в expected state (per APP_MODE). 503 = drain.
	//
	// Legacy /health (above) retained для backwards compat (canon marker check
	// per `feedback_no_disrupt_other_dev`). /health/db + /health/adapters
	// remain как deep-diagnostic sub-endpoints.
	.get('/health/live', (c) =>
		c.json(
			{
				status: 'ok' as const,
				time: new Date().toISOString(),
			},
			200,
		),
	)
	.get('/health/ready', async (c) => {
		// Composite readiness via cached evaluator (see lib/readiness.ts).
		// Public payload contract pinned by lib/readiness.test.ts. Cache TTL +
		// AbortSignal timeout protect YDB от probe-storm and probe-hang both.
		const result = await readinessEvaluator()
		return c.json(
			{
				status: result.status,
				checks: result.checks,
				time: new Date().toISOString(),
			},
			result.statusCode,
		)
	})
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
