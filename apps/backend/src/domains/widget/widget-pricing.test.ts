/**
 * widget-pricing — strict adversarial tests per `feedback_strict_tests.md`.
 *
 * Pure helpers — perfect for fast-check property-based + boundary asserts.
 * Coverage: exact-value asserts (not «something truthy»), negative paths
 * throw, immutability of inputs, RU-specific tax rounding (favor guest).
 */
import { fc, test as fcTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import {
	buildQuote,
	computeFreeCancelDeadline,
	computeTourismTaxMicros,
	enumerateNightDates,
	micrsToKopecks,
	sumNightlyRates,
} from './widget-pricing.ts'

describe('sumNightlyRates', () => {
	test('empty array → 0n', () => {
		expect(sumNightlyRates([])).toBe(0n)
	})

	test('single rate', () => {
		expect(sumNightlyRates([8_000_000_000n])).toBe(8_000_000_000n)
	})

	test('exact-value sum 5 nights @ 8000 RUB', () => {
		const five = [8_000_000_000n, 8_000_000_000n, 8_000_000_000n, 8_000_000_000n, 8_000_000_000n]
		expect(sumNightlyRates(five)).toBe(40_000_000_000n)
	})

	test('handles bigint values beyond Number.MAX_SAFE_INTEGER', () => {
		const huge = 10n ** 18n
		expect(sumNightlyRates([huge, huge])).toBe(2n * huge)
	})

	test('negative throws (defensive — DB invariant violated)', () => {
		expect(() => sumNightlyRates([1n, -1n])).toThrow(/Negative rate amount/)
	})

	fcTest.prop([fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { maxLength: 30 })])(
		'sum equals reduce-add для non-negative',
		(amts) => {
			const expected = amts.reduce((a, b) => a + b, 0n)
			expect(sumNightlyRates(amts)).toBe(expected)
		},
	)

	test('input array NOT mutated', () => {
		const input = [1n, 2n, 3n]
		const snapshot = [...input]
		sumNightlyRates(input)
		expect(input).toEqual(snapshot)
	})
})

describe('computeTourismTaxMicros', () => {
	test('Сочи 2% bps=200, subtotal 40000 RUB → 800 RUB tax', () => {
		const subtotal = 40_000_000_000n // 40000 RUB
		expect(computeTourismTaxMicros(subtotal, 200)).toBe(800_000_000n)
	})

	test('floor rounding favors guest (40001.99 RUB × 2% = 800.0398 → floor 800.0398 micros = correct)', () => {
		// 40001.99 RUB = 40_001_990_000 micros; ×200 / 10000 = 800_039_800 micros = 800.0398 RUB
		expect(computeTourismTaxMicros(40_001_990_000n, 200)).toBe(800_039_800n)
	})

	test('zero bps → zero tax', () => {
		expect(computeTourismTaxMicros(1_000_000_000n, 0)).toBe(0n)
	})

	test('zero subtotal → zero tax', () => {
		expect(computeTourismTaxMicros(0n, 200)).toBe(0n)
	})

	test('high bps 100% (sanity) → subtotal × 1', () => {
		expect(computeTourismTaxMicros(1_000_000_000n, 10_000)).toBe(1_000_000_000n)
	})

	test('non-integer bps throws', () => {
		expect(() => computeTourismTaxMicros(100n, 1.5)).toThrow(/integer/)
	})

	test('negative bps throws', () => {
		expect(() => computeTourismTaxMicros(100n, -1)).toThrow(/non-negative/)
	})

	test('negative subtotal throws', () => {
		expect(() => computeTourismTaxMicros(-1n, 200)).toThrow(/negative/)
	})

	fcTest.prop([fc.bigInt({ min: 0n, max: 10n ** 14n }), fc.integer({ min: 0, max: 10_000 })])(
		'tax ≤ subtotal × bps_max ratio',
		(subtotal, bps) => {
			const tax = computeTourismTaxMicros(subtotal, bps)
			expect(tax).toBeGreaterThanOrEqual(0n)
			expect(tax).toBeLessThanOrEqual(subtotal)
		},
	)
})

