import { describe, expect, it } from 'vitest'
import {
	addDays,
	compareToToday,
	diffDays,
	iterateDates,
	parseDate,
	todayIso,
} from './date-range.ts'

describe('date-range', () => {
	describe('addDays (exact-value)', () => {
		it.each([
			['2026-04-23', 7, '2026-04-30'],
			['2026-04-23', -7, '2026-04-16'],
			['2026-04-23', 0, '2026-04-23'],
			['2026-02-28', 1, '2026-03-01'], // non-leap
			['2024-02-28', 1, '2024-02-29'], // leap
			['2024-02-29', 1, '2024-03-01'],
			['2025-12-31', 1, '2026-01-01'], // year boundary
			['2026-03-29', 1, '2026-03-30'], // EU DST spring fwd — UTC anchored, no skip
			['2026-10-25', 1, '2026-10-26'], // EU DST fall back — no 25-hour day
		])('addDays(%s, %d) → %s', (from, delta, expected) => {
			expect(addDays(from, delta)).toBe(expected)
		})
	})

	describe('diffDays', () => {
		it('same day → 0', () => {
			expect(diffDays('2026-04-23', '2026-04-23')).toBe(0)
		})
		it('forward → positive', () => {
			expect(diffDays('2026-04-23', '2026-04-30')).toBe(7)
		})
		it('backward → negative', () => {
			expect(diffDays('2026-04-30', '2026-04-23')).toBe(-7)
		})
		it('year boundary', () => {
			expect(diffDays('2025-12-25', '2026-01-01')).toBe(7)
		})
	})

	describe('iterateDates (exact-value + boundary)', () => {
		it('single-day range → [from]', () => {
			expect(iterateDates('2026-04-23', '2026-04-23')).toEqual(['2026-04-23'])
		})
		it('7-day range → 7 entries inclusive', () => {
			expect(iterateDates('2026-04-23', '2026-04-29')).toEqual([
				'2026-04-23',
				'2026-04-24',
				'2026-04-25',
				'2026-04-26',
				'2026-04-27',
				'2026-04-28',
				'2026-04-29',
			])
		})
		it('reversed range → empty', () => {
			expect(iterateDates('2026-04-30', '2026-04-23')).toEqual([])
		})
		it('366-day range throws (adversarial: off-by-one vs server 365 cap)', () => {
			expect(() => iterateDates('2026-01-01', '2027-01-01')).toThrowError(/365/)
		})
		it('365-day range works (exactly at cap)', () => {
			const out = iterateDates('2026-01-01', '2026-12-31')
			expect(out).toHaveLength(365)
			expect(out[0]).toBe('2026-01-01')
			expect(out.at(-1)).toBe('2026-12-31')
		})
	})

	describe('parseDate (UTC anchoring)', () => {
		it('parses to UTC noon', () => {
			expect(parseDate('2026-04-23').toISOString()).toBe('2026-04-23T12:00:00.000Z')
		})
	})

	describe('todayIso', () => {
		it('returns YYYY-MM-DD shape', () => {
			expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		})
	})

	describe('compareToToday (adversarial — relative assertions)', () => {
		it('yesterday is past', () => {
			expect(compareToToday(addDays(todayIso(), -1))).toBe('past')
		})
		it('tomorrow is future', () => {
			expect(compareToToday(addDays(todayIso(), 1))).toBe('future')
		})
		it('today is today', () => {
			expect(compareToToday(todayIso())).toBe('today')
		})
	})
})
