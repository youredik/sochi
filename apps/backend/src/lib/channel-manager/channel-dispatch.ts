/**
 * Channel dispatch retry SM — M10 / A7.1 / D14.
 *
 * Per `plans/m10_canonical.md` §2 D14 (post-audit Hookdeck 2026 tiered canon):
 *   Schedule: 100ms → 500ms → 1m → 5m → 15m → 30m → 1h × 5-10 → hourly to 72h → DLQ.
 *
 * NOT exponential pure (Cloudbeds 5×1min was rejected post-audit too aggressive).
 * NOT Apaleo «1 min × forever» (unbounded blast radius rejected).
 *
 * **Per-(tenantId, channelId) circuit breaker** auto-disables after 7 days
 * sustained failure (Apaleo precedent retained from R3e).
 *
 * This module is pure: schedule computation + state-transition functions.
 * DB I/O happens в repository layer (build later in A7.5 sync orchestrator).
 */

// `DispatchStatus` literal union — мirror of channelDispatch.status enum.
// Used by repo layer in A7.5 sync orchestrator + admin overlay UI.
export type DispatchStatus = 'pending' | 'sent' | 'dlq' | 'disabled'

/**
 * Hookdeck 2026 tiered retry schedule (in ms-from-first-attempt).
 *
 * Total budget: ~30 retries spanning ~72h.
 *
 * After exhausting → status='dlq'. Forensic admin replay possible.
 */
const RETRY_SCHEDULE_MS: ReadonlyArray<number> = [
	100, // attempt 2 (after 100ms)
	500, // attempt 3 (after 500ms)
	60_000, // 1m
	5 * 60_000, // 5m
	15 * 60_000, // 15m
	30 * 60_000, // 30m
	60 * 60_000, // 1h × 5-10
	2 * 60 * 60_000,
	3 * 60 * 60_000,
	4 * 60 * 60_000,
	5 * 60 * 60_000,
	6 * 60 * 60_000,
	8 * 60 * 60_000,
	10 * 60 * 60_000,
	12 * 60 * 60_000,
	24 * 60 * 60_000,
	36 * 60 * 60_000,
	48 * 60 * 60_000,
	60 * 60 * 60_000,
	72 * 60 * 60_000,
] as const

export const DISPATCH_MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1 // ~21 attempts

/**
 * Compute next attempt time from current attempt count + first-attempt time.
 *
 * @param attemptCount — 1-based; first attempt = 1, etc.
 * @param firstAttemptAtMs — wall-clock ms epoch of attempt #1
 * @returns absolute UTC ms epoch for next attempt OR null если budget exhausted (→ DLQ)
 */
export function computeNextAttemptAt(input: {
	attemptCount: number
	firstAttemptAtMs: number
}): number | null {
	if (input.attemptCount < 1) {
		throw new RangeError(`computeNextAttemptAt: attemptCount must be ≥1, got ${input.attemptCount}`)
	}
	if (input.attemptCount >= DISPATCH_MAX_ATTEMPTS) return null
	// Schedule[i] = offset for attempt #(i+2) from first-attempt-time.
	const offset = RETRY_SCHEDULE_MS[input.attemptCount - 1]
	if (offset === undefined) return null
	return input.firstAttemptAtMs + offset
}

/**
 * Determine if HTTP failure is retryable. Aligns с industry canon:
 *   - 4xx (except 408, 429) = NOT retryable (client error — won't get better)
 *   - 408 (timeout) = retryable
 *   - 429 (rate-limited) = retryable
 *   - 5xx = retryable
 *   - Network error (fetch threw, status undefined) = retryable
 *
 * Round 10 P1-C — `errorCategory` semantic override: when adapter signals
 * category explicitly, it overrides HTTP-status-derived decision. Aligns с
 * `feedback_round_10_truthful_post_review_canon_2026_05_25.md` — until Round 10
 * dispatcher only read httpStatus, ignoring the structured category — meaning
 * `consent_missing` (422) and `invalid_payload` (422) got identical retry
 * behavior despite distinct ops-semantics. Now each category routes correctly.
 */
export function isRetryableFailure(input: {
	httpStatus: number | undefined
	errorCategory?: string
}): boolean {
	// Round 10 P1-C — explicit category overrides HTTP-status heuristic.
	if (input.errorCategory !== undefined) {
		switch (input.errorCategory) {
			// Non-retryable categories: client-side problem; retry won't help
			case 'invalid_credentials':
			case 'invalid_payload':
			case 'consent_missing':
			case 'cross_border_blocked':
			case 'reserved_test_range':
			case 'duplicate_idempotency_key':
			case 'not_found':
				return false
			// Retryable categories: transient/server-side
			case 'rate_limited':
			case 'transient':
				return true
			// Unknown — fall through to HTTP heuristic
			case 'unknown':
				break
			default:
				// New uncategorized values — be conservative + retry (caller logs)
				return true
		}
	}
	if (input.httpStatus === undefined) return true // network error
	if (input.httpStatus >= 200 && input.httpStatus < 300) return false // 2xx success
	if (input.httpStatus === 408) return true
	if (input.httpStatus === 429) return true
	if (input.httpStatus >= 400 && input.httpStatus < 500) return false // 4xx client error
	if (input.httpStatus >= 500) return true // 5xx server error
	return true // 1xx/3xx unusual — be conservative + retry
}

/**
 * Per-(tenantId, channelId) circuit breaker state — auto-disable after 7 days
 * sustained failure window (Apaleo precedent).
 *
 * Pure function — caller queries breaker state from DB + applies decision.
 */
export interface CircuitBreakerState {
	readonly firstFailureAtMs: number | null
	readonly consecutiveFailures: number
	readonly lastSuccessAtMs: number | null
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000
const FAILURE_THRESHOLD = 5 // consecutive failures before circuit opens

export function shouldAutoDisable(state: CircuitBreakerState, nowMs: number): boolean {
	if (state.firstFailureAtMs === null) return false
	if (state.consecutiveFailures < FAILURE_THRESHOLD) return false
	const failureWindowMs = nowMs - state.firstFailureAtMs
	return failureWindowMs >= SEVEN_DAYS_MS
}

/**
 * Build deterministic Idempotency-Key per D14.
 * Format: `${tenantId}:${aggregateId}:${cdcVersion}:${channelId}`.
 * Sent в HTTP header AND embedded в payload (TL has no header support).
 */
export function buildIdempotencyKey(input: {
	tenantId: string
	aggregateId: string
	cdcVersion: string | number
	channelId: string
}): string {
	return `${input.tenantId}:${input.aggregateId}:${input.cdcVersion}:${input.channelId}`
}

/** Test-only export for unit assertions on the schedule constant. */
export const __testHooks = {
	RETRY_SCHEDULE_MS,
	FAILURE_THRESHOLD,
	SEVEN_DAYS_MS,
} as const
