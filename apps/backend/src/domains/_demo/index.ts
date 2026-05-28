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

import { Hono } from 'hono'
import { auth } from '../../auth.ts'
import { type AppEnv, factory } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { demoCaptchaMiddleware } from '../../middleware/demo-captcha.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
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
	/**
	 * Round 14.6 — tenantId no longer wired here. Each request derives
	 * tenantId from Better Auth session via `tenantMiddleware()` mounted
	 * on each demo OTA sub-router. Multi-tenant by design (Stripe 2026 canon).
	 *
	 * Round 14.6.4 — `yandexPropertyId`/`ostrovokPropertyId` removed: routes
	 * now derive propertyId per-tenant via `resolveDemoPropertyId(tenantId)`
	 * (lib/demo-channel-seed.ts). Closes silent identity drift между
	 * channelConnection.propertyId (per-tenant) и mock-adapter state.
	 */
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
	/**
	 * Round 14.6 — anonymous-fallback tenantId for `demo.sepshn.ru` showcase.
	 *
	 * When set: requests без Better Auth session bypass auth + tenant middleware
	 *   and pin to this tenantId. Used для public always-on demo URL where
	 *   guests interact с the OTA façade as anonymous visitors (no signup).
	 *
	 * When undefined: full strict path — auth + tenantMiddleware required;
	 *   anonymous calls return 401. Production `app.sepshn.ru` deploys without
	 *   this option set.
	 *
	 * Empirical rationale: bot-spam shield (Round 14.5 captcha gate) still
	 * applies; auth bypass только impacts session lookup, not POST mutation
	 * defense. Stripe pattern — public demo endpoints use a designated
	 * "demo-tenant" fixture; production endpoints require live auth session.
	 */
	readonly anonymousFallbackTenantId?: string
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
		webhookTargetUrl: `${opts.webhookTargetBaseUrl}/api/channel/webhooks/YT`,
		webhookSecret: opts.webhookSecret,
		store: opts.yandexStore,
	})
	const ostrovokRouter = createOstrovokMockOtaRoutes({
		webhookTargetUrl: `${opts.webhookTargetBaseUrl}/api/channel/webhooks/ETG`,
		webhookSecret: opts.webhookSecret,
		store: opts.ostrovokStore,
	})
	const adminRouter = createDemoAdminRoutes({
		...(opts.adminSessionToken !== undefined && { sessionToken: opts.adminSessionToken }),
		ostrovokStore: opts.ostrovokStore,
		yandexStore: opts.yandexStore,
	})

	// Round 14.6 strategic — per-tenant authenticated demo OTA. Hierarchy:
	//   authOrAnonymous → sets c.var.session + tenantId; anonymous fallback if
	//     `anonymousFallbackTenantId` option supplied (public demo URL).
	//   demoCaptchaMiddleware → bot-shield POST mutations (Round 14.5 retained).
	//   router → reads c.var.tenantId; stores per-method tenant scope.
	//
	// Empirical rationale: demo OTA endpoints serve TWO audiences:
	//   1. `demo.sepshn.ru` (anonymous public showcase) — caller has no session;
	//      fallback to demo-tenant fixture so the always-on URL keeps working.
	//   2. `app.sepshn.ru` (per-tenant production) — caller has Better Auth
	//      session with active organization; tenantId derives from session.
	//
	// Stripe 2026 canon — multi-tenant by design; bot defense layered via
	// auth + captcha + reserved-test-ranges. 28.05.2026 incident (130
	// bookings/час bot spam) closed by captcha gate + (на app.sepshn.ru) auth.
	//
	// Test ergonomics: unit tests mount routers directly via
	// `new Hono().route(path, router)` + inject `tenantId` via test middleware,
	// bypassing this gate. Production path mounts всю стек.
	const fallbackTenantId = opts.anonymousFallbackTenantId
	const strictAuth = authMiddleware()
	const strictTenant = tenantMiddleware()
	const authOrAnonymous = factory.createMiddleware(async (c, next) => {
		// Strict path: no fallback configured → require auth + tenant.
		if (fallbackTenantId === undefined) {
			await strictAuth(c, async () => {
				await strictTenant(c, next)
			})
			return
		}
		// Permissive path: try auth; if no session, pin to fallback.
		const result = await auth.api.getSession({ headers: c.req.raw.headers })
		if (!result) {
			c.set('tenantId', fallbackTenantId)
			await next()
			return
		}
		c.set('user', result.user)
		c.set(
			'session',
			result.session as typeof result.session & { activeOrganizationId: string | null },
		)
		const orgId = result.session.activeOrganizationId
		// Session exists но no active org → fall back (anonymous-equivalent semantics).
		if (!orgId) {
			c.set('tenantId', fallbackTenantId)
			await next()
			return
		}
		// Session + active org → defer к tenantMiddleware membership-role gate
		// (matches strict path). Closes role-escalation gap on authed-but-unmember
		// callers (e.g. lapsed invites).
		await strictTenant(c, next)
	})

	const yandexWrapped = new Hono<AppEnv>()
		.use('/*', authOrAnonymous)
		.use('/*', demoCaptchaMiddleware())
		.route('/', yandexRouter)
	const ostrovokWrapped = new Hono<AppEnv>()
		.use('/*', authOrAnonymous)
		.use('/*', demoCaptchaMiddleware())
		.route('/', ostrovokRouter)
	const adminWrapped = new Hono<AppEnv>().use('/*', authOrAnonymous).route('/', adminRouter)

	app.route('/api/_mock-ota/yandex/v1', yandexWrapped)
	app.route('/api/_mock-ota/ostrovok/v1', ostrovokWrapped)
	app.route('/api/_mock-ota/admin', adminWrapped)
}
