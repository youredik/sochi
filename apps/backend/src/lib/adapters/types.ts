// =============================================================================
// Adapter base types — M8.0 prep
// =============================================================================
//
// Every external integration (payment provider, fiscalization service, ЕПГУ,
// channel manager, OCR, captcha, email, SMS, ...) registers an `AdapterMetadata`
// at startup. The registry powers two things:
//
//   1. `/api/health/adapters` — truthful runtime view of which integration is
//      mock / sandbox / live. Operators use this for go-live verification.
//   2. `assertProductionReady()` — startup gate. When `APP_MODE=production`,
//      we refuse to start if ANY adapter is still in mock mode (unless that
//      specific adapter is whitelisted via `APP_MODE_PERMITTED_MOCK_ADAPTERS`,
//      e.g. ЕПГУ during the multi-week ОВМ МВД agreement onboarding window).
//
// This is THE safety net against the «mock accidentally promoted to prod»
// failure mode. Memory canon: plans/local-complete-system-v2.md §6.
//
// Why three modes (not just mock|live):
//   - `mock`     — our in-process fake (StubPaymentProvider, ЕПГУ stub).
//                  Behaviour-faithful per the «behaviour-faithful mocks»
//                  principle, but no real network calls.
//   - `sandbox`  — real provider's test environment (YooKassa shop_id starting
//                  with `test_`, ЕПГУ SVCDEV, etc.). Real network, no money.
//   - `live`     — real provider's production environment.
//
// Production gate accepts `live` only. `sandbox` adapters in production = fail
// (since «sandbox in prod» is universally a config bug — you'd never charge
// real customers via a test environment intentionally).
//
// =============================================================================

/**
 * Adapter operational mode. Drives the sandbox/production startup gate.
 *
 * - `mock`    — in-process fake. Permitted in dev/staging only (or with
 *               explicit whitelist for transition windows).
 * - `sandbox` — provider's own test environment. Permitted in dev/staging.
 * - `live`    — real production endpoint. Required in `APP_MODE=production`.
 */
export type AdapterMode = 'mock' | 'sandbox' | 'live'

/**
 * High-level domain category. Used for filtering in admin UI and structured
 * health-endpoint responses. Closed enum — extend deliberately.
 */
export type AdapterCategory =
	| 'payment'
	| 'fiscal'
	| 'epgu'
	| 'rkl'
	| 'vision'
	| 'channel'
	| 'captcha'
	| 'email'
	| 'sms'
	| 'maps'
	| 'storage'
	| 'ai'

/**
 * Static metadata registered once at app startup. Mode is fixed at
 * registration time — switching live↔mock at runtime is intentionally
 * unsupported (would defeat the production-gate guarantee).
 */
export interface AdapterMetadata {
	/**
	 * Stable identifier, e.g. `'payment.yookassa'`, `'epgu.scala'`.
	 * Convention: `<category>.<provider>`.
	 */
	readonly name: string
	/** High-level domain category — see {@link AdapterCategory}. */
	readonly category: AdapterCategory
	/** Current operational mode — see {@link AdapterMode}. */
	readonly mode: AdapterMode
	/** Human-readable one-line description for /api/health/adapters output. */
	readonly description: string
	/**
	 * Optional: provider's own version string (e.g. YooKassa API `v3`,
	 * ЕПГУ spec `v1.3`). Surfaced in /api/health/adapters for audit.
	 */
	readonly providerVersion?: string
}
