/**
 * aging-buckets — strict unit tests per memory `feedback_strict_tests.md`.
 *
 * Канон: exact-value asserts, boundary-driven, adversarial negative paths,
 * NO range-asserts (`toBeGreaterThan` etc) для дат — только точные дни.
 *
 * Test plan:
 *   bucketForDays — точные boundary (0, 7, 8, 30, 31, 60, 61, 1000, -1)
 *   daysBetween — UTC math + invalid-date throw
 *   summarizeReceivables — empty / single / multi-bucket / KPI math
 */
import type { Folio } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import { ALL_BUCKETS, bucketForDays, daysBetween, summarizeReceivables } from './aging-buckets.ts'

const NOW = new Date('2026-04-25T12:00:00Z')

/** Helper: стабильный folio для unit-тестов. */
function f(opts: { balanceMinor: string; daysAgo: number; id?: string }): Folio {
	const created = new Date(NOW.getTime() - opts.daysAgo * 86_400_000)
	return {
		tenantId: 'org-X',
		propertyId: 'prop-X',
		bookingId: 'bkg-X',
		id: opts.id ?? `fol-${opts.daysAgo}`,
		kind: 'guest',
		status: 'open',
		currency: 'RUB',
		companyId: null,
		balanceMinor: opts.balanceMinor,
		version: 1,
		createdAt: created.toISOString(),
		updatedAt: created.toISOString(),
		createdBy: 'usr-X',
		updatedBy: 'usr-X',
		closedAt: null,
		settledAt: null,
		closedBy: null,
	}
}

/* ============================================================ ALL_BUCKETS */

describe('ALL_BUCKETS', () => {
	test('exhaustive enum with stable order: current → 8to30 → 31to60 → over60', () => {
		expect(ALL_BUCKETS).toEqual(['current', '8to30', '31to60', 'over60'])
	})
})

/* ============================================================ bucketForDays */

describe('bucketForDays — boundary canon', () => {
	test.each([
		[0, 'current'],
		[1, 'current'],
		[7, 'current'], // INCLUSIVE upper edge of current
		[8, '8to30'], // EXCLUSIVE — first day of 8to30
		[15, '8to30'],
		[30, '8to30'], // INCLUSIVE upper edge of 8to30
		[31, '31to60'], // EXCLUSIVE — first day of 31to60
		[45, '31to60'],
		[60, '31to60'], // INCLUSIVE upper edge of 31to60
		[61, 'over60'], // EXCLUSIVE — first day of over60
		[1_000, 'over60'],
	] as const)('%i days → %s', (days, expected) => {
		expect(bucketForDays(days)).toBe(expected)
	})

	test('negative days (clock skew) → current (graceful)', () => {
		expect(bucketForDays(-1)).toBe('current')
		expect(bucketForDays(-100)).toBe('current')
	})
})

/* ============================================================ daysBetween */

describe('daysBetween', () => {
	test('exact days: 7 days ago → 7', () => {
		const start = new Date(NOW.getTime() - 7 * 86_400_000).toISOString()
		expect(daysBetween(start, NOW)).toBe(7)
	})

	test('floor (7.9 days → 7, NOT 8) — закрепляет inclusive upper edge поведение', () => {
		const start = new Date(NOW.getTime() - 7.9 * 86_400_000).toISOString()
		expect(daysBetween(start, NOW)).toBe(7)
	})

	test('zero days same instant → 0', () => {
		const isoNow = NOW.toISOString()
		expect(daysBetween(isoNow, NOW)).toBe(0)
	})

	test('negative days (start in future) → negative integer (not clamped here)', () => {
		const future = new Date(NOW.getTime() + 3 * 86_400_000).toISOString()
		expect(daysBetween(future, NOW)).toBe(-3)
	})

	test('invalid ISO string → throws (loud signal, не silent NaN)', () => {
		expect(() => daysBetween('not-a-date', NOW)).toThrow(/Invalid date/)
	})
})

/* ============================================================ summarizeReceivables */

