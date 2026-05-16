import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import {
	type MobileListBooking,
	filterByStatus,
	filterBySearch,
	formatMobileGroupHeader,
	groupBookingsByCheckIn,
	nightsBetween,
	pluralNights,
} from './mobile-list-grouping.ts'

/**
 * G10 — strict + property-based tests для mobile-list pure helpers.
 * Per `[[fastcheck-gotchas]]` canon: integer-over-epoch, not fc.date.
 */

function mk(
	id: string,
	checkIn: string,
	checkOut = '2030-01-02',
	status = 'confirmed',
): MobileListBooking {
	return { id, checkIn, checkOut, status, roomTypeId: 'rmt_x' }
}

describe('groupBookingsByCheckIn', () => {
	test('empty input → empty array', () => {
		expect(groupBookingsByCheckIn([])).toEqual([])
	})

	test('groups bookings by checkIn date, ascending', () => {
		const result = groupBookingsByCheckIn([
			mk('b1', '2030-01-03'),
			mk('b2', '2030-01-01'),
			mk('b3', '2030-01-03'),
			mk('b4', '2030-01-02'),
		])
		expect(result.map((g) => g.dateKey)).toEqual(['2030-01-01', '2030-01-02', '2030-01-03'])
		// b1, b3 share 2030-01-03 → both in that group, sorted by id ASC
		expect(result[2]?.bookings.map((b) => b.id)).toEqual(['b1', 'b3'])
	})

	test('within-group order = id ASC (deterministic)', () => {
		const result = groupBookingsByCheckIn([
			mk('b_z', '2030-01-01'),
			mk('b_a', '2030-01-01'),
			mk('b_m', '2030-01-01'),
		])
		expect(result[0]?.bookings.map((b) => b.id)).toEqual(['b_a', 'b_m', 'b_z'])
	})

	test('property: every booking appears exactly once across all groups', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.integer({ min: 0, max: 9999 }).map((n) => `b_${n.toString().padStart(4, '0')}`),
						checkIn: fc.integer({ min: 0, max: 365 }).map((n) => {
							const d = new Date(Date.UTC(2030, 0, 1 + n))
							return d.toISOString().slice(0, 10)
						}),
					}),
					{ minLength: 0, maxLength: 50 },
				),
				(items) => {
					// Dedupe by id (fc may generate duplicates)
					const seen = new Set<string>()
					const unique = items.filter((b) => {
						if (seen.has(b.id)) return false
						seen.add(b.id)
						return true
					})
					const inputs = unique.map((b) => mk(b.id, b.checkIn, '2030-01-02', 'confirmed'))
					const groups = groupBookingsByCheckIn(inputs)
					const total = groups.reduce((sum, g) => sum + g.bookings.length, 0)
					expect(total).toBe(inputs.length)
					// Every input id appears in some group exactly once
					const idSet = new Set<string>()
					for (const g of groups) for (const b of g.bookings) idSet.add(b.id)
					expect(idSet.size).toBe(inputs.length)
				},
			),
			{ numRuns: 50 },
		)
	})

	test('property: groups sorted ASC by dateKey lexicographically (= chronologically для YYYY-MM-DD)', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.integer({ min: 0, max: 365 }).map((n) => {
						const d = new Date(Date.UTC(2030, 0, 1 + n))
						return d.toISOString().slice(0, 10)
					}),
					{ minLength: 0, maxLength: 30 },
				),
				(dates) => {
					const inputs = dates.map((d, i) => mk(`b_${i.toString().padStart(4, '0')}`, d))
					const groups = groupBookingsByCheckIn(inputs)
					const keys = groups.map((g) => g.dateKey)
					const sorted = keys.slice().sort()
					expect(keys).toEqual(sorted)
				},
			),
			{ numRuns: 50 },
		)
	})
})

describe('filterByStatus — multi-select', () => {
	const items = [
		mk('a', '2030-01-01', '2030-01-02', 'confirmed'),
		mk('b', '2030-01-01', '2030-01-02', 'in_house'),
		mk('c', '2030-01-01', '2030-01-02', 'cancelled'),
	]

	test('empty selected = no filter (returns all)', () => {
		expect(filterByStatus(items, new Set())).toHaveLength(3)
	})

	test('single status', () => {
		const got = filterByStatus(items, new Set(['confirmed']))
		expect(got.map((b) => b.id)).toEqual(['a'])
	})

	test('multi-select', () => {
		const got = filterByStatus(items, new Set(['confirmed', 'cancelled']))
		expect(got.map((b) => b.id)).toEqual(['a', 'c'])
	})

	test('no matches → empty array', () => {
		expect(filterByStatus(items, new Set(['no_show']))).toEqual([])
	})
})

