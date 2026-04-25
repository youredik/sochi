/**
 * Strict unit tests for tourism-tax pure functions.
 *
 * Coverage strategy per `feedback_strict_tests.md`:
 *   - Boundary: 0 base / 0 rate / 0 nights / floor exactly equal computed
 *   - Adversarial: negative inputs, fractional inputs, exempt > nights
 *   - Math precision: bigint preserves to last копейка across realistic stay sizes
 *   - Stryker-friendly exact-value asserts on every codepath (no ranges)
 */
import { describe, expect, test } from 'vitest'
import { computeTourismTax, tourismTaxLineId } from './tourism-tax.ts'

describe('computeTourismTax — happy path Сочи 2026 (2%)', () => {
	test('2% × 5000 ₽ × 1 night × 1 room = 100 ₽', () => {
		// base = 500_000 копеек = 5000 ₽; 2% = 100 ₽ = 10_000 коп.
		// Min floor = 100₽ × 1 × 1 = 10_000 коп. Equal → returns either (use computed).
		expect(computeTourismTax(500_000n, 200, 1, 1)).toBe(10_000n)
	})

	test('2% × 25000 ₽ × 5 nights = 500 ₽', () => {
		// 2_500_000 × 200 / 10_000 = 50_000 коп = 500 ₽.
		// Min floor = 100 × 5 × 1 = 500 ₽. Equal again.
		expect(computeTourismTax(2_500_000n, 200, 5, 1)).toBe(50_000n)
	})

	test('2% × 50000 ₽ × 5 nights × 2 rooms = 1000 ₽', () => {
		// 5_000_000 × 200 / 10_000 = 100_000 коп = 1000 ₽.
		// Min floor = 100 × 5 × 2 = 1000 ₽. Equal.
		expect(computeTourismTax(5_000_000n, 200, 5, 2)).toBe(100_000n)
	})

	test('large stay (1M ₽) × 2% = 20000 ₽', () => {
		// 100_000_000 × 200 / 10_000 = 2_000_000 коп = 20 000 ₽.
		expect(computeTourismTax(100_000_000n, 200, 14, 1)).toBe(2_000_000n)
	})
})

describe('computeTourismTax — minimum floor (НК РФ ст. 418.5 п.1)', () => {
	test('cheap room (1000 ₽ × 3 nights) → floor 300 ₽ wins over computed 60 ₽', () => {
		// 100_000 × 3 × 200 / 10_000 = ... actually base=100_000 кoп = 1000₽ × 3 = wait no
		// baseMinor passed = total base, not nightly. So 100_000 кoп = 1000 ₽ TOTAL.
		// Computed = 1000 × 200 / 10_000 = 20 ₽. Floor = 100 × 3 = 300 ₽ → 30_000 коп wins.
		expect(computeTourismTax(100_000n, 200, 3, 1)).toBe(30_000n)
	})

	test('multi-room cheap stay → floor multiplied by rooms', () => {
		// base=200_000 коп = 2000 ₽. Computed = 40 ₽. Floor = 100 × 5 × 2 = 1000 ₽.
		expect(computeTourismTax(200_000n, 200, 5, 2)).toBe(100_000n)
	})

	test('floor exactly equals computed → returns equal value (boundary)', () => {
		// base=500_000 (5000₽) × 2% = 10000 коп = 100₽. Floor = 100₽ × 1 × 1 = 100₽.
		expect(computeTourismTax(500_000n, 200, 1, 1)).toBe(10_000n)
	})

	test('1 кoп over floor → computed wins', () => {
		// Want base × 200 / 10_000 = 10_001? Need base × 200 = 100_010_000... no, work backwards.
		// We want raw = 10_001 коп = 100.01 ₽ before rounding. Half-up to ruble: 100 ₽
		// (remainder 1 < 50), so rounded = 10_000 коп. Floor for 1 night × 1 room = 10_000.
		// Computed == floor. Bumping base higher to overcome rounding:
		// base=502_500 коп → raw=10_050 → rounded=10_100 → > 10_000 floor → wins.
		expect(computeTourismTax(502_500n, 200, 1, 1)).toBe(10_100n)
	})

	test('0 nights → 0 (degenerate, computed and floor both zero)', () => {
		expect(computeTourismTax(500_000n, 200, 0, 1)).toBe(0n)
	})
})

describe('computeTourismTax — exemptions (V1 stub, lands with М8)', () => {
	test('exemptNights=nights → no min floor, only computed', () => {
		// base=100_000, computed = 20₽ = 2000 коп. 3 nights all exempt → floor = 0.
		// Computed (rounded half-up: 2000 % 100 = 0, no shift) = 2000 коп.
		expect(computeTourismTax(100_000n, 200, 3, 1, 3)).toBe(2_000n)
	})

	test('partial exempt → floor reduced by exempt nights', () => {
		// 5 nights, 2 exempt → billableNights=3 × 100₽ × 1 room = 30_000 коп floor.
		// base=100_000 → computed=2000 коп. Floor wins.
		expect(computeTourismTax(100_000n, 200, 5, 1, 2)).toBe(30_000n)
	})

	test('exempt > nights → throw', () => {
		expect(() => computeTourismTax(100_000n, 200, 3, 1, 4)).toThrow(RangeError)
	})
})