describe('summarizeReceivables', () => {
	test('empty list → all zeros + averageDays = 0 (no division by zero)', () => {
		const s = summarizeReceivables([], NOW)
		expect(s).toEqual({
			totalOutstandingMinor: 0n,
			totalCount: 0,
			overdueCount: 0,
			averageDaysOutstanding: 0,
			buckets: {
				current: { count: 0, amountMinor: 0n },
				'8to30': { count: 0, amountMinor: 0n },
				'31to60': { count: 0, amountMinor: 0n },
				over60: { count: 0, amountMinor: 0n },
			},
		})
	})

	test('single current folio (3 days) → total=balance, overdue=0, average=3', () => {
		const s = summarizeReceivables([f({ balanceMinor: '500000', daysAgo: 3 })], NOW)
		expect(s.totalOutstandingMinor).toBe(500_000n)
		expect(s.totalCount).toBe(1)
		expect(s.overdueCount).toBe(0)
		expect(s.averageDaysOutstanding).toBe(3)
		expect(s.buckets.current).toEqual({ count: 1, amountMinor: 500_000n })
		expect(s.buckets['8to30']).toEqual({ count: 0, amountMinor: 0n })
	})

	test('mixed buckets: 1×current + 1×8to30 + 1×over60 — KPI exact', () => {
		const folios = [
			f({ balanceMinor: '100000', daysAgo: 5, id: 'a' }), // current
			f({ balanceMinor: '200000', daysAgo: 20, id: 'b' }), // 8to30
			f({ balanceMinor: '300000', daysAgo: 90, id: 'c' }), // over60
		]
		const s = summarizeReceivables(folios, NOW)
		expect(s.totalOutstandingMinor).toBe(600_000n)
		expect(s.totalCount).toBe(3)
		expect(s.overdueCount).toBe(2) // 8to30 + over60 — оба > 7 days
		// average = (5 + 20 + 90) / 3 = 38.333… → round = 38
		expect(s.averageDaysOutstanding).toBe(38)
		expect(s.buckets.current).toEqual({ count: 1, amountMinor: 100_000n })
		expect(s.buckets['8to30']).toEqual({ count: 1, amountMinor: 200_000n })
		expect(s.buckets['31to60']).toEqual({ count: 0, amountMinor: 0n })
		expect(s.buckets.over60).toEqual({ count: 1, amountMinor: 300_000n })
	})

	test('overdue threshold = exactly 8 days (NOT 7) — день 7 НЕ overdue', () => {
		const justOnTime = f({ balanceMinor: '1', daysAgo: 7, id: 'on' })
		const justOverdue = f({ balanceMinor: '1', daysAgo: 8, id: 'over' })
		const s = summarizeReceivables([justOnTime, justOverdue], NOW)
		expect(s.overdueCount).toBe(1) // только the 8-day one
		expect(s.buckets.current.count).toBe(1)
		expect(s.buckets['8to30'].count).toBe(1)
	})

	test('bigint amounts > 2^53 (Int64 safety): 9_000_000_000_000_000n preserved', () => {
		const huge = '9000000000000000' // 9 × 10^15 копеек = 90 трлн ₽
		const s = summarizeReceivables([f({ balanceMinor: huge, daysAgo: 1 })], NOW)
		expect(s.totalOutstandingMinor).toBe(9_000_000_000_000_000n)
		expect(s.buckets.current.amountMinor).toBe(9_000_000_000_000_000n)
	})

	test('clock-skew folio (created in future) → daysOpen clamped to 0', () => {
		const futureFolio = f({ balanceMinor: '1000', daysAgo: -2 })
		const s = summarizeReceivables([futureFolio], NOW)
		expect(s.averageDaysOutstanding).toBe(0)
		expect(s.overdueCount).toBe(0)
		expect(s.buckets.current.count).toBe(1)
	})

	test('all 4 bucket keys ALWAYS present even if empty (UI invariant)', () => {
		const s = summarizeReceivables([], NOW)
		for (const key of ALL_BUCKETS) {
			expect(s.buckets[key]).toEqual({ count: 0, amountMinor: 0n })
		}
	})

	test('order-independence: shuffled input → same summary', () => {
		const folios = [
			f({ balanceMinor: '100', daysAgo: 1, id: 'x' }),
			f({ balanceMinor: '200', daysAgo: 50, id: 'y' }),
			f({ balanceMinor: '300', daysAgo: 100, id: 'z' }),
		]
		const a = summarizeReceivables(folios, NOW)
		const b = summarizeReceivables([...folios].reverse(), NOW)
		expect(a).toEqual(b)
	})
})
