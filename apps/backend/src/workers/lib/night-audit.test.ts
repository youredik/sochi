/**
 * Strict unit tests for night-audit pure functions.
 *
 * Per `feedback_strict_tests.md`: tests find bugs, never coddle the impl.
 * Coverage strategy: boundary + adversarial + property-style enum sweep
 * (mutation-testing-friendly — Stryker M6.5.1 expects exact-value asserts on
 * every codepath, not "smoke" passes).
 */
import { describe, expect, test } from 'vitest'
import {
	addDays,
	businessDate,
	nightAuditLineId,
	nightsToAudit,
	priceMinorForDate,
} from './night-audit.ts'

/* ============================================================ businessDate */

describe('businessDate (MSK cutoff)', () => {
	test('after cutoff (04:30 MSK) returns same calendar day', () => {
		// 01:30 UTC = 04:30 MSK on 04-26 → past 03:00 → 04-26.
		expect(businessDate(new Date('2026-04-26T01:30:00Z'), 3)).toBe('2026-04-26')
	})

	test('before cutoff (02:30 MSK) returns previous calendar day', () => {
		// 23:30 UTC on 04-25 = 02:30 MSK on 04-26 → before 03:00 → 04-25.
		expect(businessDate(new Date('2026-04-25T23:30:00Z'), 3)).toBe('2026-04-25')
	})

	test('exactly at cutoff (03:00 MSK) flips to today', () => {
		// 00:00 UTC = 03:00 MSK on 04-26 → at cutoff (NOT before) → 04-26.
		expect(businessDate(new Date('2026-04-26T00:00:00Z'), 3)).toBe('2026-04-26')
	})

	test('one millisecond before cutoff still yesterday', () => {
		// 23:59:59.999 UTC on 04-25 = 02:59:59.999 MSK on 04-26 → before 03:00 → 04-25.
		expect(businessDate(new Date('2026-04-25T23:59:59.999Z'), 3)).toBe('2026-04-25')
	})

	test('one millisecond after cutoff is today', () => {
		// 00:00:00.001 UTC on 04-26 = 03:00:00.001 MSK → after cutoff → 04-26.
		expect(businessDate(new Date('2026-04-26T00:00:00.001Z'), 3)).toBe('2026-04-26')
	})

	test('mid-day MSK (12:00) returns today', () => {
		// 09:00 UTC = 12:00 MSK → 04-26.
		expect(businessDate(new Date('2026-04-26T09:00:00Z'), 3)).toBe('2026-04-26')
	})

	test('late evening MSK (23:00) still returns today', () => {
		// 20:00 UTC = 23:00 MSK on 04-26 → 04-26.
		expect(businessDate(new Date('2026-04-26T20:00:00Z'), 3)).toBe('2026-04-26')
	})

	test('cutoff=0 (midnight MSK) — every wall-clock returns same calendar day', () => {
		// 21:00 UTC on 04-25 = 00:00 MSK on 04-26 → 04-26.
		expect(businessDate(new Date('2026-04-25T21:00:00Z'), 0)).toBe('2026-04-26')
		// 20:59:59.999 UTC = 23:59:59.999 MSK on 04-25 → before 00:00 cutoff → 04-25.
		expect(businessDate(new Date('2026-04-25T20:59:59.999Z'), 0)).toBe('2026-04-25')
	})

	test('cutoff=6 — between 03:00 and 06:00 MSK still yesterday', () => {
		// 02:00 UTC on 04-26 = 05:00 MSK → before 06:00 cutoff → 04-25.
		expect(businessDate(new Date('2026-04-26T02:00:00Z'), 6)).toBe('2026-04-25')
		// 03:00 UTC = 06:00 MSK → at cutoff → 04-26.
		expect(businessDate(new Date('2026-04-26T03:00:00Z'), 6)).toBe('2026-04-26')
	})

	test('crosses month boundary correctly (00:30 MSK on 1st of May)', () => {
		// 21:30 UTC on 04-30 = 00:30 MSK on 05-01 → before 03:00 → 04-30.
		expect(businessDate(new Date('2026-04-30T21:30:00Z'), 3)).toBe('2026-04-30')
	})

	test('crosses year boundary correctly', () => {
		// 22:30 UTC on 12-31 = 01:30 MSK on 01-01 → before 03:00 → 12-31.
		expect(businessDate(new Date('2026-12-31T22:30:00Z'), 3)).toBe('2026-12-31')
	})

	test('rejects negative cutoff', () => {
		expect(() => businessDate(new Date(), -1)).toThrow(RangeError)
	})

	test('rejects cutoff >= 24', () => {
		expect(() => businessDate(new Date(), 24)).toThrow(RangeError)
	})
})