describe('computeTourismTax — degenerate cases', () => {
	test('0 base → 0 (no tax on zero revenue, e.g. comp stay)', () => {
		expect(computeTourismTax(0n, 200, 5, 1)).toBe(0n)
	})

	test("0 rate → 0 (region didn't adopt tax)", () => {
		expect(computeTourismTax(500_000n, 0, 5, 1)).toBe(0n)
	})

	test('rate 1% (Сочи 2025) — half of 2026', () => {
		// 5000₽ × 1% = 50₽ = 5000 коп. Floor 100₽ × 1 × 1 = 10_000. Floor wins.
		expect(computeTourismTax(500_000n, 100, 1, 1)).toBe(10_000n)
	})

	test('rate 5% (Сочи 2029+) — terminal year', () => {
		// 5000₽ × 5% = 250₽ = 25_000 коп. Floor 10_000. Computed wins.
		expect(computeTourismTax(500_000n, 500, 1, 1)).toBe(25_000n)
	})
})

describe('computeTourismTax — rounding (НК РФ ст. 52 п.6 half-up)', () => {
	test('exactly 0.50 ₽ rounds UP to ruble', () => {
		// raw = 50 коп, remainder = 50 ≥ 50 → round up to 100.
		// Find base: base × 200 / 10_000 = 50 → base × 200 = 500_000 → base=2500.
		// 2500 × 200 = 500_000 / 10_000 = 50. Round up: 100. Floor=10_000.
		// 100 коп < floor 10_000 → returns floor. Bump nights to 0? then 0.
		// Use 0 floor scenario via exemptNights=nights:
		expect(computeTourismTax(2500n, 200, 1, 1, 1)).toBe(100n)
	})

	test('exactly 0.49 ₽ rounds DOWN to 0 ₽', () => {
		// raw = 49 коп, remainder = 49 < 50 → round to 0.
		// base × 200 = 490_000 → base=2450.
		expect(computeTourismTax(2450n, 200, 1, 1, 1)).toBe(0n)
	})

	test('exactly 0.51 ₽ rounds UP to 1 ₽', () => {
		// raw=51 коп → round up to 100.
		// base × 200 / 10_000 = 51 → base=2550 коп.
		expect(computeTourismTax(2550n, 200, 1, 1, 1)).toBe(100n)
	})

	test('whole ruble — no rounding shift', () => {
		// raw = 50_000 коп = 500 ₽. Remainder 0 → unchanged.
		// base × 200 = 500_000_000 → base=2_500_000. nights=1 → floor=10_000 < computed.
		expect(computeTourismTax(2_500_000n, 200, 1, 1)).toBe(50_000n)
	})

	test('preserves precision for very large base (no overflow)', () => {
		// base = 100_000_000_000n коп = 1 млрд ₽. × 200 = 2e13 — safe for bigint.
		// Computed = 2_000_000_000n коп = 20 млн ₽.
		expect(computeTourismTax(100_000_000_000n, 200, 1, 1)).toBe(2_000_000_000n)
	})
})

describe('computeTourismTax — input validation (adversarial)', () => {
	test('rejects negative baseMinor', () => {
		expect(() => computeTourismTax(-1n, 200, 1, 1)).toThrow(RangeError)
	})

	test('rejects negative rateBp', () => {
		expect(() => computeTourismTax(100_000n, -1, 1, 1)).toThrow(RangeError)
	})

	test('rejects fractional rateBp', () => {
		expect(() => computeTourismTax(100_000n, 1.5, 1, 1)).toThrow(RangeError)
	})

	test('rejects negative nights', () => {
		expect(() => computeTourismTax(100_000n, 200, -1, 1)).toThrow(RangeError)
	})

	test('rejects fractional nights', () => {
		expect(() => computeTourismTax(100_000n, 200, 2.5, 1)).toThrow(RangeError)
	})

	test('rejects 0 rooms (must be at least 1)', () => {
		expect(() => computeTourismTax(100_000n, 200, 1, 0)).toThrow(RangeError)
	})

	test('rejects negative rooms', () => {
		expect(() => computeTourismTax(100_000n, 200, 1, -1)).toThrow(RangeError)
	})

	test('rejects negative exemptNights', () => {
		expect(() => computeTourismTax(100_000n, 200, 5, 1, -1)).toThrow(RangeError)
	})
})

/* ============================================================ tourismTaxLineId */

describe('tourismTaxLineId (deterministic)', () => {
	test('produces stable id for same bookingId', () => {
		expect(tourismTaxLineId('book_01ABC')).toBe('tax_book_01ABC')
		expect(tourismTaxLineId('book_01ABC')).toBe(tourismTaxLineId('book_01ABC'))
	})

	test('different bookings produce different ids', () => {
		expect(tourismTaxLineId('book_01A')).not.toBe(tourismTaxLineId('book_01B'))
	})
})
