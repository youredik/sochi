/**
 * Booking service — pure-function unit tests for fee snapshot computation.
 *
 * Business invariants:
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
 */
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
