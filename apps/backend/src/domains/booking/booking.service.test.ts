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
 *
 * M4e — Tourism tax (НК РФ ст.418.5), example-based:
 *   [TT1] Sochi 2026 rate 200 bps × 2 nights × 5000₽ → 2% proportional
 *   [TT2] Low-base booking → ₽100/night floor kicks in, proportional loses
 *   [TT3] High-base booking → proportional wins over floor
 *   [TT4] rateBps=null (opt-out) → 0n, floor NOT applied
 *   [TT5] nightsCount=0 → 0n
 *   [TT6] rateBps=0 with nights>0 → floor still applies (literal NK reading)
 *   [TT7] 2027 federal-roadmap rate 300 bps future-proofing
 *
 * M4e — Tourism tax, property-based:
 *   [TTP1] result = max(proportional, floor) ALWAYS when rateBps !== null
 *   [TTP2] rateBps=null invariant: tax is 0n across entire input space
 *   [TTP3] nightsCount ≤ 0 invariant: tax is 0n across entire input space
 *   [TTP4] monotonicity: doubling nights never decreases tax
 *
 * M4e — Registration status derivation:
 *   [DR1] RU citizenship → 'notRequired'
 *   [DR2] RUS (ISO alpha-3) → 'pending' (documented limitation — alpha-3 not mapped)
 *   [DR3] Case-insensitive for 'RU'
 *   [DR4] 9 foreign countries → all 'pending'
 */

import { fc, test as pbTest } from '@fast-check/vitest'
import type { RatePlan } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import {
	computeCancellationFeeSnapshot,
	computeNoShowFeeSnapshot,
	computeTourismTax,
	deriveRegistrationStatus,
} from './booking.service.ts'

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

// ----------------------------------------------------------------------------
// M4e: tourism tax (НК РФ ст.418.5) + registration status derivation
// ----------------------------------------------------------------------------

describe('computeTourismTax (НК РФ ст.418.5) — example-based', () => {
	test('[TT1] Sochi 2026 rate 200 bps on 2 nights × 5000 ₽ → 2% proportional', () => {
		// 2 nights × 5000₽ = 10_000₽ = 10_000_000_000 micros. 2% → 200_000_000 micros (200₽).
		// Floor: 100₽ × 2 = 200_000_000 micros. Proportional == floor → returns either.
		const tax = computeTourismTax(10_000_000_000n, 200, 2)
		expect(tax).toBe(200_000_000n)
	})

	test('[TT2] low-base booking: floor kicks in (min ₽100/night)', () => {
		// 2 nights × 1000₽ = 2_000_000_000 micros. 2% → 40_000_000 micros (40₽).
		// Floor: 100₽ × 2 = 200_000_000 micros (200₽). Floor wins.
		const tax = computeTourismTax(2_000_000_000n, 200, 2)
		expect(tax).toBe(200_000_000n)
	})

	test('[TT3] high-base booking: proportional wins over floor', () => {
		// 3 nights × 20_000₽ = 60_000_000_000 micros. 2% → 1_200_000_000 micros (1200₽).
		// Floor: 100₽ × 3 = 300_000_000 micros. Proportional wins.
		const tax = computeTourismTax(60_000_000_000n, 200, 3)
		expect(tax).toBe(1_200_000_000n)
	})

	test('[TT4] rateBps=null (property not configured) → 0n, floor NOT applied', () => {
		expect(computeTourismTax(10_000_000_000n, null, 5)).toBe(0n)
	})

	test('[TT5] nightsCount=0 (same-day booking) → 0n', () => {
		expect(computeTourismTax(10_000_000_000n, 200, 0)).toBe(0n)
	})

	test('[TT6] rateBps=0 with non-zero nights → floor still applies (literal НК reading)', () => {
		// Intentional: a municipality that explicitly sets 0% still imposes the
		// federal ₽100/night floor. Operator must opt-out via rateBps=null.
		expect(computeTourismTax(10_000_000_000n, 0, 3)).toBe(300_000_000n)
	})

	test('[TT7] 2027 rate 300 bps (federal roadmap) — future-proof', () => {
		// 10 nights × 10_000₽ = 100_000_000_000. 3% → 3_000_000_000 micros.
		expect(computeTourismTax(100_000_000_000n, 300, 10)).toBe(3_000_000_000n)
	})
})

const rateBpsArb = fc.integer({ min: 0, max: 500 }) // 0..5% per federal roadmap
const nightsArb = fc.integer({ min: 1, max: 365 })

describe('computeTourismTax — property-based', () => {
	pbTest.prop([totalMicrosArb, rateBpsArb, nightsArb])(
		'[TTP1] result is ALWAYS max(proportional, floor) when rateBps !== null',
		(base, rateBps, nights) => {
			const tax = computeTourismTax(base, rateBps, nights)
			const proportional = (base * BigInt(rateBps)) / 10_000n
			const floor = 100_000_000n * BigInt(nights)
			expect(tax).toBe(proportional > floor ? proportional : floor)
		},
	)

	pbTest.prop([totalMicrosArb, nightsArb])(
		'[TTP2] rateBps=null invariant: tax is ALWAYS 0n, regardless of base/nights',
		(base, nights) => {
			expect(computeTourismTax(base, null, nights)).toBe(0n)
		},
	)

	pbTest.prop([totalMicrosArb, rateBpsArb])(
		'[TTP3] nightsCount ≤ 0 invariant: tax is ALWAYS 0n (no stay → no liability)',
		(base, rateBps) => {
			expect(computeTourismTax(base, rateBps, 0)).toBe(0n)
			expect(computeTourismTax(base, rateBps, -1)).toBe(0n)
		},
	)

	pbTest.prop([totalMicrosArb, rateBpsArb, nightsArb])(
		'[TTP4] monotonicity in nights: doubling nights ≥ previous tax (floor scales or prop unchanged)',
		(base, rateBps, nights) => {
			const tax1 = computeTourismTax(base, rateBps, nights)
			const tax2 = computeTourismTax(base, rateBps, nights * 2)
			expect(tax2 >= tax1).toBe(true)
		},
	)
})

describe('deriveRegistrationStatus', () => {
	test('[DR1] RU citizenship → notRequired', () => {
		expect(deriveRegistrationStatus('RU')).toBe('notRequired')
	})
	test('[DR2] RUS (ISO alpha-3) — currently treated as foreign (spec calls alpha-2 default)', () => {
		// This is a known limitation: we normalize to uppercase but don't
		// map alpha-3 → alpha-2. Admin UI validates alpha-2 for RU on input.
		// Test documents the current behavior so any future fix is intentional.
		expect(deriveRegistrationStatus('RUS')).toBe('pending')
	})
	test('[DR3] case-insensitive for RU', () => {
		expect(deriveRegistrationStatus('ru')).toBe('notRequired')
		expect(deriveRegistrationStatus('Ru')).toBe('notRequired')
	})
	test('[DR4] every non-RU citizenship → pending', () => {
		for (const code of ['US', 'DE', 'CN', 'KZ', 'BY', 'FR', 'JP', 'IT', 'ES']) {
			expect(deriveRegistrationStatus(code)).toBe('pending')
		}
	})
})
