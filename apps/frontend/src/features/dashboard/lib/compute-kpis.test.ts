/**
 * compute-kpis.test.ts — strict tests for pure dashboard helpers.
 *
 * Pre-test invariants (per `feedback_strict_tests.md`):
 *
 *   todayInMoscow (deterministic TZ pinning):
 *     [T1] At 2026-05-12 14:00 UTC → "2026-05-12" Europe/Moscow (UTC+3 → 17:00 MSK)
 *     [T2] Boundary: 23:30 UTC May 11 → "2026-05-12" Europe/Moscow (00:30 MSK May 12)
 *     [T3] Boundary: 21:30 UTC May 12 → "2026-05-13" Europe/Moscow (00:30 MSK May 13)
 *
 *   countArrivalsToday — checkIn===today AND status ∈ {confirmed,in_house}:
 *     [A1] Empty → 0 (exact)
 *     [A2] Only past checkIns → 0
 *     [A3] Only future checkIns → 0
 *     [A4] Mixed today/yesterday/tomorrow → exact count of today's only
 *     [A5] Today + cancelled → cancelled excluded
 *     [A6] Today + no_show → no_show excluded
 *     [A7] Today + checked_out → checked_out excluded (already left)
 *     [A8] Today + in_house → INCLUDED (same-day check-in already arrived)
 *
 *   countInHouseNow — status === 'in_house' (state-machine, NOT date):
 *     [I1] Empty → 0
 *     [I2] Only confirmed → 0 (NOT in_house)
 *     [I3] Mixed statuses → exact count of in_house only
 *     [I4] Adversarial: confirmed-with-past-checkIn → 0 (status canonical, NOT date heuristic)
 *
 *   sumOpenBalanceMinor — BigInt precision preservation:
 *     [B1] Empty → exact 0n (NOT undefined / NaN)
 *     [B2] Single 500_000 → 500000n
 *     [B3] Mixed 150_000 + 50_000 + 100_000 → 300000n
 *     [B4] Negative balance (credit) included → mixed sum may be negative
 *     [B5] Beyond Number.MAX_SAFE_INTEGER (10^16 kopecks) — precision preserved
 *
 *   countFailedNotifications:
 *     [N1] Empty → 0
 *     [N2] Only sent → 0
 *     [N3] Mixed sent/pending/failed → only failed counted
 *     [N4] Adversarial: status='pending' NOT counted (only 'failed')
 */
import type { Booking, Folio, Notification } from '@horeca/shared'
import { describe, expect, test } from 'bun:test'
import {
	countArrivalsToday,
	countFailedNotifications,
	countInHouseNow,
	sumOpenBalanceMinor,
	todayInMoscow,
} from './compute-kpis.ts'

// Test-fixture factories — minimal shape that satisfies the relevant filters.
// Cast to keep tests focused on the property under test rather than full row
// hydration.
function makeBooking(opts: { checkIn?: string; status?: Booking['status'] }): Booking {
	return {
		checkIn: opts.checkIn ?? '2026-05-12',
		status: opts.status ?? 'confirmed',
	} as Booking
}

function makeFolio(balanceMinor: string): Folio {
	return { balanceMinor } as Folio
}

function makeNotification(status: Notification['status']): Notification {
	return { status } as Notification
}

describe('todayInMoscow — deterministic Europe/Moscow date string', () => {
	test('[T1] 2026-05-12 14:00 UTC → "2026-05-12" (17:00 MSK same day)', () => {
		const utc = new Date('2026-05-12T14:00:00Z')
		expect(todayInMoscow(utc)).toBe('2026-05-12')
	})

	test('[T2] 2026-05-11 23:30 UTC → "2026-05-12" (00:30 MSK boundary cross)', () => {
		const utc = new Date('2026-05-11T23:30:00Z')
		expect(todayInMoscow(utc)).toBe('2026-05-12')
	})

	test('[T3] 2026-05-12 21:30 UTC → "2026-05-13" (00:30 MSK next day)', () => {
		const utc = new Date('2026-05-12T21:30:00Z')
		expect(todayInMoscow(utc)).toBe('2026-05-13')
	})
})

