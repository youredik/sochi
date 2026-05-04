/**
 * Strict tests для guest-portal computeCancelBoundary (M9.widget.5 / A3.3).
 *
 * Pure unit tests — verify ПП РФ № 1912 п. 16 boundary canon (Europe/Moscow
 * timezone, no DST since 2014).
 *
 * Coverage matrix:
 *   ─── Pre-checkin (100% refund) ────────────────────────────────
 *     [GP-CB1] now = day before checkIn 12:00 Moscow → pre_checkin
 *     [GP-CB2] now = checkIn day 00:00 Moscow → pre_checkin
 *     [GP-CB3] now = checkIn day 14:00 Moscow → pre_checkin (still day-of)
 *     [GP-CB4] now = checkIn day 23:59:59.999 Moscow → pre_checkin (last ms)
 *
 *   ─── Day-of-or-later (max 1-night charge) ─────────────────────
 *     [GP-CB5] now = checkIn day + 1 day 00:00:00 Moscow → day_of_or_later
 *     [GP-CB6] now = checkIn day + 2 days 12:00 Moscow → day_of_or_later
 *
 *   ─── Edge cases (timezone correctness) ────────────────────────
 *     [GP-CB7] checkIn 23:00 UTC (= next-day 02:00 Moscow) — boundary still
 *              relative к Moscow calendar day, NOT UTC
 *     [GP-CB8] checkIn early UTC (00:00 UTC = 03:00 Moscow same day) — boundary
 *              correct
 */

import { describe, expect, test } from 'vitest'
import { computeCancelBoundary } from './guest-portal.routes.ts'

/** Helper: Moscow wall-clock to UTC ms. Moscow is UTC+3 (no DST since 2014). */
function moscowToUtc(year: number, month: number, day: number, hour: number, min = 0): Date {
	// Moscow time → subtract 3h to get UTC ms
	return new Date(Date.UTC(year, month - 1, day, hour - 3, min, 0))
}

const CHECK_IN = moscowToUtc(2026, 6, 15, 14, 0) // 15 июня 2026, 14:00 Moscow

describe('computeCancelBoundary — ПП РФ № 1912 п. 16 canon', () => {
	test('[GP-CB1] day before checkIn 12:00 Moscow → pre_checkin', () => {
		const now = moscowToUtc(2026, 6, 14, 12, 0)
		expect(computeCancelBoundary(CHECK_IN, now)).toBe('pre_checkin')
	})

	test('[GP-CB2] checkIn day 00:00 Moscow → pre_checkin', () => {
		const now = moscowToUtc(2026, 6, 15, 0, 0)
		expect(computeCancelBoundary(CHECK_IN, now)).toBe('pre_checkin')
	})

	test('[GP-CB3] checkIn day 14:00 Moscow (canonical check-in time) → pre_checkin', () => {
		const now = moscowToUtc(2026, 6, 15, 14, 0)
		expect(computeCancelBoundary(CHECK_IN, now)).toBe('pre_checkin')
	})

	test('[GP-CB4] checkIn day 23:59 Moscow → pre_checkin (last minute of day)', () => {
		const now = moscowToUtc(2026, 6, 15, 23, 59)
		expect(computeCancelBoundary(CHECK_IN, now)).toBe('pre_checkin')
	})

	test('[GP-CB5] checkIn + 1 day 00:00 Moscow → day_of_or_later', () => {
		const now = moscowToUtc(2026, 6, 16, 0, 0)
		expect(computeCancelBoundary(CHECK_IN, now)).toBe('day_of_or_later')
	})

	test('[GP-CB6] checkIn + 2 days 12:00 Moscow → day_of_or_later', () => {
		const now = moscowToUtc(2026, 6, 17, 12, 0)
		expect(computeCancelBoundary(CHECK_IN, now)).toBe('day_of_or_later')
	})

	test('[GP-CB7] checkIn 23:00 UTC (02:00 Moscow next day) — boundary relative к Moscow calendar', () => {
		// CheckIn is 15 июня 23:00 UTC = 16 июня 02:00 Moscow (next day Moscow time).
		// «Calendar day» in Moscow time = 16 июня. Boundary = 17 июня 00:00 Moscow.
		const lateUtcCheckIn = new Date(Date.UTC(2026, 5, 15, 23, 0, 0)) // 15 июня 23:00 UTC
		// now = 16 июня 23:00 Moscow (still в Moscow «boundary day») → pre_checkin
		const nowPre = moscowToUtc(2026, 6, 16, 23, 0)
		expect(computeCancelBoundary(lateUtcCheckIn, nowPre)).toBe('pre_checkin')
		// now = 17 июня 00:00 Moscow → day_of_or_later
		const nowAfter = moscowToUtc(2026, 6, 17, 0, 0)
		expect(computeCancelBoundary(lateUtcCheckIn, nowAfter)).toBe('day_of_or_later')
	})

	test('[GP-CB8] checkIn 00:00 UTC (03:00 Moscow same day) — boundary correct', () => {
		// CheckIn 15 июня 00:00 UTC = 15 июня 03:00 Moscow. «Calendar day» Moscow = 15 июня.
		const earlyUtcCheckIn = new Date(Date.UTC(2026, 5, 15, 0, 0, 0)) // 15 июня 00:00 UTC
		const nowSameDay = moscowToUtc(2026, 6, 15, 23, 0)
		expect(computeCancelBoundary(earlyUtcCheckIn, nowSameDay)).toBe('pre_checkin')
		const nowNextDay = moscowToUtc(2026, 6, 16, 0, 0)
		expect(computeCancelBoundary(earlyUtcCheckIn, nowNextDay)).toBe('day_of_or_later')
	})
})
