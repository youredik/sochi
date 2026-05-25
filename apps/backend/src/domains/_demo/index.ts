/**
 * Round 9 demo OTA mock-server entry point.
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md`.
 *
 * **Strict isolation contract** (enforced by `.dependency-cruiser.mjs`):
 *   - This module imports from production (`channel/`, `booking/`, `lib/`)
 *   - Production code **MUST NOT** import from this `_demo/` folder
 *   - The boundary is one-way; lint-enforced, not discipline-only
 *
 * **Env-gate**: routes mounted only when `APP_MODE !== 'production'`. In prod-mode
 * the entire `_demo/` tree is unreachable (defense-in-depth: env-gate + reserved-
 * test-data shield + 24h native YDB TTL on `mockOta_*` tables).
 *
 * **Webhook loop**: mock servers fire CloudEvents webhooks to OUR OWN backend
 * (`POST /api/channel/webhooks/{channel}`) — closes the integration loop with
 * Round 8 production-tested webhook handlers. This is intentional: demo IS
 * integration test that the wow-effect.
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { createDemoAdminRoutes } from './admin/admin.routes.ts'
import { createOstrovokMockOtaRoutes } from './mock-ota-server/ostrovok/ostrovok.routes.ts'
import { createYandexMockOtaRoutes } from './mock-ota-server/yandex/yandex.routes.ts'

/**
 * Options passed by `app.ts` when calling `registerDemoRoutes`. The host
 * provides per-deploy tenant + property + webhook target/secret bindings
 * pulled from env / Lockbox / DI container.
 */
export interface RegisterDemoRoutesOptions {
	readonly tenantId: string
	readonly yandexPropertyId: string
	readonly ostrovokPropertyId: string
	readonly webhookTargetBaseUrl: string
	readonly webhookSecret: string
}

/**
 * Register Round 9 demo OTA routes onto an existing Hono app.
 * Called conditionally from `app.ts` based on `APP_MODE` env.
 *
 * Mounts three sub-routers:
 *   - `/api/_mock-ota/yandex/v1/*`   — Yandex.Путешествия mock OTA
 *   - `/api/_mock-ota/ostrovok/v1/*` — Островок mock OTA
 *   - `/api/_mock-ota/admin/*`       — reset / seed / trigger controls
 *
 * Each call constructs fresh router instances; the routers carry no shared
 * mutable state (state lives в module-scope `state.ts` files which the
 * `_demo/admin/reset` endpoint clears at presenter command).
 *
 * Returns synchronously — Phase-1 mounting uses in-memory state modules. Phase-2
 * will move to YDB-bound impls but the mount itself remains sync; YDB schema
 * provisioning happens out-of-band via migration runner.
 */
export function registerDemoRoutes(app: Hono<AppEnv>, opts: RegisterDemoRoutesOptions): void {
	const yandexRouter = createYandexMockOtaRoutes({
		tenantId: opts.tenantId,
		propertyId: opts.yandexPropertyId,
		webhookTargetUrl: `${opts.webhookTargetBaseUrl}/api/channel/webhooks/YT`,
		webhookSecret: opts.webhookSecret,
	})
	const ostrovokRouter = createOstrovokMockOtaRoutes({
		tenantId: opts.tenantId,
		propertyId: opts.ostrovokPropertyId,
		webhookTargetUrl: `${opts.webhookTargetBaseUrl}/api/channel/webhooks/ETG`,
		webhookSecret: opts.webhookSecret,
	})
	const adminRouter = createDemoAdminRoutes()

	app.route('/api/_mock-ota/yandex/v1', yandexRouter)
	app.route('/api/_mock-ota/ostrovok/v1', ostrovokRouter)
	app.route('/api/_mock-ota/admin', adminRouter)
}
