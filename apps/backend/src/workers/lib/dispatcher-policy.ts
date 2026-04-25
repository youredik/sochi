/**
 * Pure-lib retry policy for the notification dispatcher (M7.B.2).
 *
 * Per research synthesis 2026-04-26 (DZone, AWS Prescriptive Guidance,
 * npiontko 2025):
 *   - capped exponential backoff: `delay = min(base * 2^retryCount + jitter, cap)`
 *   - base 30s, cap 1h, maxRetries 8 → ~6 hour total window
 *   - jitter: ±20% of delay (avoids thundering-herd on mass 5xx wave)
 *
 * Why pure-lib: math is the only thing the worker needs to test exhaustively.
 * The polling-+-tx-+-send loop is an integration concern; backoff math is
 * adversarially testable (boundary, overflow, etc) without DB / network.
 */

export const DEFAULT_RETRY_BASE_SECONDS = 30
export const DEFAULT_RETRY_CAP_SECONDS = 3_600 // 1 hour
export const DEFAULT_MAX_RETRIES = 8
const JITTER_FRACTION = 0.2 // ±20%

export interface RetryPolicy {
	baseSeconds: number
	capSeconds: number
	maxRetries: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	baseSeconds: DEFAULT_RETRY_BASE_SECONDS,
	capSeconds: DEFAULT_RETRY_CAP_SECONDS,
	maxRetries: DEFAULT_MAX_RETRIES,
}

/**
 * Compute the next attempt time for a transient failure given the current
 * retry count (0-based: retryCount=0 means we just made the FIRST attempt).
 *
 * Returns absolute timestamp (Date) for `nextAttemptAt` column. Worker polls
 * `WHERE pending AND nextAttemptAt <= now()`.
 *
 * @param retryCount  number of attempts already made (≥ 1 — first failed)
 * @param now         current wall-clock instant; injected for deterministic
 *                    testing
 * @param random      [0, 1) source — `Math.random` by default; injected so
 *                    jitter is reproducible in tests
 * @param policy      tunable thresholds (ops dial without code change)
 */
export function computeNextAttemptAt(
	retryCount: number,
	now: Date,
	random: () => number = Math.random,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Date {
	if (!Number.isInteger(retryCount) || retryCount < 1) {
		throw new RangeError(
			`computeNextAttemptAt: retryCount must be positive integer, got ${retryCount}`,
		)
	}
	// `2^(retryCount-1)` — first retry (retryCount=1) waits 1× base, second 2×,
	// then 4×, 8×, ...; capped before jitter so jitter never pushes past cap×1.2.
	const exponent = retryCount - 1
	const exponential = policy.baseSeconds * 2 ** exponent
	const capped = Math.min(exponential, policy.capSeconds)
	// Jitter: ±20%, e.g. capped=300s → delay ∈ [240, 360]. random() ∈ [0,1).
	const jitterRange = capped * JITTER_FRACTION
	const jitter = (random() * 2 - 1) * jitterRange
	const delaySeconds = capped + jitter
	return new Date(now.getTime() + delaySeconds * 1000)
}

/**
 * Decide whether a transient-failure row should be retried or sent to the
 * dead-letter (status='failed').
 *
 * `maxRetries` is the LAST attempt — when retryCount === maxRetries, the
 * worker has spent its budget. Каноническое 8 = ~6h window.
 */
export function shouldDeadLetter(
	retryCount: number,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
	if (!Number.isInteger(retryCount) || retryCount < 0) {
		throw new RangeError(
			`shouldDeadLetter: retryCount must be non-negative integer, got ${retryCount}`,
		)
	}
	return retryCount >= policy.maxRetries
}

/**
 * Build a deterministic poll-fetch SQL fragment selector. Returns the WHERE
 * clause builders for the worker; keeping them pure makes the worker shell
 * easier to test without DB.
 *
 * (Placeholder for future SQL-builder abstraction; currently the worker
 * inlines the WHERE clause, but exposing the predicate as data lets tests
 * cover the policy without touching network/DB.)
 */
export interface PendingPredicate {
	status: 'pending'
	retryCountLt: number
	nextAttemptAtLte: Date
}

export function buildPendingPredicate(
	now: Date,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): PendingPredicate {
	return {
		status: 'pending',
		retryCountLt: policy.maxRetries,
		nextAttemptAtLte: now,
	}
}
