/**
 * Booking service — pure-function unit tests for fee snapshot computation.
 *
 * Business invariants (example-based):
 *   [F1] Non-refundable plan → 100% fee, no dueDate, policyCode='nonRefundable'
 *   [F2] Refundable+cancellationHours → 100% fee, dueDate = checkIn minus
 *        cancellationHours (UTC), policyCode='flexible'
 *   [F3] Refundable plan with cancellationHours=null (edge case) → treated as
 *        non-refundable (defensive: don't let bad data produce unbounded grace)
 *   [F4] policyVersion always reflects ratePlan.updatedAt at snapshot time
 *   [F5] Currency roundtrips from ratePlan into both fee snapshots
 *   [F6] No-show fee is ALWAYS 100%, ALWAYS null dueDate, policyCode='standardNoShow'
 *   [F7] Boundary: cancellationHours=0 → dueDate = checkIn date itself
 *   [F8] Large cancellationHours crosses calendar day boundary correctly
 *
 * Property-based (fuzz over the input space — catches boundary classes that
 * example-based tests miss):
 *   [FP1] Non-refundable branch: ANY (total, rp, date) → fee=total,
 *         dueDate=null, code='nonRefundable', currency+version pass-through.
 *   [FP2] Flexible branch: ANY (total, hours∈[0,720], date) → fee=total,
 *         dueDate = date minus hours (UTC, date-resolution), code='flexible'.
 *   [FP3] No-show: ANY (total, rp) → fee=total, dueDate=null,
 *         code='standardNoShow', independent of isRefundable / hours.
 *   [FP4] policyVersion is always `ratePlan.updatedAt` verbatim — no mutation.
 */

import { fc, test as pbTest } from '@fast-check/vitest'
import type { RatePlan } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import { computeCancellationFeeSnapshot, computeNoShowFeeSnapshot } from './booking.service.ts'

function mkRp(over: Partial<RatePlan> = {}): RatePlan {
	return {
		id: 'rp_test',
		tenantId: 'org_test',
		propertyId: 'prop_test',
		roomTypeId: 'rmt_test',
		name: 'BAR Flexible',
		code: 'BAR',
		isDefault: true,
		isRefundable: true,
		cancellationHours: 24,
		mealsIncluded: 'none',
		minStay: 1,
		maxStay: null,
		currency: 'RUB',
		isActive: true,
		createdAt: '2026-05-01T10:00:00.000Z',
		updatedAt: '2026-05-15T14:30:00.123Z',
		...over,
	}
}

