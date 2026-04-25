/**
 * Strict tests for folio-balance.ts pure money math.
 *
 * Invariants under test (cross-referenced to memory canon):
 *   [M1-M5] microsToMinor — round-half-up boundaries + negatives + zero
 *   [L1-L3] minorToMicros — exact + round-trip
 *   [C1-C7] computeChargesMinor — only posted lines, void/draft excluded,
 *           negatives decrement, order independence (invariant #12 partial)
 *   [A1-A3] computeAccommodationBaseMinor — flag honored, sub-state filter
 *   [T1-T11] computeTourismTaxMinor — floor binds / rate binds / Сочи 2026 /
 *            adversarial negatives + property invariants
 *   [B1-B4] computeBalanceMinor — exact value + sign + property cancellation
 *   [P1-P4] applyPayment / applyRefund — sub/add + negative-input rejection
 *           + property: applyPayment(applyRefund(b, x), x) === b
 *   [V1-V2] verifyBalanceConservation — null on match / diff on drift
 *
 * Style: exact-value asserts, adversarial negatives, property-based via
 * fast-check (integer-over-epoch generators per `project_fastcheck_gotchas.md`).
 */
import { fc, test } from '@fast-check/vitest'
import type { FolioLine } from '@horeca/shared'
import { describe, expect, test as vitestTest } from 'vitest'
import {
	applyPayment,
	applyRefund,
	computeAccommodationBaseMinor,
	computeBalanceMinor,
	computeChargesMinor,
	computeTourismTaxMinor,
	microsToMinor,
	minorToMicros,
	verifyBalanceConservation,
} from './folio-balance.ts'

/* ==================================================================== helpers */

type LineArgs = Partial<FolioLine> & {
	amountMinor: string
	lineStatus: FolioLine['lineStatus']
	isAccommodationBase?: boolean
}

function line(
	args: LineArgs,
): Pick<FolioLine, 'amountMinor' | 'lineStatus' | 'isAccommodationBase'> {
	return {
		amountMinor: args.amountMinor,
		lineStatus: args.lineStatus,
		isAccommodationBase: args.isAccommodationBase ?? false,
	}
}

/* ============================================================== microsToMinor */

describe('microsToMinor — boundary + sign', () => {
	vitestTest('[M1] zero → zero', () => {
		expect(microsToMinor(0n)).toBe(0n)
	})

	vitestTest('[M2] round-half-up positive boundaries', () => {
		// 1 копейка = 10_000 micros; half = 5_000
		expect(microsToMinor(4_999n)).toBe(0n)
		expect(microsToMinor(5_000n)).toBe(1n)
		expect(microsToMinor(5_001n)).toBe(1n)
		expect(microsToMinor(9_999n)).toBe(1n)
		expect(microsToMinor(10_000n)).toBe(1n)
		expect(microsToMinor(14_999n)).toBe(1n)
		expect(microsToMinor(15_000n)).toBe(2n)
		expect(microsToMinor(15_001n)).toBe(2n)
	})

	vitestTest('[M3] round-half-up negative (away from zero)', () => {
		expect(microsToMinor(-4_999n)).toBe(0n)
		expect(microsToMinor(-5_000n)).toBe(-1n)
		expect(microsToMinor(-9_999n)).toBe(-1n)
		expect(microsToMinor(-15_000n)).toBe(-2n)
		expect(microsToMinor(-15_001n)).toBe(-2n)
	})

	vitestTest('[M4] realistic RUB amount conversion', () => {
		// 5000.50 RUB → 5_000_500_000 micros → 500_050 копейки
		expect(microsToMinor(5_000_500_000n)).toBe(500_050n)
		// 1234.56 RUB → 1_234_560_000 micros → 123_456 копейки
		expect(microsToMinor(1_234_560_000n)).toBe(123_456n)
	})

	vitestTest('[M5] near-Int64-max does not overflow JS BigInt', () => {
		const huge = 9_000_000_000_000_000_000n // 9e18 micros
		expect(microsToMinor(huge)).toBe(900_000_000_000_000n)
	})
})

/* ============================================================== minorToMicros */

