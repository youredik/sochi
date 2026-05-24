/**
 * token-bucket — strict tests (per `feedback_strict_tests.md`).
 *
 *   ─── Construction validation ──────────────────────────────────────
 *     [V1] refillIntervalMs <= 0 throws
 *     [V2] burstCapacity < 1 throws
 *
 *   ─── Burst behaviour ──────────────────────────────────────────────
 *     [B1] burst N calls fire immediately (within burstCapacity)
 *     [B2] (N+1)th call waits ~refillIntervalMs
 *
 *   ─── Steady-state behaviour ───────────────────────────────────────
 *     [S1] burstCapacity=1 enforces strict 1/interval (no burst)
 *
 *   ─── AbortSignal ──────────────────────────────────────────────────
 *     [A1] signal already aborted → throws AbortError before wait
 *     [A2] signal aborts during wait → throws AbortError, no leak
 */
import { describe, expect, test } from 'bun:test'
import { createTokenBucket } from './token-bucket.ts'

describe('token-bucket', () => {
	test('[V1] refillIntervalMs <= 0 throws', () => {
		expect(() => createTokenBucket({ refillIntervalMs: 0, burstCapacity: 1 })).toThrow(
			/refillIntervalMs must be > 0/,
		)
		expect(() => createTokenBucket({ refillIntervalMs: -5, burstCapacity: 1 })).toThrow(
			/refillIntervalMs must be > 0/,
		)
	})

	test('[V2] burstCapacity < 1 throws', () => {
		expect(() => createTokenBucket({ refillIntervalMs: 100, burstCapacity: 0 })).toThrow(
			/burstCapacity must be >= 1/,
		)
	})

	test('[B1] burst N calls fire immediately within burstCapacity', async () => {
		const bucket = createTokenBucket({ refillIntervalMs: 1000, burstCapacity: 5 })
		const t0 = Date.now()
		await Promise.all([
			bucket.acquire(),
			bucket.acquire(),
			bucket.acquire(),
			bucket.acquire(),
			bucket.acquire(),
		])
		// All 5 burst tokens should resolve in well under 1000ms (target: < 50ms)
		expect(Date.now() - t0).toBeLessThan(100)
	})

	test('[B2] (burstCap+1)th call waits ~refillIntervalMs', async () => {
		const bucket = createTokenBucket({ refillIntervalMs: 200, burstCapacity: 3 })
		const t0 = Date.now()
		// Consume the 3 burst tokens
		await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire()])
		// 4th acquire must wait until the bucket refills (≥200ms)
		await bucket.acquire()
		const elapsed = Date.now() - t0
		expect(elapsed).toBeGreaterThanOrEqual(180) // 200 with ±20ms slop
	})

	test('[S1] burstCapacity=1 enforces strict 1/interval (no burst)', async () => {
		const bucket = createTokenBucket({ refillIntervalMs: 150, burstCapacity: 1 })
		const t0 = Date.now()
		await bucket.acquire()
		await bucket.acquire()
		const elapsed = Date.now() - t0
		expect(elapsed).toBeGreaterThanOrEqual(140)
	})

	test('[A1] signal already aborted → throws AbortError before wait', async () => {
		const bucket = createTokenBucket({ refillIntervalMs: 1000, burstCapacity: 1 })
		const ctrl = new AbortController()
		ctrl.abort()
		await expect(bucket.acquire(ctrl.signal)).rejects.toThrow(/Aborted before token-bucket/)
	})

	test('[A2] signal aborts during wait → throws AbortError', async () => {
		const bucket = createTokenBucket({ refillIntervalMs: 1000, burstCapacity: 1 })
		// First acquire consumes the only token
		await bucket.acquire()
		const ctrl = new AbortController()
		const promise = bucket.acquire(ctrl.signal)
		// Abort during wait
		setTimeout(() => ctrl.abort(), 50)
		await expect(promise).rejects.toThrow(/Aborted during token-bucket wait/)
	})
})
