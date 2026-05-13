/**
 * Channel dispatch retry SM — strict tests DISPATCH1-DISPATCH6 (M10 / A7.1 / D14).
 *
 * Per plan §5: «6 DISPATCH tests (Hookdeck tiered schedule / DLQ after budget /
 * per-(tenantId,channelCode) circuit-breaker / Idempotency-Key shape /
 * 4xx no-retry / 5xx retryable)».
 */

import { describe, expect, it } from 'bun:test'
import {
	__testHooks,
	buildIdempotencyKey,
	computeNextAttemptAt,
	DISPATCH_MAX_ATTEMPTS,
	isRetryableFailure,
	shouldAutoDisable,
} from './channel-dispatch.ts'

describe('computeNextAttemptAt — Hookdeck tiered schedule (D14)', () => {
	it('[DISPATCH1] schedule starts с 100ms → 500ms → 1m', () => {
		const t0 = 1_700_000_000_000
		expect(computeNextAttemptAt({ attemptCount: 1, firstAttemptAtMs: t0 })).toBe(t0 + 100)
		expect(computeNextAttemptAt({ attemptCount: 2, firstAttemptAtMs: t0 })).toBe(t0 + 500)
		expect(computeNextAttemptAt({ attemptCount: 3, firstAttemptAtMs: t0 })).toBe(t0 + 60_000)
		expect(computeNextAttemptAt({ attemptCount: 4, firstAttemptAtMs: t0 })).toBe(t0 + 5 * 60_000)
		expect(computeNextAttemptAt({ attemptCount: 5, firstAttemptAtMs: t0 })).toBe(t0 + 15 * 60_000)
	})

	it('[DISPATCH1.b] hourly tier reached after ~30min mark', () => {
		const t0 = 0
		// Attempts 7+ → hourly multiples
		expect(computeNextAttemptAt({ attemptCount: 7, firstAttemptAtMs: t0 })).toBe(60 * 60_000) // 1h
		expect(computeNextAttemptAt({ attemptCount: 8, firstAttemptAtMs: t0 })).toBe(2 * 60 * 60_000) // 2h
	})

	it('[DISPATCH2] schedule terminates → null after budget exhausted (DLQ)', () => {
		// After DISPATCH_MAX_ATTEMPTS, no more retries — null indicates DLQ.
		expect(
			computeNextAttemptAt({ attemptCount: DISPATCH_MAX_ATTEMPTS, firstAttemptAtMs: 0 }),
		).toBeNull()
		expect(
			computeNextAttemptAt({ attemptCount: DISPATCH_MAX_ATTEMPTS + 5, firstAttemptAtMs: 0 }),
		).toBeNull()
	})

	it('[DISPATCH2.b] total budget covers ~72h (Hookdeck canon)', () => {
		const t0 = 0
		// Last computable attempt should land near 72h.
		const lastAttempt = DISPATCH_MAX_ATTEMPTS - 1
		const finalTime = computeNextAttemptAt({ attemptCount: lastAttempt, firstAttemptAtMs: t0 })
		expect(finalTime).not.toBeNull()
		const hours = (finalTime ?? 0) / (60 * 60_000)
		// 72h budget per plan; verify within reasonable bound.
		expect(hours).toBeGreaterThanOrEqual(48)
		expect(hours).toBeLessThanOrEqual(72)
	})

	it('[DISPATCH2.c] attemptCount < 1 → throw RangeError', () => {
		expect(() => computeNextAttemptAt({ attemptCount: 0, firstAttemptAtMs: 0 })).toThrow(RangeError)
		expect(() => computeNextAttemptAt({ attemptCount: -1, firstAttemptAtMs: 0 })).toThrow(
			RangeError,
		)
	})
})