describe('minorToMicros — exact', () => {
	vitestTest('[L1] exact ×10000 (no rounding loss)', () => {
		expect(minorToMicros(0n)).toBe(0n)
		expect(minorToMicros(1n)).toBe(10_000n)
		expect(minorToMicros(100n)).toBe(1_000_000n) // 1 RUB
		expect(minorToMicros(123_456n)).toBe(1_234_560_000n) // 1234.56 RUB
		expect(minorToMicros(-50n)).toBe(-500_000n)
	})

	vitestTest('[L2] round-trip: minor → micros → minor preserves value', () => {
		for (const v of [0n, 1n, 100n, 12_345n, -67_890n, 9_999_999_999n]) {
			expect(microsToMinor(minorToMicros(v))).toBe(v)
		}
	})

	const minorArb = fc.bigInt({
		min: -10_000_000_000_000n,
		max: 10_000_000_000_000n,
	})

	test.prop([minorArb])('[L3] round-trip property (random bigints)', (v) => {
		expect(microsToMinor(minorToMicros(v))).toBe(v)
	})
})

/* ========================================================== computeChargesMinor */

describe('computeChargesMinor — sub-state filter + sum', () => {
	vitestTest('[C1] empty array → 0', () => {
		expect(computeChargesMinor([])).toBe(0n)
	})

	vitestTest('[C2] only posted lines summed', () => {
		const lines = [
			line({ amountMinor: '500', lineStatus: 'posted' }),
			line({ amountMinor: '300', lineStatus: 'posted' }),
		]
		expect(computeChargesMinor(lines)).toBe(800n)
	})

	vitestTest('[C3] draft lines NEVER counted', () => {
		const lines = [
			line({ amountMinor: '500', lineStatus: 'posted' }),
			line({ amountMinor: '999999', lineStatus: 'draft' }),
		]
		expect(computeChargesMinor(lines)).toBe(500n)
	})

	vitestTest('[C4] void lines NEVER counted', () => {
		const lines = [
			line({ amountMinor: '500', lineStatus: 'posted' }),
			line({ amountMinor: '999999', lineStatus: 'void' }),
		]
		expect(computeChargesMinor(lines)).toBe(500n)
	})

	vitestTest('[C5] negative-amount posted lines (reversals) decrement', () => {
		const lines = [
			line({ amountMinor: '1000', lineStatus: 'posted' }),
			line({ amountMinor: '-300', lineStatus: 'posted' }),
		]
		expect(computeChargesMinor(lines)).toBe(700n)
	})

	const lineArb = fc.record({
		amountMinor: fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }).map((n) => n.toString()),
		lineStatus: fc.constantFrom<FolioLine['lineStatus']>('draft', 'posted', 'void'),
	})

	test.prop([fc.array(lineArb, { maxLength: 50 })])(
		'[C6] sum equals manual reduce of posted-only',
		(lines) => {
			const expected = lines
				.filter((l) => l.lineStatus === 'posted')
				.reduce((acc, l) => acc + BigInt(l.amountMinor), 0n)
			expect(computeChargesMinor(lines)).toBe(expected)
		},
	)

	test.prop([fc.array(lineArb, { maxLength: 30 })])(
		'[C7] order-independent (sum is commutative)',
		(lines) => {
			const reversed = [...lines].reverse()
			expect(computeChargesMinor(lines)).toBe(computeChargesMinor(reversed))
		},
	)
})

/* ============================================== computeAccommodationBaseMinor */

describe('computeAccommodationBaseMinor — flag + sub-state filter', () => {
	vitestTest('[A1] only posted+isAccommodationBase=true counted', () => {
		const lines = [
			line({ amountMinor: '5000', lineStatus: 'posted', isAccommodationBase: true }),
			line({ amountMinor: '300', lineStatus: 'posted', isAccommodationBase: true }),
			line({ amountMinor: '999', lineStatus: 'posted', isAccommodationBase: false }),
		]
		expect(computeAccommodationBaseMinor(lines)).toBe(5300n)
	})

	vitestTest('[A2] posted+isAccommodationBase=false → not counted', () => {
		const lines = [line({ amountMinor: '500', lineStatus: 'posted', isAccommodationBase: false })]
		expect(computeAccommodationBaseMinor(lines)).toBe(0n)
	})

	vitestTest('[A3] draft+isAccommodationBase=true → not counted', () => {
		const lines = [line({ amountMinor: '500', lineStatus: 'draft', isAccommodationBase: true })]
		expect(computeAccommodationBaseMinor(lines)).toBe(0n)
	})
})

/* =========================================================== computeTourismTaxMinor */