/* ============================================================ nightsToAudit */

describe('nightsToAudit (Apaleo canon)', () => {
	const inHouse = (checkIn: string, checkOut: string) => ({
		status: 'in_house',
		checkIn,
		checkOut,
	})

	test('1-night stay, mid-stay → returns checkIn date only', () => {
		// checkIn=04-25, checkOut=04-26, businessDate=04-25 (audit fired
		// morning of 04-26, posting yesterday's night).
		expect(nightsToAudit(inHouse('2026-04-25', '2026-04-26'), '2026-04-25')).toEqual(['2026-04-25'])
	})

	test('1-night stay, but business date BEFORE checkIn → empty', () => {
		// Booking starts 04-25 but audit fires 04-24 (catchup before stay) → no nights.
		expect(nightsToAudit(inHouse('2026-04-25', '2026-04-26'), '2026-04-24')).toEqual([])
	})

	test('3-night stay, businessDate halfway → returns first 2 nights only', () => {
		expect(nightsToAudit(inHouse('2026-04-25', '2026-04-28'), '2026-04-26')).toEqual([
			'2026-04-25',
			'2026-04-26',
		])
	})

	test('3-night stay, businessDate at checkOut → returns ALL 3 nights (NOT 4)', () => {
		// checkOut day itself is NEVER charged (last billable night = checkOut-1).
		expect(nightsToAudit(inHouse('2026-04-25', '2026-04-28'), '2026-04-28')).toEqual([
			'2026-04-25',
			'2026-04-26',
			'2026-04-27',
		])
	})

	test('businessDate WAY past checkOut (overstay) → caps at checkOut-1', () => {
		// 30 days after the booking ended — audit catch-up should still cap.
		expect(nightsToAudit(inHouse('2026-04-25', '2026-04-28'), '2026-05-30')).toEqual([
			'2026-04-25',
			'2026-04-26',
			'2026-04-27',
		])
	})

	const skipStatuses = ['confirmed', 'cancelled', 'no_show', 'checked_out'] as const
	for (const status of skipStatuses) {
		test(`status='${status}' → empty (only in_house posts)`, () => {
			expect(
				nightsToAudit({ status, checkIn: '2026-04-25', checkOut: '2026-04-28' }, '2026-04-27'),
			).toEqual([])
		})
	}

	test('checkIn === checkOut (degenerate 0-night) → empty', () => {
		expect(nightsToAudit(inHouse('2026-04-25', '2026-04-25'), '2026-04-25')).toEqual([])
	})

	test('checkIn > checkOut (corrupted booking) → empty (no throw)', () => {
		expect(nightsToAudit(inHouse('2026-04-26', '2026-04-25'), '2026-04-26')).toEqual([])
	})

	test('businessDate exactly = checkIn → returns checkIn night only', () => {
		expect(nightsToAudit(inHouse('2026-04-25', '2026-04-30'), '2026-04-25')).toEqual(['2026-04-25'])
	})

	test('checkOut crosses month boundary → still correct', () => {
		expect(nightsToAudit(inHouse('2026-04-29', '2026-05-02'), '2026-05-01')).toEqual([
			'2026-04-29',
			'2026-04-30',
			'2026-05-01',
		])
	})
})

/* ============================================================ nightAuditLineId */

