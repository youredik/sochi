/**
 * `quarter-defaults` — strict pure tests per memory `feedback_strict_tests.md`.
 *
 * Test plan:
 *   quarterOfMonth:
 *     [Q1] Jan(1)/Feb(2)/Mar(3) → 1
 *     [Q2] Apr(4)/May(5)/Jun(6) → 2
 *     [Q3] Jul(7)/Aug(8)/Sep(9) → 3
 *     [Q4] Oct(10)/Nov(11)/Dec(12) → 4
 *     [Qe] month 0 / 13 / -1 / 999 → RangeError (adversarial)
 *
 *   quarterStart / quarterEnd (period boundary correctness):
 *     [B1] 2026 Q1: from=2026-01-01, to=2026-03-31
 *     [B2] 2026 Q2: from=2026-04-01, to=2026-06-30
 *     [B3] 2026 Q3: from=2026-07-01, to=2026-09-30
 *     [B4] 2026 Q4: from=2026-10-01, to=2026-12-31
 *     [B5] 2024 Q1 leap year: to=2024-03-31 (March always 31, leap-year
 *          property only matters for Feb)
 *
 *   defaultPeriod (frozen-now smoke):
 *     [D1] 2026-04-26 → Q2 → from=2026-04-01, to=2026-06-30
 *     [D2] 2026-12-31 boundary → Q4 → from=2026-10-01, to=2026-12-31
 *     [D3] 2027-01-01 boundary → Q1 → from=2027-01-01, to=2027-03-31
 *
 *   formatQuarterLabel (RU canon):
 *     [L1] year=2026 q=1 → "I квартал 2026"
 *     [L2] year=2025 q=4 → "IV квартал 2025"
 */
import { describe, expect, test } from 'vitest'
import {
	currentYearQuarter,
	defaultPeriod,
	formatQuarterLabel,
	lastNQuarters,
	quarterEnd,
	quarterOfMonth,
	quarterStart,
} from './quarter-defaults.ts'

describe('quarterOfMonth', () => {
	test('[Q1] Jan/Feb/Mar → 1', () => {
		expect(quarterOfMonth(1)).toBe(1)
		expect(quarterOfMonth(2)).toBe(1)
		expect(quarterOfMonth(3)).toBe(1)
	})
	test('[Q2] Apr/May/Jun → 2', () => {
		expect(quarterOfMonth(4)).toBe(2)
		expect(quarterOfMonth(5)).toBe(2)
		expect(quarterOfMonth(6)).toBe(2)
	})
	test('[Q3] Jul/Aug/Sep → 3', () => {
		expect(quarterOfMonth(7)).toBe(3)
		expect(quarterOfMonth(8)).toBe(3)
		expect(quarterOfMonth(9)).toBe(3)
	})
	test('[Q4] Oct/Nov/Dec → 4', () => {
		expect(quarterOfMonth(10)).toBe(4)
		expect(quarterOfMonth(11)).toBe(4)
		expect(quarterOfMonth(12)).toBe(4)
	})
	test('[Qe] out-of-range → RangeError', () => {
		expect(() => quarterOfMonth(0)).toThrow(RangeError)
		expect(() => quarterOfMonth(13)).toThrow(RangeError)
		expect(() => quarterOfMonth(-1)).toThrow(RangeError)
		expect(() => quarterOfMonth(999)).toThrow(RangeError)
	})
})

describe('quarterStart / quarterEnd boundaries', () => {
	test('[B1] 2026 Q1', () => {
		expect(quarterStart({ year: 2026, quarter: 1 })).toBe('2026-01-01')
		expect(quarterEnd({ year: 2026, quarter: 1 })).toBe('2026-03-31')
	})
	test('[B2] 2026 Q2', () => {
		expect(quarterStart({ year: 2026, quarter: 2 })).toBe('2026-04-01')
		expect(quarterEnd({ year: 2026, quarter: 2 })).toBe('2026-06-30')
	})
	test('[B3] 2026 Q3', () => {
		expect(quarterStart({ year: 2026, quarter: 3 })).toBe('2026-07-01')
		expect(quarterEnd({ year: 2026, quarter: 3 })).toBe('2026-09-30')
	})
	test('[B4] 2026 Q4', () => {
		expect(quarterStart({ year: 2026, quarter: 4 })).toBe('2026-10-01')
		expect(quarterEnd({ year: 2026, quarter: 4 })).toBe('2026-12-31')
	})
	test('[B5] 2024 Q1 (leap year sanity — March still 31)', () => {
		expect(quarterEnd({ year: 2024, quarter: 1 })).toBe('2024-03-31')
	})
	test('[B6] 2024 Q1 from = 2024-01-01 (leap-year start)', () => {
		expect(quarterStart({ year: 2024, quarter: 1 })).toBe('2024-01-01')
	})
})

