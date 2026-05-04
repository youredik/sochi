/**
 * Constant-tail-latency unit tests — D27 (R2 F2).
 *
 * Verify floor enforcement, fast-path no-additional-delay above floor,
 * and rejection propagation.
 */

import { describe, expect, it } from 'vitest'
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
		// Within ~50ms of the lookup duration — floor is 30ms < 100ms lookup
		// so the floor doesn't gate.
		expect(elapsed).toBeGreaterThanOrEqual(95)
		expect(elapsed).toBeLessThan(150)
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