describe('isRetryableFailure — HTTP status handling', () => {
	it('[DISPATCH3] 2xx success NOT retryable', () => {
		expect(isRetryableFailure({ httpStatus: 200 })).toBe(false)
		expect(isRetryableFailure({ httpStatus: 201 })).toBe(false)
		expect(isRetryableFailure({ httpStatus: 204 })).toBe(false)
	})

	it("[DISPATCH3.b] 4xx client error NOT retryable (won't get better)", () => {
		expect(isRetryableFailure({ httpStatus: 400 })).toBe(false)
		expect(isRetryableFailure({ httpStatus: 401 })).toBe(false)
		expect(isRetryableFailure({ httpStatus: 404 })).toBe(false)
		expect(isRetryableFailure({ httpStatus: 422 })).toBe(false)
	})

	it('[DISPATCH3.c] 408 timeout + 429 rate-limit ARE retryable (4xx exceptions)', () => {
		expect(isRetryableFailure({ httpStatus: 408 })).toBe(true)
		expect(isRetryableFailure({ httpStatus: 429 })).toBe(true)
	})

	it('[DISPATCH3.d] 5xx server error retryable', () => {
		expect(isRetryableFailure({ httpStatus: 500 })).toBe(true)
		expect(isRetryableFailure({ httpStatus: 502 })).toBe(true)
		expect(isRetryableFailure({ httpStatus: 503 })).toBe(true)
		expect(isRetryableFailure({ httpStatus: 504 })).toBe(true)
	})

	it('[DISPATCH3.e] network error (status undefined) retryable', () => {
		expect(isRetryableFailure({ httpStatus: undefined })).toBe(true)
	})
})

describe('shouldAutoDisable — per-(tenant,channel) circuit breaker (D14 + Apaleo precedent)', () => {
	const NOW = 1_700_000_000_000
	const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000

	it('[DISPATCH4] no failures → no auto-disable', () => {
		expect(
			shouldAutoDisable(
				{ firstFailureAtMs: null, consecutiveFailures: 0, lastSuccessAtMs: NOW - 1000 },
				NOW,
			),
		).toBe(false)
	})

	it('[DISPATCH4.b] 4 consecutive failures < threshold (5) → no auto-disable', () => {
		expect(
			shouldAutoDisable(
				{
					firstFailureAtMs: NOW - SEVEN_DAYS_MS,
					consecutiveFailures: 4,
					lastSuccessAtMs: null,
				},
				NOW,
			),
		).toBe(false)
	})

	it('[DISPATCH4.c] 5 failures + 7-day window passed → auto-disable', () => {
		expect(
			shouldAutoDisable(
				{
					firstFailureAtMs: NOW - SEVEN_DAYS_MS - 1000,
					consecutiveFailures: 5,
					lastSuccessAtMs: null,
				},
				NOW,
			),
		).toBe(true)
	})

	it('[DISPATCH4.d] 5+ failures но window < 7 days → no auto-disable yet', () => {
		expect(
			shouldAutoDisable(
				{
					firstFailureAtMs: NOW - 6 * 24 * 60 * 60_000,
					consecutiveFailures: 50,
					lastSuccessAtMs: null,
				},
				NOW,
			),
		).toBe(false)
	})
})

describe('buildIdempotencyKey — D14 deterministic format', () => {
	it('[DISPATCH5] format = tenantId, aggregateId, cdcVersion, channelId joined by colon', () => {
		expect(
			buildIdempotencyKey({
				tenantId: 'org_demo-sirius',
				aggregateId: 'b-001',
				cdcVersion: 42,
				channelId: 'TL',
			}),
		).toBe('org_demo-sirius:b-001:42:TL')
	})

	it('[DISPATCH5.b] string cdcVersion handled (e.g. CDC virtual timestamp)', () => {
		expect(
			buildIdempotencyKey({
				tenantId: 't',
				aggregateId: 'a',
				cdcVersion: '1700000000.123',
				channelId: 'YT',
			}),
		).toBe('t:a:1700000000.123:YT')
	})

	it('[DISPATCH5.c] determinism — same input → same output (idempotency invariant)', () => {
		const args = { tenantId: 't', aggregateId: 'a', cdcVersion: 1, channelId: 'ETG' }
		const k1 = buildIdempotencyKey(args)
		const k2 = buildIdempotencyKey(args)
		expect(k1).toBe(k2)
	})
})

describe('schedule constants exposed via __testHooks', () => {
	it('[DISPATCH6] FAILURE_THRESHOLD = 5 + SEVEN_DAYS_MS = 7×24×60×60×1000', () => {
		expect(__testHooks.FAILURE_THRESHOLD).toBe(5)
		expect(__testHooks.SEVEN_DAYS_MS).toBe(7 * 24 * 60 * 60_000)
	})

	it('[DISPATCH6.b] RETRY_SCHEDULE_MS monotonically increasing', () => {
		const schedule = __testHooks.RETRY_SCHEDULE_MS
		for (let i = 1; i < schedule.length; i++) {
			const prev = schedule[i - 1] ?? 0
			const cur = schedule[i] ?? 0
			expect(cur).toBeGreaterThan(prev)
		}
	})
})