describe('currentYearQuarter / defaultPeriod', () => {
	test('[D1] 2026-04-26 → Q2', () => {
		const now = new Date('2026-04-26T12:00:00Z')
		expect(currentYearQuarter(now)).toEqual({ year: 2026, quarter: 2 })
		expect(defaultPeriod(now)).toEqual({ from: '2026-04-01', to: '2026-06-30' })
	})
	test('[D2] 2026-12-31 boundary → Q4', () => {
		const now = new Date('2026-12-31T23:59:59Z')
		expect(currentYearQuarter(now)).toEqual({ year: 2026, quarter: 4 })
		expect(defaultPeriod(now)).toEqual({ from: '2026-10-01', to: '2026-12-31' })
	})
	test('[D3] 2027-01-01 boundary → Q1', () => {
		const now = new Date('2027-01-01T00:00:00Z')
		expect(currentYearQuarter(now)).toEqual({ year: 2027, quarter: 1 })
		expect(defaultPeriod(now)).toEqual({ from: '2027-01-01', to: '2027-03-31' })
	})
	test('[D4] 2026-03-31 last-day-of-Q1', () => {
		const now = new Date('2026-03-31T23:59:59Z')
		expect(currentYearQuarter(now)).toEqual({ year: 2026, quarter: 1 })
		expect(defaultPeriod(now)).toEqual({ from: '2026-01-01', to: '2026-03-31' })
	})
})

describe('lastNQuarters — wrap-around + adversarial', () => {
	test('[N1] now=2026-04-26 (Q2), n=4 → [2026Q2, 2026Q1, 2025Q4, 2025Q3]', () => {
		const now = new Date('2026-04-26T12:00:00Z')
		expect(lastNQuarters(now, 4)).toEqual([
			{ year: 2026, quarter: 2 },
			{ year: 2026, quarter: 1 },
			{ year: 2025, quarter: 4 },
			{ year: 2025, quarter: 3 },
		])
	})
	test('[N2] year boundary: now=2027-01-01 (Q1), n=4 → [2027Q1, 2026Q4, 2026Q3, 2026Q2]', () => {
		const now = new Date('2027-01-01T00:00:00Z')
		expect(lastNQuarters(now, 4)).toEqual([
			{ year: 2027, quarter: 1 },
			{ year: 2026, quarter: 4 },
			{ year: 2026, quarter: 3 },
			{ year: 2026, quarter: 2 },
		])
	})
	test('[N3] n=1 → just current quarter', () => {
		const now = new Date('2026-07-15T00:00:00Z')
		expect(lastNQuarters(now, 1)).toEqual([{ year: 2026, quarter: 3 }])
	})
	test('[N4] n=8 → 2 full years back (multiple year-boundary crosses)', () => {
		const now = new Date('2026-04-01T00:00:00Z')
		const result = lastNQuarters(now, 8)
		expect(result).toHaveLength(8)
		expect(result[0]).toEqual({ year: 2026, quarter: 2 })
		expect(result[7]).toEqual({ year: 2024, quarter: 3 })
	})
	test('[Ne] adversarial: n=0 → RangeError', () => {
		const now = new Date('2026-04-26T12:00:00Z')
		expect(() => lastNQuarters(now, 0)).toThrow(RangeError)
	})
	test('[Ne2] adversarial: n=-1 → RangeError', () => {
		const now = new Date('2026-04-26T12:00:00Z')
		expect(() => lastNQuarters(now, -1)).toThrow(RangeError)
	})
	test('[Ne3] adversarial: n=1.5 → RangeError', () => {
		const now = new Date('2026-04-26T12:00:00Z')
		expect(() => lastNQuarters(now, 1.5)).toThrow(RangeError)
	})
})

describe('lastNQuarters — immutability', () => {
	test('[NI1] now Date is not mutated', () => {
		const now = new Date('2026-04-26T12:00:00Z')
		const before = now.getTime()
		lastNQuarters(now, 4)
		expect(now.getTime()).toBe(before)
	})
	test('[NI2] returned array elements are independent objects (no shared refs)', () => {
		const result = lastNQuarters(new Date('2026-04-26T12:00:00Z'), 4)
		const first = result[0]
		if (!first) throw new Error('expected element')
		// Mutate the first one — shouldn't bleed into others.
		first.year = 9999
		expect(result[1]?.year).not.toBe(9999)
		expect(result[2]?.year).not.toBe(9999)
		expect(result[3]?.year).not.toBe(9999)
	})
})

describe('formatQuarterLabel — RU canon', () => {
	test('[L1] 2026 Q1 → "I квартал 2026"', () => {
		expect(formatQuarterLabel({ year: 2026, quarter: 1 })).toBe('I квартал 2026')
	})
	test('[L2] 2025 Q4 → "IV квартал 2025"', () => {
		expect(formatQuarterLabel({ year: 2025, quarter: 4 })).toBe('IV квартал 2025')
	})
	test('[L3] all 4 quarters use roman numerals', () => {
		expect(formatQuarterLabel({ year: 2026, quarter: 1 })).toContain('I ')
		expect(formatQuarterLabel({ year: 2026, quarter: 2 })).toContain('II ')
		expect(formatQuarterLabel({ year: 2026, quarter: 3 })).toContain('III ')
		expect(formatQuarterLabel({ year: 2026, quarter: 4 })).toContain('IV ')
	})
})
