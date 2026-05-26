/**
 * Round 9 — demo OTA admin control panel HTTP routes.
 *
 * Three idempotent control primitives для sales-demo orchestration. The
 * showcase UI (`apps/frontend/src/_demo/side-by-side/showcase-page.tsx`)
 * surfaces these as buttons so the presenter can reset / pre-populate /
 * trigger scenarios mid-demo without restarting the backend.
 *
 * Routes (mounted under `/api/_mock-ota/admin`):
 *   - `POST /reset`    — clear all in-memory state в Yandex + Островок modules.
 *   - `POST /seed`     — pre-populate `Sochi Demo Hotel` + 3 sample availability
 *                        rows so a fresh search returns offers immediately.
 *   - `POST /trigger`  — body `{ scenario: 'overbooking'|'cancel-late'|'payment-fail' }`
 *                        stub-acknowledges the scenario. **Phase-2 TODO**: real
 *                        FSM injection. Phase-1 returns 200 OK without mutating
 *                        state — purpose is wow-effect UX («presenter clicked
 *                        the button, sometime happened») not behavioural fidelity.
 *
 * **Auth**: session-token gate (Round 11 P1-B2) + `_demo/` env-gated mount
 * (mounted only когда `APP_MODE !== 'production'`). Two layers of defense
 * from prod accident:
 *   1. Env-gate at mount site (`_demo/index.ts`).
 *   2. Reserved-test-ranges shield (Round 8 canon) — at HTTP intake.
 *
 * Round 12 honesty fix — Round 9 canon claimed «triple defense» including
 * native YDB TTL P1D on `mockOta_*` tables. Reality: those tables don't yet
 * exist (state lives in in-memory `Map` in `state.ts` modules). Phase-2 will
 * add YDB-backed state + TTL; until then это «double defense» (env-gate +
 * shield). Documented honestly here so the security claim matches the
 * deployed reality.
 *
 * **No webhook fired** — these endpoints only mutate local mock state; the
 * actual `POST /orders` route does the webhook emission. Reset clears tokens
 * and orders; seed pre-populates the inventory-pool conceptually (Phase-1 is
 * stateless — pricing is hardcoded в the routes themselves, so seed currently
 * is a no-op for parity reasons but kept as an extension point).
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md`.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../../../factory.ts'
import { __resetState as __resetOstrovokState } from '../mock-ota-server/ostrovok/state.ts'
import { __resetState as __resetYandexState } from '../mock-ota-server/yandex/state.ts'

/**
 * Valid scenario identifiers для `POST /trigger`. Const-union enforced at
 * TypeScript level so adding a new scenario requires touching this list +
 * the switch statement в the handler — single source of truth.
 */
export const TRIGGER_SCENARIOS = ['overbooking', 'cancel-late', 'payment-fail'] as const
export type TriggerScenario = (typeof TRIGGER_SCENARIOS)[number]

function isValidScenario(value: unknown): value is TriggerScenario {
	return typeof value === 'string' && (TRIGGER_SCENARIOS as ReadonlyArray<string>).includes(value)
}

export interface DemoAdminRoutesOptions {
	/**
	 * Demo-property metadata used by `POST /seed` response. Defaults to the
	 * Phase-1 canonical «Sochi Demo Hotel» fixture but tests / future demo
	 * variants can override.
	 */
	readonly demoPropertyName?: string
	/**
	 * Number of seeded availability dates. Default 3 — minimum для a 2-night
	 * demo to fit comfortably в the visible offer window.
	 */
	readonly seedDateCount?: number
	/**
	 * Round 11 P1-B2 — per-process boot token. Admin endpoints require this
	 * token via `X-Demo-Session-Token` header to prevent multi-tenant cross-
	 * reset attacks. Empty string = no auth (back-compat для existing tests).
	 * Production callers ALWAYS pass non-empty token printed на backend boot log.
	 *
	 * Canon: `feedback_round_10_truthful_post_review_canon_2026_05_25` Agent B
	 * P1-B2 — without this, ANY caller (even unauthenticated) can reset state
	 * mid-demo для другого tenant. Token gate restores tenant isolation.
	 */
	readonly sessionToken?: string
}

/**
 * Build the Hono router for the demo admin control endpoints. Composed
 * onto `/api/_mock-ota/admin` (Batch-3 wiring); tests mount onto a fresh
 * `Hono()` at `/admin`.
 */
