/**
 * widget-format — strict adversarial tests for pure RU formatters.
 *
 * Per `feedback_strict_tests.md`: exact-value asserts, edge cases (zero,
 * single-digit, ms boundaries, year/month rollovers), negative-path throws.
 *
 * NOTE: `formatRub` produces NBSP (U+00A0) and NNBSP (U+202F) separators per
 * Intl.NumberFormat('ru-RU') canon. Tests use regex match instead of strict
 * equality to avoid hidden-character flakiness across Node versions.
 */
import { describe, expect, test } from 'vitest'
import { formatDateRange, formatMeals, formatMoscowDateTime, formatRub } from './widget-format.ts'

describe('formatRub', () => {
	test('whole rubles → no fractional digits', () => {
		expect(formatRub(2_720_000)).toMatch(/^27\s?200[  ]?₽$/)
	})

	test('with kopecks → 2 fractional digits', () => {
		// 27200,50 ₽
		expect(formatRub(2_720_050)).toMatch(/27\s?200,50/)
	})

	test('zero', () => {
		expect(formatRub(0)).toMatch(/^0[  ]?₽$/)
	})

	test('1 kopeck → 0,01 ₽', () => {
		expect(formatRub(1)).toMatch(/0,01/)
	})

	test('100 kopecks (1 RUB)', () => {
		expect(formatRub(100)).toMatch(/^1[  ]?₽$/)
	})

	test('large value — 1 million RUB', () => {
		expect(formatRub(100_000_000)).toMatch(/1\s?000\s?000/)
	})

	test('NaN throws', () => {
		expect(() => formatRub(Number.NaN)).toThrow(/finite/)
	})

	test('Infinity throws', () => {
		expect(() => formatRub(Number.POSITIVE_INFINITY)).toThrow(/finite/)
	})

	test('non-integer throws (no fractional kopecks допустимо)', () => {
		expect(() => formatRub(2_720_000.5)).toThrow(/integer/)
	})
})

describe('formatDateRange', () => {
	test('same-month range', () => {
		expect(formatDateRange('2026-06-01', '2026-06-06')).toBe('1–6 июня 2026')
	})

	test('cross-month same-year range', () => {
		expect(formatDateRange('2026-06-30', '2026-07-03')).toBe('30 июня — 3 июля 2026')
	})

	test('cross-year range', () => {
		expect(formatDateRange('2026-12-30', '2027-01-03')).toBe('30 декабря 2026 — 3 января 2027')
	})

	test('1-night same-day range (rare but valid)', () => {
		expect(formatDateRange('2026-06-01', '2026-06-02')).toBe('1–2 июня 2026')
	})

	test('leap-year Feb 29 included', () => {
		expect(formatDateRange('2028-02-28', '2028-03-01')).toBe('28 февраля — 1 марта 2028')
	})

	test('invalid format throws', () => {
		expect(() => formatDateRange('2026-6-1', '2026-06-02')).toThrow(/YYYY-MM-DD/)
	})
})

describe('formatMoscowDateTime', () => {
	test('2026-05-28T11:00:00Z → 28 мая 14:00 МСК', () => {
		// 11:00 UTC + 3h MSK offset = 14:00 MSK
		expect(formatMoscowDateTime('2026-05-28T11:00:00.000Z')).toBe('28 мая, 14:00 (МСК)')
	})

	test('midnight MSK = 21:00 UTC previous day', () => {
		// 2026-05-31T21:00:00Z = 2026-06-01T00:00 MSK
		const result = formatMoscowDateTime('2026-05-31T21:00:00.000Z')
		expect(result).toBe('1 июня, 00:00 (МСК)')
	})

	test('invalid ISO throws', () => {
		expect(() => formatMoscowDateTime('not-iso')).toThrow(/invalid ISO/)
	})
})

describe('formatMeals', () => {
	test('breakfast', () => {
		expect(formatMeals('breakfast')).toBe('Завтрак включён')
	})

	test('halfBoard', () => {
		expect(formatMeals('halfBoard')).toBe('Полупансион')
	})

	test('fullBoard', () => {
		expect(formatMeals('fullBoard')).toBe('Полный пансион')
	})

	test('none → null (no UI label)', () => {
		expect(formatMeals('none')).toBeNull()
	})

	test('null → null', () => {
		expect(formatMeals(null)).toBeNull()
	})
})
