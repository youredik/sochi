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
 *
 * **Round 14 self-review #6 (2026-05-27)**: state stores promoted from in-memory
 * Map к YDB-backed primary state (migration 0080). Closes multi-instance state
 * divergence bug empirically caught by Run #112+#114 smoke failures. Mount site
 * now requires `sql` instance to build YDB stores.
 */

import type { Hono } from 'hono'
import type { sql as SQL } from '../../db/index.ts'
import type { AppEnv } from '../../factory.ts'
import { createDemoAdminRoutes } from './admin/admin.routes.ts'
import { createYdbOstrovokStore } from './mock-ota-server/ostrovok/state.ts'
import { createOstrovokMockOtaRoutes } from './mock-ota-server/ostrovok/ostrovok.routes.ts'
import { createYandexMockOtaRoutes } from './mock-ota-server/yandex/yandex.routes.ts'
import { createYdbYandexStore } from './mock-ota-server/yandex/state.ts'

type SqlInstance = typeof SQL

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
	/**
	 * Round 11 P1-B2 — per-process session token gating admin endpoints.
	 * Generated at backend boot + printed to log so presenter copies into
	 * showcase UI. Prevents multi-tenant cross-reset attacks.
	 */
	readonly adminSessionToken?: string
	/**
	 * Round 14 self-review #6 — YDB sql instance for primary-state stores.
	 * Without sql, mount falls back к in-memory stores (NOT cross-instance
	 * coherent — local dev only).
	 */
	readonly sql: SqlInstance
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
 * Each call constructs YDB-backed stores (migration 0080) — multi-instance
 * state coherent.
 */
export function registerDemoRoutes(app: Hono<AppEnv>, opts: RegisterDemoRoutesOptions): void {
	const ostrovokStore = createYdbOstrovokStore(opts.sql)
	const yandexStore = createYdbYandexStore(opts.sql)

	const yandexRouter = createYandexMockOtaRoutes({
		tenantId: opts.tenantId,
		propertyId: opts.yandexPropertyId,
		webhookTargetUrl: `${opts.webhookTargetBaseUrl}/api/channel/webhooks/YT`,
		webhookSecret: opts.webhookSecret,
		store: yandexStore,
	})
	const ostrovokRouter = createOstrovokMockOtaRoutes({
		tenantId: opts.tenantId,
		propertyId: opts.ostrovokPropertyId,
		webhookTargetUrl: `${opts.webhookTargetBaseUrl}/api/channel/webhooks/ETG`,
		webhookSecret: opts.webhookSecret,
		store: ostrovokStore,
	})
	const adminRouter = createDemoAdminRoutes({
		...(opts.adminSessionToken !== undefined && { sessionToken: opts.adminSessionToken }),
		ostrovokStore,
		yandexStore,
	})

	app.route('/api/_mock-ota/yandex/v1', yandexRouter)
	app.route('/api/_mock-ota/ostrovok/v1', ostrovokRouter)
	app.route('/api/_mock-ota/admin', adminRouter)
}