describe('nightAuditLineId (deterministic)', () => {
	test('produces stable id for same (folioId, date)', () => {
		const id1 = nightAuditLineId('fol_01ABCDEF', '2026-04-25')
		const id2 = nightAuditLineId('fol_01ABCDEF', '2026-04-25')
		expect(id1).toBe(id2)
		expect(id1).toBe('audit_fol_01ABCDEF_20260425')
	})

	test('different dates produce different ids', () => {
		expect(nightAuditLineId('fol_01ABCDEF', '2026-04-25')).not.toBe(
			nightAuditLineId('fol_01ABCDEF', '2026-04-26'),
		)
	})

	test('different folios produce different ids', () => {
		expect(nightAuditLineId('fol_01A', '2026-04-25')).not.toBe(
			nightAuditLineId('fol_01B', '2026-04-25'),
		)
	})

	test('rejects non-ISO date input', () => {
		expect(() => nightAuditLineId('fol_x', '25.04.2026')).toThrow(/date must be YYYY-MM-DD/)
		expect(() => nightAuditLineId('fol_x', '2026-4-25')).toThrow()
		expect(() => nightAuditLineId('fol_x', '20260425')).toThrow()
	})

	test('formatted date has no hyphens (audit_<folio>_YYYYMMDD)', () => {
		expect(nightAuditLineId('fol_test', '2026-12-31')).toBe('audit_fol_test_20261231')
	})
})

/* ============================================================ priceMinorForDate */

describe('priceMinorForDate (micros → minor conversion)', () => {
	const slices = [
		{ date: '2026-04-25', grossMicros: 5_000_000_000n }, // 5000 RUB
		{ date: '2026-04-26', grossMicros: 7_500_000_000n }, // 7500 RUB
		{ date: '2026-04-27', grossMicros: 10_000_000n }, // 10 RUB
	]

	test('returns minor (kopecks) for matching date', () => {
		// 5000 RUB × 1_000_000 = 5_000_000_000 micros / 10_000 = 500_000 minor (kopecks).
		expect(priceMinorForDate(slices, '2026-04-25')).toBe(500_000n)
	})

	test('different dates return different prices', () => {
		expect(priceMinorForDate(slices, '2026-04-26')).toBe(750_000n)
	})

	test('small amounts (10 RUB) round correctly', () => {
		// 10 RUB × 1_000_000 = 10_000_000 micros / 10_000 = 1000 minor.
		expect(priceMinorForDate(slices, '2026-04-27')).toBe(1000n)
	})

	test('returns null for date NOT in slices (gracefully)', () => {
		expect(priceMinorForDate(slices, '2026-04-30')).toBeNull()
	})

	test('returns null on empty slices', () => {
		expect(priceMinorForDate([], '2026-04-25')).toBeNull()
	})

	test('handles fractional micros (truncates toward zero)', () => {
		// 5_000_555 micros / 10_000 = 500.0555 → BigInt division = 500.
		const oddSlices = [{ date: '2026-04-25', grossMicros: 5_000_555n }]
		expect(priceMinorForDate(oddSlices, '2026-04-25')).toBe(500n)
	})
})

/* ============================================================ addDays */

describe('addDays (UTC arithmetic, no DST drift)', () => {
	test('+1 day', () => {
		expect(addDays('2026-04-25', 1)).toBe('2026-04-26')
	})

	test('-1 day', () => {
		expect(addDays('2026-04-25', -1)).toBe('2026-04-24')
	})

	test('crosses month boundary forward', () => {
		expect(addDays('2026-04-30', 1)).toBe('2026-05-01')
	})

	test('crosses month boundary backward', () => {
		expect(addDays('2026-05-01', -1)).toBe('2026-04-30')
	})

	test('crosses year boundary', () => {
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
	})

	test('+0 returns same date', () => {
		expect(addDays('2026-04-25', 0)).toBe('2026-04-25')
	})

	test('+30 in 31-day month', () => {
		expect(addDays('2026-03-01', 30)).toBe('2026-03-31')
	})

	test('+1 on 2026-02-28 (non-leap year) → 2026-03-01', () => {
		expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
	})

	test('+1 on 2028-02-28 (leap year) → 2028-02-29', () => {
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
	})

	test('rejects malformed input', () => {
		expect(() => addDays('25.04.2026', 1)).toThrow(/date must be YYYY-MM-DD/)
		expect(() => addDays('2026-4-25', 1)).toThrow()
	})
})