describe('computeTourismTaxMinor — НК РФ ст.418.5 + Сочи 2026', () => {
	const FLOOR_PER_NIGHT = 10_000n // 100₽ = 10_000 копейки

	vitestTest('[T1] floor binds when proportional < floor', () => {
		// 1000 копейки base × 200 bps (2%) = 20 копейки proportional;
		// floor for 1 night = 10_000 копейки → floor wins.
		const tax = computeTourismTaxMinor({
			accommodationBaseMinor: 1_000n,
			rateBps: 200,
			nights: 1,
		})
		expect(tax).toBe(FLOOR_PER_NIGHT)
	})

	vitestTest('[T2] rate binds when proportional > floor', () => {
		// 1_000_000 копейки (10_000 RUB) × 200 bps = 20_000 копейки;
		// floor 1 night = 10_000 → rate wins.
		const tax = computeTourismTaxMinor({
			accommodationBaseMinor: 1_000_000n,
			rateBps: 200,
			nights: 1,
		})
		expect(tax).toBe(20_000n)
	})

	vitestTest('[T3] zero base + zero nights → 0', () => {
		expect(computeTourismTaxMinor({ accommodationBaseMinor: 0n, rateBps: 200, nights: 0 })).toBe(0n)
	})

	vitestTest('[T4] zero base + 1 night → floor (₽100)', () => {
		expect(computeTourismTaxMinor({ accommodationBaseMinor: 0n, rateBps: 200, nights: 1 })).toBe(
			FLOOR_PER_NIGHT,
		)
	})

	vitestTest('[T5] rateBps=0 + nights>0 → floor (zero rate, but per-night minimum applies)', () => {
		expect(
			computeTourismTaxMinor({ accommodationBaseMinor: 100_000n, rateBps: 0, nights: 3 }),
		).toBe(FLOOR_PER_NIGHT * 3n)
	})

	vitestTest('[T6] Сочи 2026: 5000₽/night × 2% × 1 night = ₽100 (floor = rate exactly)', () => {
		// 5000₽ = 500_000 копейки; × 200 bps / 10000 = 10_000 копейки = ₽100
		const tax = computeTourismTaxMinor({
			accommodationBaseMinor: 500_000n,
			rateBps: 200,
			nights: 1,
		})
		expect(tax).toBe(FLOOR_PER_NIGHT) // both branches return the same number
	})

	vitestTest('[T7] negative nights throws RangeError with diagnostic message', () => {
		expect(() =>
			computeTourismTaxMinor({ accommodationBaseMinor: 100n, rateBps: 200, nights: -1 }),
		).toThrow(/nights must be >= 0, got -1/)
	})

	vitestTest('[T8] negative rateBps throws RangeError with diagnostic message', () => {
		expect(() =>
			computeTourismTaxMinor({ accommodationBaseMinor: 100n, rateBps: -1, nights: 1 }),
		).toThrow(/rateBps must be >= 0, got -1/)
	})

	vitestTest('[T9] negative base throws RangeError with diagnostic message', () => {
		expect(() =>
			computeTourismTaxMinor({ accommodationBaseMinor: -1n, rateBps: 200, nights: 1 }),
		).toThrow(/accommodationBaseMinor must be >= 0, got -1/)
	})

	const validTaxArgsArb = fc.record({
		accommodationBaseMinor: fc.bigInt({ min: 0n, max: 100_000_000n }), // up to ~1M RUB
		rateBps: fc.integer({ min: 0, max: 500 }), // 0-5%
		nights: fc.integer({ min: 0, max: 90 }),
	})

	test.prop([validTaxArgsArb])('[T10] property: tax >= floor × nights', (args) => {
		expect(computeTourismTaxMinor(args)).toBeGreaterThanOrEqual(
			FLOOR_PER_NIGHT * BigInt(args.nights),
		)
	})

	test.prop([validTaxArgsArb])('[T11] property: tax >= base × rateBps / 10000', (args) => {
		const proportional = (args.accommodationBaseMinor * BigInt(args.rateBps)) / 10_000n
		expect(computeTourismTaxMinor(args)).toBeGreaterThanOrEqual(proportional)
	})
})

/* ============================================================ computeBalanceMinor */

