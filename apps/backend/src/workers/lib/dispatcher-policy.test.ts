/**
 * Strict unit tests for dispatcher retry policy.
 *
 * Coverage targets:
 *   - exponential growth boundary: base × 2^(retryCount-1)
 *   - jitter range: ±20% applied AFTER cap
 *   - cap clamping: large retryCount doesn't blow past cap × 1.2
 *   - shouldDeadLetter at boundary
 *   - input validation: rejects negative / fractional retryCount
 */
import { describe, expect, test } from 'vitest'
import {
	buildPendingPredicate,
	computeNextAttemptAt,
	DEFAULT_RETRY_POLICY,
	type RetryPolicy,
	shouldDeadLetter,
} from './dispatcher-policy.ts'

const fixedRandom = (v: number) => () => v
const noJitterRandom = fixedRandom(0.5) // (0.5 * 2 - 1) = 0 jitter

describe('computeNextAttemptAt — exponential growth (no jitter)', () => {
	const now = new Date('2026-04-26T12:00:00Z')

	test('retryCount=1 → base × 1 (= 30s)', () => {
		const next = computeNextAttemptAt(1, now, noJitterRandom)
		expect(next.getTime() - now.getTime()).toBe(30_000)
	})

	test('retryCount=2 → base × 2 (= 60s)', () => {
		const next = computeNextAttemptAt(2, now, noJitterRandom)
		expect(next.getTime() - now.getTime()).toBe(60_000)
	})

	test('retryCount=3 → base × 4 (= 120s)', () => {
		const next = computeNextAttemptAt(3, now, noJitterRandom)
		expect(next.getTime() - now.getTime()).toBe(120_000)
	})

	test('retryCount=8 → base × 128 = 3840s but capped at 3600s', () => {
		const next = computeNextAttemptAt(8, now, noJitterRandom)
		expect(next.getTime() - now.getTime()).toBe(3_600_000) // capped
	})

	test('retryCount=20 (extreme) → still capped at 3600s', () => {
		const next = computeNextAttemptAt(20, now, noJitterRandom)
		expect(next.getTime() - now.getTime()).toBe(3_600_000)
	})
})

describe('computeNextAttemptAt — jitter envelope', () => {
	const now = new Date('2026-04-26T12:00:00Z')

	test('random=0 → -20% jitter (lowest)', () => {
		// (0 * 2 - 1) = -1 → -20% of capped.
		// retryCount=2 → capped=60, jitter = -12s, delay = 48s.
		const next = computeNextAttemptAt(2, now, fixedRandom(0))
		expect(next.getTime() - now.getTime()).toBe(48_000)
	})

	test('random→1 (.99999) → +20% jitter (highest)', () => {
		// (0.99999 * 2 - 1) ≈ 0.99998 → ≈+20%. retryCount=2 → ≈72s.
		const next = computeNextAttemptAt(2, now, fixedRandom(0.99999))
		const delay = next.getTime() - now.getTime()
		expect(delay).toBeGreaterThan(71_000)
		expect(delay).toBeLessThanOrEqual(72_000)
	})

	test('jitter NEVER pushes below 0 (positive delays only)', () => {
		// Even at retryCount=1 with random=0, jitter = -20% × 30s = -6s, total 24s > 0.
		const now = new Date('2026-04-26T12:00:00Z')
		const next = computeNextAttemptAt(1, now, fixedRandom(0))
		expect(next.getTime() - now.getTime()).toBeGreaterThan(0)
	})
})

describe('computeNextAttemptAt — input validation', () => {
	const now = new Date()

	test('rejects retryCount=0 (must be positive — 0 means no attempt yet)', () => {
		expect(() => computeNextAttemptAt(0, now)).toThrow(RangeError)
	})

	test('rejects negative retryCount', () => {
		expect(() => computeNextAttemptAt(-1, now)).toThrow(RangeError)
	})

	test('rejects fractional retryCount', () => {
		expect(() => computeNextAttemptAt(2.5, now)).toThrow(RangeError)
	})
})

describe('computeNextAttemptAt — custom policy', () => {
	const now = new Date('2026-04-26T12:00:00Z')

	test('shorter base + smaller cap (ops-tunable)', () => {
		const policy: RetryPolicy = { baseSeconds: 5, capSeconds: 30, maxRetries: 3 }
		// retryCount=2 → 5 × 2 = 10s, no cap. No jitter.
		const next = computeNextAttemptAt(2, now, noJitterRandom, policy)
		expect(next.getTime() - now.getTime()).toBe(10_000)
	})

	test('cap kicks in earlier with smaller policy', () => {
		const policy: RetryPolicy = { baseSeconds: 5, capSeconds: 30, maxRetries: 10 }
		// retryCount=4 → 5 × 8 = 40s, but capped at 30.
		const next = computeNextAttemptAt(4, now, noJitterRandom, policy)
		expect(next.getTime() - now.getTime()).toBe(30_000)
	})
})

describe('shouldDeadLetter', () => {
	test('retryCount < maxRetries → false (still has budget)', () => {
		expect(shouldDeadLetter(0)).toBe(false)
		expect(shouldDeadLetter(7)).toBe(false)
	})

	test('retryCount === maxRetries → true (exhausted)', () => {
		expect(shouldDeadLetter(8)).toBe(true)
	})

	test('retryCount > maxRetries → true (defensive)', () => {
		expect(shouldDeadLetter(99)).toBe(true)
	})

	test('rejects negative retryCount', () => {
		expect(() => shouldDeadLetter(-1)).toThrow(RangeError)
	})

	test('rejects fractional retryCount', () => {
		expect(() => shouldDeadLetter(1.5)).toThrow(RangeError)
	})

	test('custom policy maxRetries=3', () => {
		const policy: RetryPolicy = { baseSeconds: 5, capSeconds: 30, maxRetries: 3 }
		expect(shouldDeadLetter(2, policy)).toBe(false)
		expect(shouldDeadLetter(3, policy)).toBe(true)
	})
})

describe('buildPendingPredicate', () => {
	test('returns shape with status + retry cap + time horizon', () => {
		const now = new Date('2026-04-26T12:00:00Z')
		const p = buildPendingPredicate(now)
		expect(p).toEqual({
			status: 'pending',
			retryCountLt: DEFAULT_RETRY_POLICY.maxRetries,
			nextAttemptAtLte: now,
		})
	})

	test('honours custom policy maxRetries', () => {
		const now = new Date('2026-04-26T12:00:00Z')
		const policy: RetryPolicy = { baseSeconds: 5, capSeconds: 30, maxRetries: 3 }
		const p = buildPendingPredicate(now, policy)
		expect(p.retryCountLt).toBe(3)
	})
})
