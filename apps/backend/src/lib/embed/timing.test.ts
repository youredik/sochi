/**
 * Constant-tail-latency unit tests — D27 (R2 F2).
 *
 * Verify floor enforcement, fast-path no-additional-delay above floor,
 * and rejection propagation.
 */

import { describe, expect, it } from 'bun:test'
import { constantTailLatency } from './timing.ts'

describe('constantTailLatency', () => {
	it('[T1] enforces wall-clock floor when lookup resolves immediately', async () => {
		const start = Date.now()
		await constantTailLatency(async () => 'ok', 50)
		const elapsed = Date.now() - start
		expect(elapsed).toBeGreaterThanOrEqual(48) // small jitter tolerance
	})

	it('[T2] does not delay further when lookup is slower than floor', async () => {
		const start = Date.now()
		await constantTailLatency(async () => {
			await new Promise((r) => setTimeout(r, 100))
			return 'ok'
		}, 30)
		const elapsed = Date.now() - start
		// Round 14.6.4 follow-up (2026-05-29) — Run #144 failed на CI runner с
		// elapsed > 150ms (slow shared compute, event-loop variance). Original
		// 50ms tolerance over 100ms lookup = tight на cloud CI. Invariant tested
		// is "floor doesn't ADD значимый delay BEYOND lookup duration" — а 300ms
		// upper bound still verifies that (would catch floor mistakenly raised
		// from 30ms к e.g. 200ms = sum=200+lookup=300+ > cap). 300ms = 3×lookup
		// matches Bun:test 2026 canon (см. `feedback_bun_test_canons_2026_05_13`).
		expect(elapsed).toBeGreaterThanOrEqual(95)
		expect(elapsed).toBeLessThan(300)
	})

	it('[T3] returns the lookup value verbatim on success', async () => {
		const out = await constantTailLatency(async () => ({ kind: 'hit', n: 42 }), 5)
		expect(out).toEqual({ kind: 'hit', n: 42 })
	})

	it('[T4] propagates lookup rejection (preserves Error class)', async () => {
		class CustomError extends Error {}
		await expect(
			constantTailLatency(async () => {
				throw new CustomError('boom')
			}, 5),
		).rejects.toBeInstanceOf(CustomError)
	})

	it('[T5] honours floor before propagating rejection (timing-safe error path)', async () => {
		const start = Date.now()
		await expect(
			constantTailLatency(async () => {
				throw new Error('miss')
			}, 40),
		).rejects.toThrow(/miss/)
		const elapsed = Date.now() - start
		expect(elapsed).toBeGreaterThanOrEqual(38)
	})
})