describe('micrsToKopecks', () => {
	test('1 RUB = 100 kopecks', () => {
		expect(micrsToKopecks(1_000_000n)).toBe(100)
	})

	test('1 kopeck = 10000 micros (boundary)', () => {
		expect(micrsToKopecks(10_000n)).toBe(1)
	})

	test('sub-kopeck floor truncation (9999 micros = 0 kopecks)', () => {
		expect(micrsToKopecks(9_999n)).toBe(0)
	})

	test('zero', () => {
		expect(micrsToKopecks(0n)).toBe(0)
	})

	test('negative throws', () => {
		expect(() => micrsToKopecks(-1n)).toThrow(/negative/)
	})

	test('large but safe-integer value', () => {
		// Number.MAX_SAFE_INTEGER kopecks = 9_007_199_254_740_991. Multiply by 10_000 micros/kop.
		expect(micrsToKopecks(90_071_992_547_409_910_000n)).toBe(Number.MAX_SAFE_INTEGER)
	})

	test('overflow throws на > MAX_SAFE_INTEGER kopecks', () => {
		// MAX_SAFE_INTEGER + 1 kopecks = (2^53) kopecks = 2^53 × 10_000 micros
		const overflow = (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 10_000n
		expect(() => micrsToKopecks(overflow)).toThrow(/MAX_SAFE_INTEGER/)
	})
})

describe('buildQuote', () => {
	test('5 nights × 8000 RUB + 2% tax = 40000 + 800 = 40800', () => {
		const five = Array.from({ length: 5 }, () => 8_000_000_000n)
		const q = buildQuote(five, 200)
		expect(q.subtotalMicros).toBe(40_000_000_000n)
		expect(q.tourismTaxMicros).toBe(800_000_000n)
		expect(q.totalMicros).toBe(40_800_000_000n)
		expect(q.subtotalKopecks).toBe(4_000_000)
		expect(q.tourismTaxKopecks).toBe(80_000)
		expect(q.totalKopecks).toBe(4_080_000)
	})

	test('0 bps tax (e.g. tenant без compliance) → tourism 0', () => {
		const q = buildQuote([1_000_000_000n], 0)
		expect(q.tourismTaxMicros).toBe(0n)
		expect(q.totalMicros).toBe(1_000_000_000n)
	})

	test('empty rates → all zeros', () => {
		const q = buildQuote([], 200)
		expect(q.subtotalMicros).toBe(0n)
		expect(q.totalMicros).toBe(0n)
		expect(q.totalKopecks).toBe(0)
	})

	test('immutable input', () => {
		const input = [1_000_000n, 2_000_000n]
		Object.freeze(input)
		expect(() => buildQuote(input, 200)).not.toThrow()
	})
})

describe('enumerateNightDates', () => {
	test('5-night stay enumerates 5 dates', () => {
		expect(enumerateNightDates('2026-06-01', '2026-06-06')).toEqual([
			'2026-06-01',
			'2026-06-02',
			'2026-06-03',
			'2026-06-04',
			'2026-06-05',
		])
	})

	test('1-night stay → 1 date (check-out NOT counted)', () => {
		expect(enumerateNightDates('2026-06-01', '2026-06-02')).toEqual(['2026-06-01'])
	})

	test('month boundary works (June → July)', () => {
		expect(enumerateNightDates('2026-06-30', '2026-07-02')).toEqual(['2026-06-30', '2026-07-01'])
	})

	test('year boundary works (Dec → Jan)', () => {
		expect(enumerateNightDates('2026-12-31', '2027-01-02')).toEqual(['2026-12-31', '2027-01-01'])
	})

	test('leap-year Feb 29 included', () => {
		expect(enumerateNightDates('2028-02-28', '2028-03-02')).toEqual([
			'2028-02-28',
			'2028-02-29',
			'2028-03-01',
		])
	})

	test('checkIn === checkOut throws', () => {
		expect(() => enumerateNightDates('2026-06-01', '2026-06-01')).toThrow(/must be </)
	})

	test('checkIn > checkOut throws', () => {
		expect(() => enumerateNightDates('2026-06-05', '2026-06-01')).toThrow(/must be </)
	})

	test('invalid format throws (no leading zero)', () => {
		expect(() => enumerateNightDates('2026-6-1', '2026-06-02')).toThrow(/checkIn invalid/)
	})

	test('non-ISO trash throws', () => {
		expect(() => enumerateNightDates('not-a-date', '2026-06-02')).toThrow(/checkIn invalid/)
	})

	test('DST is NOT relevant — UTC ops only (24h × n days exact)', () => {
		// Russia abolished DST in 2011 but даже если включить — UTC ops avoid the issue.
		const dates = enumerateNightDates('2026-03-29', '2026-04-01')
		expect(dates).toEqual(['2026-03-29', '2026-03-30', '2026-03-31'])
		expect(dates).toHaveLength(3)
	})
})

describe('computeFreeCancelDeadline', () => {
	test('null cancellationHours (non-refundable) → null', () => {
		expect(computeFreeCancelDeadline('2026-06-01', null)).toBeNull()
	})

	test('24h cancel: deadline = checkIn 14:00 MSK − 24h = previous day 11:00 UTC', () => {
		const result = computeFreeCancelDeadline('2026-06-10', 24)
		// 2026-06-10 14:00 MSK = 2026-06-10T11:00:00Z. Minus 24h = 2026-06-09T11:00:00Z.
		expect(result).toBe('2026-06-09T11:00:00.000Z')
	})

	test('48h cancel', () => {
		expect(computeFreeCancelDeadline('2026-06-10', 48)).toBe('2026-06-08T11:00:00.000Z')
	})

	test('0h cancel (deadline = check-in itself)', () => {
		expect(computeFreeCancelDeadline('2026-06-10', 0)).toBe('2026-06-10T11:00:00.000Z')
	})

	test('negative cancellationHours throws', () => {
		expect(() => computeFreeCancelDeadline('2026-06-10', -1)).toThrow(/non-negative/)
	})

	test('non-integer cancellationHours throws', () => {
		expect(() => computeFreeCancelDeadline('2026-06-10', 2.5)).toThrow(/integer/)
	})

	test('invalid date format throws', () => {
		expect(() => computeFreeCancelDeadline('not-a-date', 24)).toThrow(/checkInIsoDate invalid/)
	})

	test('crosses month boundary correctly', () => {
		// 2026-07-01 14:00 MSK − 48h = 2026-06-29T11:00:00Z
		expect(computeFreeCancelDeadline('2026-07-01', 48)).toBe('2026-06-29T11:00:00.000Z')
	})
})
