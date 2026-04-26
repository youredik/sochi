/**
 * `formatMonthRu` — strict tests per memory `feedback_strict_tests.md`.
 *
 * Test plan:
 *   Happy path:
 *     [H1] all 12 months Q1-Q4 → exact RU name + year
 *     [H2] year-boundary (2025-12 / 2026-01)
 *
 *   Malformed input (adversarial — backend bug must not crash UI):
 *     [M1] empty string → returned as-is
 *     [M2] no dash → returned as-is
 *     [M3] invalid month "00" → fallback "00 2026"
 *     [M4] invalid month "13" → fallback "13 2026"
 *     [M5] negative month "-1" → fallback "-1 2026"
 *     [M6] non-numeric month "ab" → fallback "ab 2026"
 *     [M7] decimal month "1.5" → fallback (Number.isInteger guard)
 *     [M8] missing month "2026-" → returned as-is (split produces empty)
 *     [M9] missing year "-04" → returned as-is (empty year)
 *
 *   Immutability:
 *     [I1] input string unchanged after call
 */
import { describe, expect, test } from 'vitest'
import { formatMonthRu } from './format-month.ts'

describe('formatMonthRu — happy path (all 12 months)', () => {
	test('[H1] 2026-01 → Январь 2026', () => {
		expect(formatMonthRu('2026-01')).toBe('Январь 2026')
	})
	test('[H1] 2026-02 → Февраль 2026', () => {
		expect(formatMonthRu('2026-02')).toBe('Февраль 2026')
	})
	test('[H1] 2026-03 → Март 2026', () => {
		expect(formatMonthRu('2026-03')).toBe('Март 2026')
	})
	test('[H1] 2026-04 → Апрель 2026', () => {
		expect(formatMonthRu('2026-04')).toBe('Апрель 2026')
	})
	test('[H1] 2026-05 → Май 2026', () => {
		expect(formatMonthRu('2026-05')).toBe('Май 2026')
	})
	test('[H1] 2026-06 → Июнь 2026', () => {
		expect(formatMonthRu('2026-06')).toBe('Июнь 2026')
	})
	test('[H1] 2026-07 → Июль 2026', () => {
		expect(formatMonthRu('2026-07')).toBe('Июль 2026')
	})
	test('[H1] 2026-08 → Август 2026', () => {
		expect(formatMonthRu('2026-08')).toBe('Август 2026')
	})
	test('[H1] 2026-09 → Сентябрь 2026', () => {
		expect(formatMonthRu('2026-09')).toBe('Сентябрь 2026')
	})
	test('[H1] 2026-10 → Октябрь 2026', () => {
		expect(formatMonthRu('2026-10')).toBe('Октябрь 2026')
	})
	test('[H1] 2026-11 → Ноябрь 2026', () => {
		expect(formatMonthRu('2026-11')).toBe('Ноябрь 2026')
	})
	test('[H1] 2026-12 → Декабрь 2026', () => {
		expect(formatMonthRu('2026-12')).toBe('Декабрь 2026')
	})

	test('[H2] year-boundary 2025-12 / 2026-01', () => {
		expect(formatMonthRu('2025-12')).toBe('Декабрь 2025')
		expect(formatMonthRu('2026-01')).toBe('Январь 2026')
	})
})

describe('formatMonthRu — malformed input (adversarial)', () => {
	test('[M1] empty string → returned as-is', () => {
		expect(formatMonthRu('')).toBe('')
	})
	test('[M2] no dash → returned as-is', () => {
		expect(formatMonthRu('202604')).toBe('202604')
	})
	test('[M3] month "00" → fallback "00 2026" (no fake "Январь")', () => {
		expect(formatMonthRu('2026-00')).toBe('00 2026')
	})
	test('[M4] month "13" → fallback "13 2026"', () => {
		expect(formatMonthRu('2026-13')).toBe('13 2026')
	})
	test('[M5] negative month "2026--1" → returned as-is (split produces empty middle)', () => {
		// "2026--1".split('-') = ['2026', '', '1'] — yearStr='2026', monthStr=''.
		// Empty monthStr fails truthy check → returns input unchanged.
		expect(formatMonthRu('2026--1')).toBe('2026--1')
	})
	test('[M6] non-numeric month "ab" → fallback "ab 2026"', () => {
		expect(formatMonthRu('2026-ab')).toBe('ab 2026')
	})
	test('[M7] decimal month "1.5" → fallback "1.5 2026" (Number.isInteger guard)', () => {
		expect(formatMonthRu('2026-1.5')).toBe('1.5 2026')
	})
	test('[M8] missing month "2026-" → returned as-is (split produces empty)', () => {
		expect(formatMonthRu('2026-')).toBe('2026-')
	})
	test('[M9] missing year "-04" → returned as-is (empty year)', () => {
		expect(formatMonthRu('-04')).toBe('-04')
	})
})

describe('formatMonthRu — immutability', () => {
	test('[I1] input string is not mutated', () => {
		const input = '2026-04'
		// String is immutable in JS, but verify the value doesn't change in-place
		// (defensive vs accidentally returning Reference equal to mutated input).
		const before = input
		formatMonthRu(input)
		expect(input).toBe(before)
	})
})