describe('booking.service — computeCancellationFeeSnapshot', () => {
	test('[F1,F4,F5] non-refundable: 100% fee, no dueDate, policyVersion=updatedAt', () => {
		const rp = mkRp({ isRefundable: false, cancellationHours: null })
		const snap = computeCancellationFeeSnapshot(12_000_000_000n, rp, '2026-07-15')
		expect(snap).toEqual({
			amountMicros: 12_000_000_000n,
			currency: 'RUB',
			dueDate: null,
			policyCode: 'nonRefundable',
			policyVersion: '2026-05-15T14:30:00.123Z',
		})
	})

	test('[F2] refundable 24h: dueDate = checkIn - 24h (UTC), policyCode=flexible', () => {
		const rp = mkRp({ isRefundable: true, cancellationHours: 24 })
		const snap = computeCancellationFeeSnapshot(12_000_000_000n, rp, '2026-07-15')
		expect(snap.dueDate).toBe('2026-07-14')
		expect(snap.policyCode).toBe('flexible')
		expect(snap.amountMicros).toBe(12_000_000_000n)
	})

	test('[F3] refundable with cancellationHours=null falls through to non-refundable policy', () => {
		const rp = mkRp({ isRefundable: true, cancellationHours: null })
		const snap = computeCancellationFeeSnapshot(5_000_000_000n, rp, '2026-08-01')
		expect(snap.policyCode).toBe('nonRefundable')
		expect(snap.dueDate).toBeNull()
	})

	test('[F5] currency from ratePlan propagates: EUR case', () => {
		const rp = mkRp({ currency: 'EUR', isRefundable: true, cancellationHours: 48 })
		const snap = computeCancellationFeeSnapshot(9_000_000_000n, rp, '2027-01-10')
		expect(snap.currency).toBe('EUR')
	})

	test('[F7] boundary: cancellationHours=0 → dueDate equals checkIn date itself', () => {
		const rp = mkRp({ cancellationHours: 0 })
		const snap = computeCancellationFeeSnapshot(1_000_000n, rp, '2026-09-20')
		expect(snap.dueDate).toBe('2026-09-20')
	})

	test('[F8] cancellationHours=72 crosses 3 calendar days backwards', () => {
		const rp = mkRp({ cancellationHours: 72 })
		const snap = computeCancellationFeeSnapshot(1_000_000n, rp, '2026-09-20')
		expect(snap.dueDate).toBe('2026-09-17')
	})

	test('[F8-rollover] cancellationHours crossing month boundary', () => {
		const rp = mkRp({ cancellationHours: 24 * 3 })
		const snap = computeCancellationFeeSnapshot(1_000_000n, rp, '2026-03-02')
		// 2026 is not a leap year → Feb has 28 days
		expect(snap.dueDate).toBe('2026-02-27')
	})

	test('[F4] policyVersion tracks ratePlan.updatedAt literally', () => {
		const rp = mkRp({ updatedAt: '2027-11-11T23:59:59.999Z' })
		const snap = computeCancellationFeeSnapshot(0n, rp, '2028-01-01')
		expect(snap.policyVersion).toBe('2027-11-11T23:59:59.999Z')
	})
})

describe('booking.service — computeNoShowFeeSnapshot', () => {
	test('[F6] always 100% fee, null dueDate, policyCode=standardNoShow', () => {
		const rp = mkRp({ currency: 'USD', updatedAt: '2026-12-01T00:00:00.000Z' })
		const snap = computeNoShowFeeSnapshot(50_000_000_000n, rp)
		expect(snap).toEqual({
			amountMicros: 50_000_000_000n,
			currency: 'USD',
			dueDate: null,
			policyCode: 'standardNoShow',
			policyVersion: '2026-12-01T00:00:00.000Z',
		})
	})

	test('[F6] zero-amount booking (edge) still emits 100% fee = 0n, not null', () => {
		const rp = mkRp()
		const snap = computeNoShowFeeSnapshot(0n, rp)
		expect(snap.amountMicros).toBe(0n)
		expect(snap.policyCode).toBe('standardNoShow')
	})
})

// ----------------------------------------------------------------------------
// Property-based fuzz tests — cover the input space beyond hand-rolled examples.
// ----------------------------------------------------------------------------

/** Money micros under Int64 max, sized for realistic hotel bookings. */
const totalMicrosArb = fc.bigInt({ min: 0n, max: 900_000_000_000_000n })

/** ISO-4217 currency — any valid 3-letter uppercase ASCII is acceptable shape-wise. */
const currencyArb = fc
	.string({ minLength: 3, maxLength: 3, unit: 'grapheme-ascii' })
	.map((s) => s.toUpperCase().replace(/[^A-Z]/g, 'X'))

const MS_PER_DAY = 86_400_000

/** ISO-8601 datetime string, preserved verbatim by the snapshot functions. */
// fast-check 4.x `fc.date({min,max})` intermittently produces out-of-range
// dates under certain seeds (empirically caught: a seed that ignored max and
// drove toISOString into the extended-year branch, e.g. "+275761-...").
// Integer-over-epoch-ms avoids the sharp edge — millisecond granularity is
// narrow enough for invariant tests.
const updatedAtArb = fc
	.integer({
		min: Date.parse('2024-01-01T00:00:00Z'),
		max: Date.parse('2030-12-31T23:59:59Z'),
	})
	.map((ms) => new Date(ms).toISOString())