describe('computeBalanceMinor — exact arithmetic', () => {
	vitestTest('[B1] zero everything → 0', () => {
		expect(
			computeBalanceMinor({
				chargesMinor: 0n,
				paymentsAppliedMinor: 0n,
				refundsAppliedMinor: 0n,
			}),
		).toBe(0n)
	})

	vitestTest('[B2] charges - payments + refunds (exact)', () => {
		expect(
			computeBalanceMinor({
				chargesMinor: 1000n,
				paymentsAppliedMinor: 600n,
				refundsAppliedMinor: 100n,
			}),
		).toBe(500n)
	})

	vitestTest('[B3] negative balance = overpayment / credit', () => {
		// Guest paid 1500, only owed 1000 → -500 (we owe them back)
		expect(
			computeBalanceMinor({
				chargesMinor: 1000n,
				paymentsAppliedMinor: 1500n,
				refundsAppliedMinor: 0n,
			}),
		).toBe(-500n)
	})

	const balanceArb = fc.record({
		chargesMinor: fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
		paymentsAppliedMinor: fc.bigInt({ min: 0n, max: 1_000_000n }),
		refundsAppliedMinor: fc.bigInt({ min: 0n, max: 1_000_000n }),
	})

	test.prop([balanceArb])('[B4] property: equal payment & refund cancel', ({ chargesMinor }) => {
		const x = 12_345n
		const a = computeBalanceMinor({
			chargesMinor,
			paymentsAppliedMinor: x,
			refundsAppliedMinor: x,
		})
		expect(a).toBe(chargesMinor)
	})
})

/* ===================================================== applyPayment / applyRefund */

describe('applyPayment / applyRefund — sign + invariants', () => {
	vitestTest('[P1] applyPayment subtracts', () => {
		expect(applyPayment(1000n, 300n)).toBe(700n)
		expect(applyPayment(0n, 100n)).toBe(-100n) // overpay -> negative
	})

	vitestTest('[P2] applyRefund adds', () => {
		expect(applyRefund(-100n, 100n)).toBe(0n)
		expect(applyRefund(1000n, 250n)).toBe(1250n)
	})

	vitestTest('[P3] negative input throws (invariant #20) with diagnostic message', () => {
		expect(() => applyPayment(0n, -1n)).toThrow(/paymentMinor must be >= 0, got -1/)
		expect(() => applyRefund(0n, -1n)).toThrow(/refundMinor must be >= 0, got -1/)
	})

	vitestTest('[P3b] zero amount is allowed (boundary: distinguishes < from <=)', () => {
		// `applyPayment(b, 0n)` MUST NOT throw — zero-amount no-op (e.g. webhook
		// idempotent replay where capture amount was already applied). This kills
		// the `< 0n` → `<= 0n` mutation: with `<=`, zero would erroneously throw.
		expect(applyPayment(500n, 0n)).toBe(500n)
		expect(applyRefund(500n, 0n)).toBe(500n)
	})

	const inverseArb = fc.tuple(
		fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
		fc.bigInt({ min: 0n, max: 1_000_000n }),
	)

	test.prop([inverseArb])(
		'[P4] property: applyPayment(applyRefund(b, x), x) === b',
		([balance, x]) => {
			expect(applyPayment(applyRefund(balance, x), x)).toBe(balance)
		},
	)

	test.prop([inverseArb])(
		'[P4b] property: applyRefund(applyPayment(b, x), x) === b',
		([balance, x]) => {
			expect(applyRefund(applyPayment(balance, x), x)).toBe(balance)
		},
	)
})

/* ============================================== verifyBalanceConservation */

describe('verifyBalanceConservation — drift detector', () => {
	vitestTest('[V1] returns null when stored matches computed', () => {
		const lines = [
			line({ amountMinor: '1000', lineStatus: 'posted' }),
			line({ amountMinor: '500', lineStatus: 'posted' }),
		]
		// charges=1500, paid=600, refunded=100 → balance=1000
		expect(
			verifyBalanceConservation({
				storedBalanceMinor: 1000n,
				lines,
				paymentsAppliedMinor: 600n,
				refundsAppliedMinor: 100n,
			}),
		).toBeNull()
	})

	vitestTest('[V2] returns diff when stored != computed', () => {
		const lines = [line({ amountMinor: '1000', lineStatus: 'posted' })]
		// charges=1000, paid=0, refunded=0 → computed=1000; stored claims 800
		const diff = verifyBalanceConservation({
			storedBalanceMinor: 800n,
			lines,
			paymentsAppliedMinor: 0n,
			refundsAppliedMinor: 0n,
		})
		expect(diff).toEqual({ stored: 800n, computed: 1000n, delta: -200n })
	})
})