describe('filterBySearch — case-insensitive substring', () => {
	type Item = { id: string; searchText: string }
	const items: Item[] = [
		{ id: 'a', searchText: 'Иванов И. B-1234' },
		{ id: 'b', searchText: 'Петров П. B-5678' },
		{ id: 'c', searchText: 'Сидоров С. B-9012' },
	]
	const getText = (i: Item) => i.searchText

	test('empty query = no filter', () => {
		expect(filterBySearch(items, getText, '')).toHaveLength(3)
		expect(filterBySearch(items, getText, '   ')).toHaveLength(3)
	})

	test('match on name', () => {
		const got = filterBySearch(items, getText, 'петров')
		expect(got.map((i) => i.id)).toEqual(['b'])
	})

	test('match on booking#', () => {
		const got = filterBySearch(items, getText, 'B-9012')
		expect(got.map((i) => i.id)).toEqual(['c'])
	})

	test('partial match (substring)', () => {
		const got = filterBySearch(items, getText, '9012')
		expect(got.map((i) => i.id)).toEqual(['c'])
	})

	test('case-insensitive', () => {
		const got = filterBySearch(items, getText, 'ИВАНОВ')
		expect(got.map((i) => i.id)).toEqual(['a'])
	})

	test('no match → empty', () => {
		expect(filterBySearch(items, getText, 'xxx')).toEqual([])
	})
})

describe('formatMobileGroupHeader — RU canon', () => {
	const today = '2026-05-16'

	test('today → "Сегодня"', () => {
		expect(formatMobileGroupHeader('2026-05-16', today)).toBe('Сегодня')
	})

	test('today+1 → "Завтра"', () => {
		expect(formatMobileGroupHeader('2026-05-17', today)).toBe('Завтра')
	})

	test('today-1 → "Вчера"', () => {
		expect(formatMobileGroupHeader('2026-05-15', today)).toBe('Вчера')
	})

	test('arbitrary future date → "DD <месяц>, <weekday>"', () => {
		// 2026-05-20 = среда per UTC
		expect(formatMobileGroupHeader('2026-05-20', today)).toBe('20 мая, среда')
	})

	test('arbitrary past date', () => {
		// 2026-04-15 = среда
		expect(formatMobileGroupHeader('2026-04-15', today)).toBe('15 апреля, среда')
	})
})

describe('pluralNights — Russian plural rules', () => {
	test('1 → "ночь"', () => {
		expect(pluralNights(1)).toBe('ночь')
		expect(pluralNights(21)).toBe('ночь')
		expect(pluralNights(101)).toBe('ночь')
	})

	test('2/3/4 → "ночи"', () => {
		expect(pluralNights(2)).toBe('ночи')
		expect(pluralNights(3)).toBe('ночи')
		expect(pluralNights(4)).toBe('ночи')
		expect(pluralNights(22)).toBe('ночи')
	})

	test('5..20 → "ночей" (11-14 special case)', () => {
		expect(pluralNights(5)).toBe('ночей')
		expect(pluralNights(11)).toBe('ночей')
		expect(pluralNights(12)).toBe('ночей')
		expect(pluralNights(13)).toBe('ночей')
		expect(pluralNights(14)).toBe('ночей')
		expect(pluralNights(15)).toBe('ночей')
		expect(pluralNights(20)).toBe('ночей')
	})

	test('zero → "ночей" (defensive)', () => {
		expect(pluralNights(0)).toBe('ночей')
	})
})

describe('nightsBetween', () => {
	test('1-night stay', () => {
		expect(nightsBetween('2026-05-16', '2026-05-17')).toBe(1)
	})

	test('5-night stay', () => {
		expect(nightsBetween('2026-05-16', '2026-05-21')).toBe(5)
	})

	test('same-day (zero nights)', () => {
		expect(nightsBetween('2026-05-16', '2026-05-16')).toBe(0)
	})

	test('reverse-input clamps к 0 (defensive vs `[[reverse-date-and-server-cap-traps]]`)', () => {
		expect(nightsBetween('2026-05-20', '2026-05-16')).toBe(0)
	})

	test('crosses month boundary', () => {
		expect(nightsBetween('2026-04-29', '2026-05-02')).toBe(3)
	})
})
