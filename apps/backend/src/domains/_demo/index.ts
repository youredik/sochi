/**
 * Round 9 demo OTA mock-server entry point.
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md` +
 * `feedback_round_14_self_review_6_rollback_lessons_2026_05_27.md`
 * (Round 14.5 multi-instance state YDB migration re-do).
 *
 * **Strict isolation contract** (enforced by `.dependency-cruiser.mjs`):
 *   - This module imports from production (`channel/`, `booking/`, `lib/`)
 *   - Production code **MUST NOT** import from this `_demo/` folder
 *   - The boundary is one-way; lint-enforced, not discipline-only
 *
 * **Env-gate**: routes mounted only when `APP_MODE !== 'production'`. In prod-mode
 * the entire `_demo/` tree is unreachable (defense-in-depth: env-gate + reserved-
 * test-data shield + 24h native YDB TTL on `mockOta_*` tables — Round 14.5
 * re-do delivered all three).
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
import type { OstrovokStore } from './mock-ota-server/ostrovok/store.ts'
import type { YandexStore } from './mock-ota-server/yandex/store.ts'
import { createYandexMockOtaRoutes } from './mock-ota-server/yandex/yandex.routes.ts'

/**
 * Options passed by `app.ts` when calling `registerDemoRoutes`. The host
 * provides per-deploy tenant + property + webhook target/secret bindings
 * pulled from env / Lockbox / DI container, AND the Store implementations
 * (Round 14.5 — YDB for production multi-instance, in-memory for tests).
 */
export interface RegisterDemoRoutesOptions {
	readonly tenantId: string
	readonly yandexPropertyId: string
	readonly ostrovokPropertyId: string
	readonly webhookTargetBaseUrl: string
	readonly webhookSecret: string
	/**
	 * Ostrovok / ETG state store — production: YDB-backed (multi-instance
	 * coherent); tests / single-instance dev: in-memory. Constructed at
	 * `app.ts` based on `APP_MODE` env.
	 */
	readonly ostrovokStore: OstrovokStore
	/**
	 * Yandex.Путешествия state store — same DI pattern as `ostrovokStore`.
	 */
	readonly yandexStore: YandexStore
	/**
	 * Round 11 P1-B2 — per-process session token gating admin endpoints.
	 * Generated at backend boot + printed to log so presenter copies into
	 * showcase UI. Prevents multi-tenant cross-reset attacks.
	 */
	readonly adminSessionToken?: string
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
 * Each call constructs fresh router instances; mutable state lives entirely
 * inside the injected `ostrovokStore` / `yandexStore` (Round 14.5 — was
 * module-scope `state.ts` `Map<>`s pre-migration). `__reset()` on each
 * store clears all state on admin command.
 */
export function registerDemoRoutes(app: Hono<AppEnv>, opts: RegisterDemoRoutesOptions): void {
	const yandexRouter = createYandexMockOtaRoutes({
		tenantId: opts.tenantId,
		propertyId: opts.yandexPropertyId,
		webhookTargetUrl: `${opts.webhookTargetBaseUrl}/api/channel/webhooks/YT`,
		webhookSecret: opts.webhookSecret,
		store: opts.yandexStore,
	})
	const ostrovokRouter = createOstrovokMockOtaRoutes({
		tenantId: opts.tenantId,
		propertyId: opts.ostrovokPropertyId,
		webhookTargetUrl: `${opts.webhookTargetBaseUrl}/api/channel/webhooks/ETG`,
		webhookSecret: opts.webhookSecret,
		store: opts.ostrovokStore,
	})
	const adminRouter = createDemoAdminRoutes({
		...(opts.adminSessionToken !== undefined && { sessionToken: opts.adminSessionToken }),
		ostrovokStore: opts.ostrovokStore,
		yandexStore: opts.yandexStore,
	})

	app.route('/api/_mock-ota/yandex/v1', yandexRouter)
	app.route('/api/_mock-ota/ostrovok/v1', ostrovokRouter)
	app.route('/api/_mock-ota/admin', adminRouter)
}
