/**
 * Round 12 self-review SR-4/SR-7 strict tests for `validateDateRange`.
 *
 * Covers: empty (both/either) + invalid (bad month / impossible day /
 * non-ISO format) + order (checkOut <= checkIn) + happy path.
 */

import { describe, expect, test } from 'bun:test'
import { dateRangeErrorMessage, validateDateRange } from './validate-date-range.ts'

describe('validateDateRange', () => {
	test('[V1] happy path: checkOut > checkIn → ok=true', () => {
		expect(validateDateRange('2027-08-15', '2027-08-17')).toEqual({ ok: true })
	})

	test('[V2] empty checkIn → ok=false, reason=empty', () => {
		expect(validateDateRange('', '2027-08-17')).toEqual({ ok: false, reason: 'empty' })
	})

	test('[V3] empty checkOut → ok=false, reason=empty', () => {
		expect(validateDateRange('2027-08-15', '')).toEqual({ ok: false, reason: 'empty' })
	})

	test('[V4] both empty → ok=false, reason=empty', () => {
		expect(validateDateRange('', '')).toEqual({ ok: false, reason: 'empty' })
	})

	test('[V5] invalid month → ok=false, reason=invalid (SR-7 NaN guard)', () => {
		// `Date.parse('2027-13-15')` returns NaN. Before SR-7 fix, `NaN <= X`
		// would be false and validator returned ok=true silently. Now hard-
		// rejects as `'invalid'`.
		expect(validateDateRange('2027-13-15', '2027-13-17')).toEqual({
			ok: false,
			reason: 'invalid',
		})
	})

	test('[V6] gibberish string → ok=false, reason=invalid', () => {
		expect(validateDateRange('not-a-date', '2027-08-17')).toEqual({
			ok: false,
			reason: 'invalid',
		})
	})

	test('[V7] checkOut === checkIn → ok=false, reason=order (zero-night booking)', () => {
		expect(validateDateRange('2027-08-15', '2027-08-15')).toEqual({ ok: false, reason: 'order' })
	})

	test('[V8] checkOut < checkIn → ok=false, reason=order', () => {
		expect(validateDateRange('2027-08-17', '2027-08-15')).toEqual({ ok: false, reason: 'order' })
	})

	test('[V9] dateRangeErrorMessage exhaustive', () => {
		expect(dateRangeErrorMessage('empty')).toBe('Заполните обе даты — заезд и выезд.')
		expect(dateRangeErrorMessage('invalid')).toBe(
			'Дата указана некорректно. Используйте формат ДД.ММ.ГГГГ.',
		)
		expect(dateRangeErrorMessage('order')).toBe('Дата выезда должна быть позже даты заезда.')
	})
})