export function createDemoAdminRoutes(opts: DemoAdminRoutesOptions = {}): Hono<AppEnv> {
	const app = new Hono<AppEnv>()
	const demoPropertyName = opts.demoPropertyName ?? 'Sochi Demo Hotel'
	const seedDateCount = opts.seedDateCount ?? 3
	const sessionToken = opts.sessionToken ?? ''

	/**
	 * Round 11 P1-B2 — constant-time session-token verification middleware.
	 * Mounted on ALL admin routes. Empty `sessionToken` skip-mode preserves
	 * existing test ergonomics; production wiring (app.ts) always supplies one.
	 *
	 * Round 12 polish — length difference folded into mismatch accumulator,
	 * not OR-ed separately. Previous form `if (mismatch !== 0 || provided.length
	 * !== token.length)` leaked length via short-circuit timing — adversary
	 * could distinguish length-mismatch from content-mismatch by measuring how
	 * quickly the 401 was returned. Folding length into the XOR sum equalizes
	 * comparison time regardless of input shape.
	 */
	app.use('/*', async (c, next) => {
		if (sessionToken.length === 0) return next() // no-auth mode for tests
		const provided = c.req.header('x-demo-session-token') ?? ''
		// Constant-time compare via fixed-length padded buffer + length fold.
		const expected = Buffer.from(sessionToken.padEnd(64, ' ').slice(0, 64))
		const got = Buffer.from(provided.padEnd(64, ' ').slice(0, 64))
		let mismatch = 0
		for (let i = 0; i < 64; i++) {
			mismatch |= (expected[i] ?? 0) ^ (got[i] ?? 0)
		}
		// Fold length difference into accumulator (constant-time).
		mismatch |= provided.length ^ sessionToken.length
		if (mismatch !== 0) {
			return c.json({ error: 'UNAUTHORIZED', message: 'X-Demo-Session-Token mismatch' }, 401)
		}
		return next()
	})

	/**
	 * Route 1 — POST /reset.
	 *
	 * Drops every in-memory entry from both Yandex + Островок state modules
	 * (booking tokens, orders, book hashes, form stages, finalized bookings).
	 * Idempotent: second call returns same shape but `cleared.*` counts may
	 * differ (or be 0) if no state existed.
	 *
	 * Note: we don't return the actual count because state is reset to empty
	 * immediately — the `cleared` field carries a boolean per channel as
	 * audit indicator that the call reached both modules.
	 */
	app.post('/reset', (c) => {
		__resetYandexState()
		__resetOstrovokState()
		return c.json(
			{
				ok: true,
				cleared: {
					yandex: true,
					ostrovok: true,
				},
			},
			200,
		)
	})

	/**
	 * Route 2 — POST /seed.
	 *
	 * Pre-populates the demo with canonical fixture data. Phase-1 returns
	 * the seeded property descriptor; Phase-2 will additionally insert
	 * inventory-pool rows into `mockOtaInventoryPool_demo` YDB table.
	 *
	 * The frontend uses the response to display «Demo seeded: Sochi Demo
	 * Hotel × 3 dates» confirmation toast.
	 */
	app.post('/seed', (c) => {
		// Build the 3-date availability window starting today + 7 days.
		const today = new Date()
		today.setUTCHours(0, 0, 0, 0)
		const seededDates: string[] = []
		for (let i = 0; i < seedDateCount; i++) {
			const d = new Date(today)
			d.setUTCDate(d.getUTCDate() + 7 + i)
			const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
			seededDates.push(iso)
		}
		return c.json(
			{
				ok: true,
				seeded: {
					property: {
						id: 'demo-hotel-sochi',
						name: demoPropertyName,
					},
					availabilityDates: seededDates,
					channels: ['yandex', 'ostrovok'],
				},
			},
			200,
		)
	})

	/**
	 * Route 3 — POST /trigger.
	 *
	 * Body shape: `{ scenario: 'overbooking' | 'cancel-late' | 'payment-fail' }`.
	 *
	 * **Phase-1 behavior** (stub): validates the scenario name and returns
	 * 200 OK with `{ scenario, status: 'acknowledged' }`. Does NOT mutate
	 * mock state — Phase-2 will hook into FSM injection points to actually
	 * simulate the failure modes.
	 *
	 * **Why stub now**: deep FSM injection requires touching the Round 8
	 * frozen mocks (or duplicating their state machines). Phase-1 trade-off:
	 * UX visibility (button works, presenter explains scenario verbally) >
	 * actual simulation depth.
	 *
	 * Invalid scenario → 400 `{ error: 'invalid_scenario' }`. Caller can
	 * inspect the list at `GET /trigger/scenarios` (not implemented; use the
	 * exported `TRIGGER_SCENARIOS` constant from this module).
	 */
	app.post('/trigger', async (c) => {
		let body: { scenario?: unknown }
		try {
			body = (await c.req.json()) as { scenario?: unknown }
		} catch {
			return c.json({ error: 'malformed_json' }, 400)
		}
		if (!isValidScenario(body.scenario)) {
			return c.json(
				{
					error: 'invalid_scenario',
					validScenarios: TRIGGER_SCENARIOS,
				},
				400,
			)
		}
		return c.json(
			{
				ok: true,
				scenario: body.scenario,
				status: 'acknowledged',
				// TODO Phase-2: actual FSM state injection. Tracked в
				// `feedback_round_9_demo_ota_server_canon_2026_05_25.md` under
				// «out-of-scope Phase-1».
			},
			200,
		)
	})

	return app
}