describe('countArrivalsToday — today AND (confirmed OR in_house)', () => {
	const TODAY = '2026-05-12'
	const YESTERDAY = '2026-05-11'
	const TOMORROW = '2026-05-13'

	test('[A1] empty → 0 (exact zero, NOT undefined)', () => {
		expect(countArrivalsToday([], TODAY)).toBe(0)
	})

	test('[A2] only past checkIns → 0', () => {
		const bookings = [
			makeBooking({ checkIn: YESTERDAY, status: 'confirmed' }),
			makeBooking({ checkIn: YESTERDAY, status: 'in_house' }),
		]
		expect(countArrivalsToday(bookings, TODAY)).toBe(0)
	})

	test('[A3] only future checkIns → 0', () => {
		const bookings = [
			makeBooking({ checkIn: TOMORROW, status: 'confirmed' }),
			makeBooking({ checkIn: TOMORROW, status: 'in_house' }),
		]
		expect(countArrivalsToday(bookings, TODAY)).toBe(0)
	})

	test('[A4] mixed today/yesterday/tomorrow → exact today count', () => {
		const bookings = [
			makeBooking({ checkIn: TODAY, status: 'confirmed' }),
			makeBooking({ checkIn: TODAY, status: 'confirmed' }),
			makeBooking({ checkIn: YESTERDAY, status: 'confirmed' }), // excluded by date
			makeBooking({ checkIn: TOMORROW, status: 'confirmed' }), // excluded by date
		]
		expect(countArrivalsToday(bookings, TODAY)).toBe(2)
	})

	test('[A5] today + cancelled → cancelled excluded', () => {
		const bookings = [
			makeBooking({ checkIn: TODAY, status: 'cancelled' }),
			makeBooking({ checkIn: TODAY, status: 'confirmed' }),
		]
		expect(countArrivalsToday(bookings, TODAY)).toBe(1)
	})

	test('[A6] today + no_show → no_show excluded', () => {
		const bookings = [
			makeBooking({ checkIn: TODAY, status: 'no_show' }),
			makeBooking({ checkIn: TODAY, status: 'confirmed' }),
		]
		expect(countArrivalsToday(bookings, TODAY)).toBe(1)
	})

	test('[A7] today + checked_out → checked_out excluded (already departed)', () => {
		const bookings = [
			makeBooking({ checkIn: TODAY, status: 'checked_out' }),
			makeBooking({ checkIn: TODAY, status: 'confirmed' }),
		]
		expect(countArrivalsToday(bookings, TODAY)).toBe(1)
	})

	test('[A8] today + in_house INCLUDED (same-day check-in already arrived)', () => {
		const bookings = [
			makeBooking({ checkIn: TODAY, status: 'confirmed' }),
			makeBooking({ checkIn: TODAY, status: 'in_house' }),
		]
		expect(countArrivalsToday(bookings, TODAY)).toBe(2)
	})
})

describe('countInHouseNow — status === "in_house" (NOT date heuristic)', () => {
	test('[I1] empty → 0', () => {
		expect(countInHouseNow([])).toBe(0)
	})

	test('[I2] only confirmed (none yet arrived) → 0', () => {
		const bookings = [makeBooking({ status: 'confirmed' }), makeBooking({ status: 'confirmed' })]
		expect(countInHouseNow(bookings)).toBe(0)
	})

	test('[I3] mixed → exact in_house count', () => {
		const bookings = [
			makeBooking({ status: 'in_house' }),
			makeBooking({ status: 'in_house' }),
			makeBooking({ status: 'in_house' }),
			makeBooking({ status: 'confirmed' }),
			makeBooking({ status: 'checked_out' }),
			makeBooking({ status: 'cancelled' }),
		]
		expect(countInHouseNow(bookings)).toBe(3)
	})

	test('[I4] confirmed-with-past-checkIn NOT counted (date is NOT a proxy for status)', () => {
		// Mutation gate: if filter were "checkIn < today", this booking would
		// incorrectly count. Status MUST be the canonical source of truth.
		const bookings = [makeBooking({ checkIn: '2026-05-01', status: 'confirmed' })]
		expect(countInHouseNow(bookings)).toBe(0)
	})
})

describe('sumOpenBalanceMinor — BigInt precision preservation', () => {
	test('[B1] empty → exact 0n (NOT undefined, NOT NaN)', () => {
		const result = sumOpenBalanceMinor([])
		expect(result).toBe(0n)
		expect(typeof result).toBe('bigint')
	})

	test('[B2] single 500_000 kopecks → 500000n', () => {
		expect(sumOpenBalanceMinor([makeFolio('500000')])).toBe(500000n)
	})

	test('[B3] mixed 150_000 + 50_000 + 100_000 → 300000n (exact sum, no FP drift)', () => {
		const receivables = [makeFolio('150000'), makeFolio('50000'), makeFolio('100000')]
		expect(sumOpenBalanceMinor(receivables)).toBe(300000n)
	})

	test('[B4] negative balance (operator-applied credit) propagates in sum', () => {
		// Per folio.ts canon: folio.balanceMinor CAN be negative when adjustments
		// or credits exceed charges. The sum must surface this — operator needs
		// to see net open balance, not abs() value.
		const receivables = [makeFolio('100000'), makeFolio('-30000')]
		expect(sumOpenBalanceMinor(receivables)).toBe(70000n)
	})

	test('[B5] beyond Number.MAX_SAFE_INTEGER — precision preserved', () => {
		// 10^16 kopecks each row × 10 rows = 10^17 = far above 2^53 ≈ 9×10^15.
		// Number coercion would round; BigInt sum stays exact.
		const huge = '10000000000000000' // 10^16
		const receivables = Array.from({ length: 10 }, () => makeFolio(huge))
		expect(sumOpenBalanceMinor(receivables)).toBe(100000000000000000n) // 10^17
	})
})

describe('countFailedNotifications — status === "failed"', () => {
	test('[N1] empty → 0', () => {
		expect(countFailedNotifications([])).toBe(0)
	})

	test('[N2] only sent → 0 (sent is terminal-success)', () => {
		const notifications = [makeNotification('sent'), makeNotification('sent')]
		expect(countFailedNotifications(notifications)).toBe(0)
	})

	test('[N3] mixed → exact failed count', () => {
		const notifications = [
			makeNotification('sent'),
			makeNotification('failed'),
			makeNotification('failed'),
			makeNotification('pending'),
			makeNotification('failed'),
		]
		expect(countFailedNotifications(notifications)).toBe(3)
	})

	test('[N4] pending NOT counted (only terminal failed surfaces in alerts)', () => {
		// Mutation gate: if filter were `!== 'sent'`, this booking would count
		// pending as failed (wrong — pending is in-flight, NOT a failure).
		expect(countFailedNotifications([makeNotification('pending')])).toBe(0)
	})
})
