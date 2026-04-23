/**
 * Property-based tests for the `nightsBetween(checkIn, checkOut)` helper.
 *
 * This helper is load-bearing: it decides exactly which `availability` rows
 * a booking locks/releases, so ANY off-by-one / DST / month-rollover bug
 * here corrupts inventory accounting.
 *
 * Invariants proved across the full valid input space:
 *   [NB1] Length equals calendar-day difference: `length === msDiff / 86400000`
 *   [NB2] First night equals checkIn (exclusive checkout convention)
 *   [NB3] Last night equals checkOut minus one day
 *   [NB4] All dates are strictly ascending, no gaps, no duplicates
 *   [NB5] Every produced date is a valid `YYYY-MM-DD` (regex-checked)
 *   [NB6] Same-day (checkIn === checkOut) → empty array (zero-night booking
 *         isn't payable; business layer should reject upstream)
 */
import { fc, test } from '@fast-check/vitest'
import { describe, expect, test as vitestTest } from 'vitest'
import { __bookingRepoInternals } from './booking.repo.ts'

const { nightsBetween } = __bookingRepoInternals

const MS_PER_DAY = 86_400_000
const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/

/**
 * Generate a pair (checkIn, checkOut) where checkIn < checkOut and the
 * span is 1..90 nights — the realistic booking horizon for HoReCa.
 *
 * Day-since-epoch indexing keeps the arbitrary free of fc.date's
 * occasional out-of-range shrink artifacts (caught empirically 2026-04-23
 * on a seed that drove toISOString into the extended-year branch).
 */
const stayArb = fc
	.tuple(
		fc.integer({
			min: Math.floor(Date.parse('2025-01-01T00:00:00Z') / MS_PER_DAY),
			max: Math.floor(Date.parse('2030-06-30T00:00:00Z') / MS_PER_DAY),
		}),
		fc.integer({ min: 1, max: 90 }),
	)
	.map(([startDay, nights]) => {
		const checkIn = new Date(startDay * MS_PER_DAY).toISOString().slice(0, 10)
		const checkOut = new Date((startDay + nights) * MS_PER_DAY).toISOString().slice(0, 10)
		return { checkIn, checkOut, expectedNights: nights }
	})

describe('nightsBetween — property-based', () => {
	test.prop([stayArb])('[NB1] length equals UTC day difference', ({ checkIn, checkOut }) => {
		const msDiff =
			new Date(`${checkOut}T00:00:00Z`).getTime() - new Date(`${checkIn}T00:00:00Z`).getTime()
		expect(nightsBetween(checkIn, checkOut)).toHaveLength(msDiff / MS_PER_DAY)
	})

	test.prop([stayArb])(
		'[NB2,NB3] bookends: first=checkIn, last=checkOut-1 day',
		({ checkIn, checkOut }) => {
			const nights = nightsBetween(checkIn, checkOut)
			expect(nights[0]).toBe(checkIn)
			const expectedLast = new Date(`${checkOut}T00:00:00Z`)
			expectedLast.setUTCDate(expectedLast.getUTCDate() - 1)
			expect(nights[nights.length - 1]).toBe(expectedLast.toISOString().slice(0, 10))
		},
	)

	test.prop([stayArb])(
		'[NB4] strictly ascending, no gaps, no duplicates',
		({ checkIn, checkOut }) => {
			const nights = nightsBetween(checkIn, checkOut)
			for (let i = 1; i < nights.length; i++) {
				const prev = new Date(`${nights[i - 1]}T00:00:00Z`).getTime()
				const curr = new Date(`${nights[i]}T00:00:00Z`).getTime()
				expect(curr - prev).toBe(MS_PER_DAY)
			}
			expect(new Set(nights).size).toBe(nights.length)
		},
	)

	test.prop([stayArb])(
		'[NB5] every produced date is a valid YYYY-MM-DD',
		({ checkIn, checkOut }) => {
			for (const d of nightsBetween(checkIn, checkOut)) {
				expect(d).toMatch(YMD_REGEX)
			}
		},
	)

	vitestTest('[NB6] same-day stay (checkIn === checkOut) → empty array', () => {
		expect(nightsBetween('2027-05-10', '2027-05-10')).toEqual([])
	})
})
