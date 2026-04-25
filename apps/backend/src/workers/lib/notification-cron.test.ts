/**
 * Strict unit tests for cron-trigger pure helpers.
 */
import { describe, expect, test } from 'vitest'
import {
	isCheckinReminderEligible,
	isInMskHour,
	isReviewRequestEligible,
	mskDateOffset,
} from './notification-cron.ts'

describe('isInMskHour', () => {
	test('15:00 UTC = 18:00 MSK → matches hour=18', () => {
		expect(isInMskHour(new Date('2026-04-26T15:00:00Z'), 18)).toBe(true)
	})

	test('15:30 UTC = 18:30 MSK → matches hour=18 (within window)', () => {
		expect(isInMskHour(new Date('2026-04-26T15:30:00Z'), 18)).toBe(true)
	})

	test('14:59 UTC = 17:59 MSK → does NOT match hour=18', () => {
		expect(isInMskHour(new Date('2026-04-26T14:59:00Z'), 18)).toBe(false)
	})

	test('16:00 UTC = 19:00 MSK → does NOT match hour=18 (next hour)', () => {
		expect(isInMskHour(new Date('2026-04-26T16:00:00Z'), 18)).toBe(false)
	})

	test('hour=11 (review_request canon)', () => {
		expect(isInMskHour(new Date('2026-04-26T08:00:00Z'), 11)).toBe(true)
		expect(isInMskHour(new Date('2026-04-26T07:59:00Z'), 11)).toBe(false)
	})

	test('hour=0 (midnight MSK)', () => {
		expect(isInMskHour(new Date('2026-04-25T21:00:00Z'), 0)).toBe(true)
	})

	test('hour=23 (last hour MSK)', () => {
		expect(isInMskHour(new Date('2026-04-26T20:00:00Z'), 23)).toBe(true)
	})

	test('rejects negative hour', () => {
		expect(() => isInMskHour(new Date(), -1)).toThrow(RangeError)
	})

	test('rejects hour=24', () => {
		expect(() => isInMskHour(new Date(), 24)).toThrow(RangeError)
	})

	test('rejects fractional hour', () => {
		expect(() => isInMskHour(new Date(), 18.5)).toThrow(RangeError)
	})
})

describe('mskDateOffset', () => {
	const noonMsk = new Date('2026-04-26T09:00:00Z') // 12:00 MSK

	test('+1 from 04-26 noon → 04-27', () => {
		expect(mskDateOffset(noonMsk, 1)).toBe('2026-04-27')
	})

	test('-1 from 04-26 noon → 04-25', () => {
		expect(mskDateOffset(noonMsk, -1)).toBe('2026-04-25')
	})

	test('0 → today', () => {
		expect(mskDateOffset(noonMsk, 0)).toBe('2026-04-26')
	})

	test('+1 across month boundary (04-30 → 05-01)', () => {
		expect(mskDateOffset(new Date('2026-04-30T09:00:00Z'), 1)).toBe('2026-05-01')
	})

	test('+1 across year boundary (2026-12-31 → 2027-01-01)', () => {
		expect(mskDateOffset(new Date('2026-12-31T09:00:00Z'), 1)).toBe('2027-01-01')
	})

	test('22:00 UTC = 01:00 MSK next day → MSK calendar bumped', () => {
		// 22:00 UTC on 04-25 = 01:00 MSK on 04-26 → MSK calendar day = 04-26.
		// +0 from this instant → 04-26 (MSK calendar).
		expect(mskDateOffset(new Date('2026-04-25T22:00:00Z'), 0)).toBe('2026-04-26')
	})

	test('rejects fractional days', () => {
		expect(() => mskDateOffset(noonMsk, 1.5)).toThrow(RangeError)
	})
})

describe('isCheckinReminderEligible', () => {
	test('confirmed + checkIn=tomorrow → true', () => {
		expect(
			isCheckinReminderEligible({ status: 'confirmed', checkIn: '2026-04-27' }, '2026-04-27'),
		).toBe(true)
	})

	test('in_house + checkIn=tomorrow → true (multi-night stay)', () => {
		expect(
			isCheckinReminderEligible({ status: 'in_house', checkIn: '2026-04-27' }, '2026-04-27'),
		).toBe(true)
	})

	test('confirmed + checkIn=DIFFERENT day → false', () => {
		expect(
			isCheckinReminderEligible({ status: 'confirmed', checkIn: '2026-04-28' }, '2026-04-27'),
		).toBe(false)
	})

	test('cancelled status → false (regardless of date)', () => {
		expect(
			isCheckinReminderEligible({ status: 'cancelled', checkIn: '2026-04-27' }, '2026-04-27'),
		).toBe(false)
	})

	test('no_show status → false', () => {
		expect(
			isCheckinReminderEligible({ status: 'no_show', checkIn: '2026-04-27' }, '2026-04-27'),
		).toBe(false)
	})

	test('checked_out status → false (already past stay)', () => {
		expect(
			isCheckinReminderEligible({ status: 'checked_out', checkIn: '2026-04-27' }, '2026-04-27'),
		).toBe(false)
	})
})

describe('isReviewRequestEligible', () => {
	test('checked_out + checkOut=yesterday → true', () => {
		expect(
			isReviewRequestEligible({ status: 'checked_out', checkOut: '2026-04-25' }, '2026-04-25'),
		).toBe(true)
	})

	test('checked_out + checkOut=DIFFERENT day → false', () => {
		expect(
			isReviewRequestEligible({ status: 'checked_out', checkOut: '2026-04-24' }, '2026-04-25'),
		).toBe(false)
	})

	test('cancelled → false (no experience to review — anti-spam guard)', () => {
		expect(
			isReviewRequestEligible({ status: 'cancelled', checkOut: '2026-04-25' }, '2026-04-25'),
		).toBe(false)
	})

	test('no_show → false (anti-spam guard)', () => {
		expect(
			isReviewRequestEligible({ status: 'no_show', checkOut: '2026-04-25' }, '2026-04-25'),
		).toBe(false)
	})

	test('confirmed (still upcoming) → false', () => {
		expect(
			isReviewRequestEligible({ status: 'confirmed', checkOut: '2026-04-25' }, '2026-04-25'),
		).toBe(false)
	})

	test('in_house (still mid-stay) → false', () => {
		expect(
			isReviewRequestEligible({ status: 'in_house', checkOut: '2026-04-25' }, '2026-04-25'),
		).toBe(false)
	})
})