/** YYYY-MM-DD within a sane booking horizon. */
const checkInDateArb = fc
	.integer({
		min: Math.floor(Date.parse('2026-01-01T00:00:00Z') / MS_PER_DAY),
		max: Math.floor(Date.parse('2030-12-31T00:00:00Z') / MS_PER_DAY),
	})
	.map((day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10))

/** cancellationHours ∈ [0, 720] per ratePlanSchema (max 30 days). */
const cancellationHoursArb = fc.integer({ min: 0, max: 720 })

/**
 * Arbitrary FeePolicySource-shaped input (only the 4 fields the compute
 * functions actually read). Fuzz over refundable × (null | hours ∈ [0,720]).
 */
const policySourceArb = fc.record({
	isRefundable: fc.boolean(),
	cancellationHours: fc.oneof(cancellationHoursArb, fc.constant(null)),
	currency: currencyArb,
	updatedAt: updatedAtArb,
})

describe('computeCancellationFeeSnapshot — property-based', () => {
	pbTest.prop([totalMicrosArb, currencyArb, updatedAtArb, checkInDateArb])(
		'[FP1] non-refundable branch invariants hold for ALL inputs',
		(total, currency, updatedAt, checkIn) => {
			const rp = mkRp({ isRefundable: false, cancellationHours: null, currency, updatedAt })
			const snap = computeCancellationFeeSnapshot(total, rp, checkIn)
			expect(snap.amountMicros).toBe(total)
			expect(snap.dueDate).toBeNull()
			expect(snap.policyCode).toBe('nonRefundable')
			expect(snap.currency).toBe(currency)
			expect(snap.policyVersion).toBe(updatedAt)
		},
	)

	pbTest.prop([totalMicrosArb, cancellationHoursArb, currencyArb, updatedAtArb, checkInDateArb])(
		'[FP2] flexible branch: dueDate = checkIn minus cancellationHours (UTC day)',
		(total, hours, currency, updatedAt, checkIn) => {
			const rp = mkRp({
				isRefundable: true,
				cancellationHours: hours,
				currency,
				updatedAt,
			})
			const snap = computeCancellationFeeSnapshot(total, rp, checkIn)
			expect(snap.amountMicros).toBe(total)
			expect(snap.policyCode).toBe('flexible')
			expect(snap.currency).toBe(currency)
			expect(snap.policyVersion).toBe(updatedAt)
			// Recompute the expected dueDate using the same UTC-arithmetic the
			// implementation uses — fuzz guards against day/month/year rollover.
			const expected = new Date(`${checkIn}T00:00:00Z`)
			expected.setUTCHours(expected.getUTCHours() - hours)
			expect(snap.dueDate).toBe(expected.toISOString().slice(0, 10))
		},
	)

	pbTest.prop([totalMicrosArb, policySourceArb, checkInDateArb])(
		'[FP4] policyVersion ALWAYS equals ratePlan.updatedAt verbatim',
		(total, policy, checkIn) => {
			const rp = mkRp(policy)
			const snap = computeCancellationFeeSnapshot(total, rp, checkIn)
			expect(snap.policyVersion).toBe(policy.updatedAt)
		},
	)

	pbTest.prop([totalMicrosArb, policySourceArb, checkInDateArb])(
		'[FP-invariant] amountMicros is ALWAYS exactly totalMicros (never partial)',
		(total, policy, checkIn) => {
			const rp = mkRp(policy)
			const snap = computeCancellationFeeSnapshot(total, rp, checkIn)
			expect(snap.amountMicros).toBe(total)
		},
	)
})

describe('computeNoShowFeeSnapshot — property-based', () => {
	pbTest.prop([totalMicrosArb, policySourceArb])(
		'[FP3] ALL inputs produce fee=total, dueDate=null, code=standardNoShow',
		(total, policy) => {
			const rp = mkRp(policy)
			const snap = computeNoShowFeeSnapshot(total, rp)
			expect(snap.amountMicros).toBe(total)
			expect(snap.dueDate).toBeNull()
			expect(snap.policyCode).toBe('standardNoShow')
			expect(snap.currency).toBe(policy.currency)
			expect(snap.policyVersion).toBe(policy.updatedAt)
		},
	)
})
