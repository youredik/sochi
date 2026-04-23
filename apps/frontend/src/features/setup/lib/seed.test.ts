import { describe, expect, it } from 'vitest'
import { buildSeedPayload, rubToMicrosString } from './seed.ts'

describe('rubToMicrosString — money-conversion discipline', () => {
	describe('exact-value (every branch concrete)', () => {
		it.each([
			[0, '0'],
			[1, '1000000'],
			[5000, '5000000000'], // wizard default ₽5K
			[100_000, '100000000000'], // ₽100K edge (just under float safe-int)
			[9_007_199, '9007199000000'], // boundary: 2⁵³ / 10⁶
			[10_000_000, '10000000000000'], // past number×1e6 safe-int — BigInt preserves
			[2_147_483_647, '2147483647000000'], // INT32_MAX as rubles
		])('rubToMicrosString(%s) → "%s"', (rub, expected) => {
			expect(rubToMicrosString(rub)).toBe(expected)
		})
	})

	describe('precision guarantee (BigInt path, not number×1e6)', () => {
		it('conversion is exact for values past Number.MAX_SAFE_INTEGER / 1e6', () => {
			// Number path: 10_000_000 * 1_000_000 = 10_000_000_000_000 (still safe)
			// 9_007_199_255 * 1_000_000 would exceed MAX_SAFE_INTEGER (9.007e15).
			// Our BigInt path handles it exactly.
			const rub = 9_007_199_255
			const out = rubToMicrosString(rub)
			expect(out).toBe('9007199255000000')
			// Sanity: Number path would drift — prove string matches BigInt source of truth
			expect(BigInt(out)).toBe(BigInt(rub) * 1_000_000n)
		})
	})

	describe('adversarial — rejects bad input', () => {
		it('rejects negative rubles', () => {
			expect(() => rubToMicrosString(-1)).toThrow(/non-negative/)
		})
		it('rejects fractional rubles', () => {
			expect(() => rubToMicrosString(100.5)).toThrow(/integer/)
		})
		it('rejects NaN', () => {
			expect(() => rubToMicrosString(Number.NaN)).toThrow(/integer/)
		})
		it('rejects Infinity', () => {
			expect(() => rubToMicrosString(Number.POSITIVE_INFINITY)).toThrow(/integer/)
		})
	})
})

describe('buildSeedPayload', () => {
	describe('shape + invariants', () => {
		it('30-day default length + matching rates & availability dates', () => {
			const { rates, availability } = buildSeedPayload({ nightlyRub: 5000, allotment: 3 })
			expect(rates).toHaveLength(30)
			expect(availability).toHaveLength(30)
			for (let i = 0; i < 30; i++) {
				expect(rates[i]?.date).toBe(availability[i]?.date)
			}
		})

		it('every rate has the same computed amount + RUB currency', () => {
			const { rates } = buildSeedPayload({ nightlyRub: 7500, allotment: 1 })
			for (const r of rates) {
				expect(r.amount).toBe('7500000000')
				expect(r.currency).toBe('RUB')
			}
		})

		it('every availability row uses the passed allotment', () => {
			const { availability } = buildSeedPayload({ nightlyRub: 5000, allotment: 5 })
			for (const a of availability) {
				expect(a.allotment).toBe(5)
			}
		})

		it('dates are consecutive (no gaps, no duplicates)', () => {
			const { rates } = buildSeedPayload({ nightlyRub: 5000, allotment: 1, days: 15 })
			const dates = rates.map((r) => r.date)
			expect(new Set(dates).size).toBe(15) // no duplicates
			for (let i = 1; i < dates.length; i++) {
				const prev = new Date(`${dates[i - 1]}T12:00:00Z`)
				const cur = new Date(`${dates[i]}T12:00:00Z`)
				expect(cur.getTime() - prev.getTime()).toBe(86_400_000) // exactly 1 day
			}
		})
	})

	describe('custom window', () => {
		it('days:1 yields single-day payload', () => {
			const { rates } = buildSeedPayload({ nightlyRub: 5000, allotment: 1, days: 1 })
			expect(rates).toHaveLength(1)
		})
		it('days:365 yields full year', () => {
			const { rates } = buildSeedPayload({ nightlyRub: 5000, allotment: 1, days: 365 })
			expect(rates).toHaveLength(365)
		})
	})

	describe('adversarial', () => {
		it('rejects days < 1', () => {
			expect(() => buildSeedPayload({ nightlyRub: 5000, allotment: 1, days: 0 })).toThrow(
				/1\.\.365/,
			)
		})
		it('rejects days > 365 (server cap parity)', () => {
			expect(() => buildSeedPayload({ nightlyRub: 5000, allotment: 1, days: 366 })).toThrow(
				/1\.\.365/,
			)
		})
		it('rejects negative allotment', () => {
			expect(() => buildSeedPayload({ nightlyRub: 5000, allotment: -1 })).toThrow(
				/non-negative integer/,
			)
		})
		it('rejects fractional allotment', () => {
			expect(() => buildSeedPayload({ nightlyRub: 5000, allotment: 2.5 })).toThrow(
				/non-negative integer/,
			)
		})
		it('propagates money-conversion errors from rubToMicrosString', () => {
			expect(() => buildSeedPayload({ nightlyRub: -100, allotment: 1 })).toThrow(/non-negative/)
		})
	})
})
