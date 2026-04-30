/**
 * Strict tests для addon-pricing.ts pure helpers (M9.widget.3).
 *
 * Per `feedback_strict_tests.md` canon:
 *   - Exact-value asserts (NOT >=)
 *   - Adversarial negative paths (negative inputs, malformed strings, etc.)
 *   - Enum FULL coverage (every AddonPricingUnit roundtrips)
 *   - VAT layering verified across multiple rates
 */
import { describe, expect, test } from 'vitest'
import {
	type AddonCartEntry,
	addonGrossKopecks,
	addonNetKopecks,
	addonQtyBounds,
	addonVatKopecks,
	cartGrossTotalKopecks,
	deserializeCart,
	getCartQuantity,
	serializeCart,
	setCartQuantity,
} from './addon-pricing.ts'
import type { PublicWidgetAddon } from './widget-api.ts'

const breakfast: PublicWidgetAddon = {
	addonId: 'addn_brk',
	code: 'BREAKFAST',
	category: 'FOOD_AND_BEVERAGES',
	nameRu: 'Завтрак',
	nameEn: null,
	descriptionRu: null,
	descriptionEn: null,
	pricingUnit: 'PER_NIGHT_PER_PERSON',
	priceKopecks: 150_000, // 1500 ₽
	currency: 'RUB',
	vatBps: 2200,
	inventoryMode: 'NONE',
	dailyCapacity: null,
	seasonalTags: [],
	sortOrder: 10,
}

const parking: PublicWidgetAddon = {
	...breakfast,
	addonId: 'addn_park',
	code: 'PARKING',
	category: 'PARKING',
	nameRu: 'Парковка',
	pricingUnit: 'PER_NIGHT',
	priceKopecks: 50_000, // 500 ₽
}

const transfer: PublicWidgetAddon = {
	...breakfast,
	addonId: 'addn_trf',
	code: 'TRANSFER',
	category: 'TRANSFER',
	nameRu: 'Трансфер',
	pricingUnit: 'PER_STAY',
	priceKopecks: 250_000, // 2500 ₽
}

const _spa: PublicWidgetAddon = {
	...breakfast,
	addonId: 'addn_spa',
	code: 'SPA',
	category: 'WELLNESS',
	nameRu: 'СПА',
	pricingUnit: 'PER_HOUR',
	priceKopecks: 300_000, // 3000 ₽
}

describe('addonNetKopecks — pure pricing math', () => {
	test('PER_STAY × qty=1 → priceKopecks', () => {
		expect(addonNetKopecks('PER_STAY', 250_000, 1, { nights: 5, persons: 2 })).toBe(250_000)
	})

	test('PER_STAY × qty=3 → priceKopecks × 3', () => {
		expect(addonNetKopecks('PER_STAY', 250_000, 3, { nights: 5, persons: 2 })).toBe(750_000)
	})

	test('PER_PERSON × qty=4 → priceKopecks × 4', () => {
		expect(addonNetKopecks('PER_PERSON', 100_000, 4, { nights: 7, persons: 4 })).toBe(400_000)
	})

	test('PER_NIGHT × qty=2 × nights=5 → priceKopecks × 2 × 5', () => {
		expect(addonNetKopecks('PER_NIGHT', 50_000, 2, { nights: 5, persons: 2 })).toBe(500_000)
	})

	test('PER_NIGHT_PER_PERSON × qty=3 × nights=4 → priceKopecks × 3 × 4', () => {
		expect(addonNetKopecks('PER_NIGHT_PER_PERSON', 150_000, 3, { nights: 4, persons: 3 })).toBe(
			1_800_000,
		)
	})

	test('PER_HOUR × qty=2 → priceKopecks × 2 (nights ignored)', () => {
		expect(addonNetKopecks('PER_HOUR', 300_000, 2, { nights: 7, persons: 2 })).toBe(600_000)
	})

	test('qty=0 → 0 regardless of pricing unit', () => {
		expect(addonNetKopecks('PER_NIGHT_PER_PERSON', 150_000, 0, { nights: 5, persons: 4 })).toBe(0)
	})

	test('PERCENT_OF_ROOM_RATE throws (not on Extras screen)', () => {
		expect(() =>
			addonNetKopecks('PERCENT_OF_ROOM_RATE', 1000, 1, { nights: 1, persons: 1 }),
		).toThrowError(/PERCENT_OF_ROOM_RATE not supported/)
	})

	// Adversarial negative paths
	test('priceKopecks negative throws', () => {
		expect(() => addonNetKopecks('PER_STAY', -1, 1, { nights: 1, persons: 1 })).toThrowError(
			/priceKopecks negative/,
		)
	})

	test('priceKopecks non-integer throws', () => {
		expect(() => addonNetKopecks('PER_STAY', 1.5, 1, { nights: 1, persons: 1 })).toThrowError(
			/priceKopecks not integer/,
		)
	})

	test('quantity negative throws', () => {
		expect(() => addonNetKopecks('PER_STAY', 100, -1, { nights: 1, persons: 1 })).toThrowError(
			/quantity negative/,
		)
	})

	test('quantity non-integer throws', () => {
		expect(() => addonNetKopecks('PER_STAY', 100, 1.5, { nights: 1, persons: 1 })).toThrowError(
			/quantity not integer/,
		)
	})

	test('nights negative throws', () => {
		expect(() => addonNetKopecks('PER_NIGHT', 100, 1, { nights: -1, persons: 1 })).toThrowError(
			/nights negative/,
		)
	})

	test('persons non-integer throws', () => {
		expect(() => addonNetKopecks('PER_PERSON', 100, 1, { nights: 1, persons: 1.5 })).toThrowError(
			/persons not integer/,
		)
	})
})

describe('addonGrossKopecks — VAT layering', () => {
	test('VAT 22% (vatBps=2200) → gross = floor(net × 1.22)', () => {
		// net = 1000 × 5 = 5000; gross = floor(5000 × 12200 / 10000) = floor(6100) = 6100
		expect(addonGrossKopecks('PER_NIGHT', 1000, 1, 2200, { nights: 5, persons: 2 })).toBe(6100)
	})

	test('VAT 0% (vatBps=0) → gross = net', () => {
		expect(addonGrossKopecks('PER_STAY', 250_000, 1, 0, { nights: 5, persons: 2 })).toBe(250_000)
	})

	test('VAT 5% (vatBps=500, УСН-НДС) → gross = floor(net × 1.05)', () => {
		// net = 100000; gross = floor(100000 × 10500 / 10000) = 105000
		expect(addonGrossKopecks('PER_STAY', 100_000, 1, 500, { nights: 1, persons: 1 })).toBe(105_000)
	})

	test('VAT 7% (vatBps=700, УСН-НДС) → gross = floor(net × 1.07)', () => {
		expect(addonGrossKopecks('PER_STAY', 100_000, 1, 700, { nights: 1, persons: 1 })).toBe(107_000)
	})

	test('VAT 10% (vatBps=1000, продукты) → gross = floor(net × 1.10)', () => {
		expect(addonGrossKopecks('PER_STAY', 100_000, 1, 1000, { nights: 1, persons: 1 })).toBe(110_000)
	})

	test('floor rounding favors guest (РФ canon for tax-inflows)', () => {
		// net = 100; gross = floor(100 × 12200 / 10000) = floor(122.0) = 122
		expect(addonGrossKopecks('PER_STAY', 100, 1, 2200, { nights: 1, persons: 1 })).toBe(122)
		// net = 1; gross = floor(1 × 12200 / 10000) = floor(1.22) = 1
		expect(addonGrossKopecks('PER_STAY', 1, 1, 2200, { nights: 1, persons: 1 })).toBe(1)
	})

	test('vatBps negative throws', () => {
		expect(() => addonGrossKopecks('PER_STAY', 1000, 1, -100, { nights: 1, persons: 1 })).toThrow(
			/vatBps negative/,
		)
	})

	test('vatBps non-integer throws', () => {
		expect(() => addonGrossKopecks('PER_STAY', 1000, 1, 22.5, { nights: 1, persons: 1 })).toThrow(
			/vatBps not integer/,
		)
	})
})

describe('addonVatKopecks', () => {
	test('VAT portion = gross - net', () => {
		// net = 5000; gross = 6100; vat = 1100
		expect(addonVatKopecks('PER_NIGHT', 1000, 1, 2200, { nights: 5, persons: 2 })).toBe(1100)
	})

	test('VAT 0% → 0 vat', () => {
		expect(addonVatKopecks('PER_STAY', 100_000, 1, 0, { nights: 1, persons: 1 })).toBe(0)
	})
})

describe('cartGrossTotalKopecks — aggregation', () => {
	test('empty cart → 0', () => {
		expect(cartGrossTotalKopecks([], [breakfast, parking], { nights: 5, persons: 2 })).toBe(0)
	})

	test('single addon × qty=2 × nights=5 (PER_NIGHT_PER_PERSON, VAT 22%)', () => {
		// breakfast: 150_000 × 2 × 5 = 1_500_000 net; gross = floor(1_500_000 × 12200 / 10000) = 1_830_000
		const cart: AddonCartEntry[] = [{ addonId: 'addn_brk', quantity: 2 }]
		expect(cartGrossTotalKopecks(cart, [breakfast], { nights: 5, persons: 2 })).toBe(1_830_000)
	})

	test('multiple addons aggregated correctly', () => {
		// breakfast: 150_000 × 2 × 5 = 1_500_000 net → gross 1_830_000
		// parking:   50_000 × 1 × 5 = 250_000 net → gross 305_000
		// transfer:  250_000 × 1     = 250_000 net → gross 305_000
		// total: 2_440_000
		const cart: AddonCartEntry[] = [
			{ addonId: 'addn_brk', quantity: 2 },
			{ addonId: 'addn_park', quantity: 1 },
			{ addonId: 'addn_trf', quantity: 1 },
		]
		expect(
			cartGrossTotalKopecks(cart, [breakfast, parking, transfer], { nights: 5, persons: 2 }),
		).toBe(2_440_000)
	})

	test('qty=0 entries skipped', () => {
		const cart: AddonCartEntry[] = [
			{ addonId: 'addn_brk', quantity: 0 },
			{ addonId: 'addn_park', quantity: 1 },
		]
		// only parking counts: 50_000 × 5 = 250_000 net; gross floor(305_000) = 305_000
		expect(cartGrossTotalKopecks(cart, [breakfast, parking], { nights: 5, persons: 2 })).toBe(
			305_000,
		)
	})

	test('unknown addonId silently skipped (defense-in-depth)', () => {
		const cart: AddonCartEntry[] = [
			{ addonId: 'addn_unknown', quantity: 5 },
			{ addonId: 'addn_brk', quantity: 1 },
		]
		// unknown skipped; breakfast: 150_000 × 1 × 5 = 750_000 net; gross floor(915_000) = 915_000
		expect(cartGrossTotalKopecks(cart, [breakfast], { nights: 5, persons: 2 })).toBe(915_000)
	})
})

describe('addonQtyBounds', () => {
	test('PER_PERSON max bounded by persons (3 guests)', () => {
		expect(addonQtyBounds('PER_PERSON', { nights: 5, persons: 3 })).toEqual({
			min: 0,
			max: 3,
			step: 1,
			label: 'Гостей',
		})
	})

	test('PER_NIGHT_PER_PERSON same as PER_PERSON (qty=persons)', () => {
		expect(addonQtyBounds('PER_NIGHT_PER_PERSON', { nights: 5, persons: 4 })).toEqual({
			min: 0,
			max: 4,
			step: 1,
			label: 'Гостей',
		})
	})

	test('PER_PERSON with persons=0 → max=1 (defensive minimum)', () => {
		// edge: ctx.persons=0 (no guests) — UI shouldn't show this addon, but
		// bounds shouldn't return max=0 (стопер не работает).
		expect(addonQtyBounds('PER_PERSON', { nights: 1, persons: 0 }).max).toBe(1)
	})

	test('PER_NIGHT max=5 (fixed)', () => {
		expect(addonQtyBounds('PER_NIGHT', { nights: 1, persons: 1 }).max).toBe(5)
	})

	test('PER_STAY max=5 (fixed)', () => {
		expect(addonQtyBounds('PER_STAY', { nights: 1, persons: 1 }).max).toBe(5)
	})

	test('PER_HOUR max=8 (fixed)', () => {
		expect(addonQtyBounds('PER_HOUR', { nights: 1, persons: 1 })).toEqual({
			min: 0,
			max: 8,
			step: 1,
			label: 'Часов',
		})
	})

	test('PERCENT_OF_ROOM_RATE throws (no user qty)', () => {
		expect(() => addonQtyBounds('PERCENT_OF_ROOM_RATE', { nights: 1, persons: 1 })).toThrow(
			/no user-controlled qty/,
		)
	})

	test('all bounds have min=0 (opt-in canon ЗоЗПП ст. 16 ч. 3.1)', () => {
		const units = [
			'PER_STAY',
			'PER_PERSON',
			'PER_NIGHT',
			'PER_NIGHT_PER_PERSON',
			'PER_HOUR',
		] as const
		for (const u of units) {
			expect(addonQtyBounds(u, { nights: 5, persons: 3 }).min).toBe(0)
		}
	})
})

describe('cart serialization (TanStack Router search params)', () => {
	test('serialize empty cart → empty string', () => {
		expect(serializeCart([])).toBe('')
	})

	test('serialize single entry', () => {
		expect(serializeCart([{ addonId: 'addn_brk', quantity: 2 }])).toBe('addn_brk:2')
	})

	test('serialize multiple entries CSV-joined', () => {
		expect(
			serializeCart([
				{ addonId: 'addn_brk', quantity: 2 },
				{ addonId: 'addn_trf', quantity: 1 },
			]),
		).toBe('addn_brk:2,addn_trf:1')
	})

	test('serialize skips qty=0 entries (URL hygiene)', () => {
		expect(
			serializeCart([
				{ addonId: 'addn_brk', quantity: 2 },
				{ addonId: 'addn_park', quantity: 0 },
				{ addonId: 'addn_trf', quantity: 1 },
			]),
		).toBe('addn_brk:2,addn_trf:1')
	})

	test('deserialize empty string → empty cart', () => {
		expect(deserializeCart('')).toEqual([])
	})

	test('deserialize single entry', () => {
		expect(deserializeCart('addn_brk:2')).toEqual([{ addonId: 'addn_brk', quantity: 2 }])
	})

	test('deserialize CSV-joined', () => {
		expect(deserializeCart('addn_brk:2,addn_trf:1')).toEqual([
			{ addonId: 'addn_brk', quantity: 2 },
			{ addonId: 'addn_trf', quantity: 1 },
		])
	})

	test('roundtrip preserves cart (excluding qty=0)', () => {
		const cart: AddonCartEntry[] = [
			{ addonId: 'addn_brk', quantity: 2 },
			{ addonId: 'addn_trf', quantity: 1 },
			{ addonId: 'addn_spa', quantity: 3 },
		]
		expect(deserializeCart(serializeCart(cart))).toEqual(cart)
	})

	// Adversarial
	test('deserialize malformed (no colon) throws', () => {
		expect(() => deserializeCart('addn_brk2')).toThrowError(/Malformed cart entry/)
	})

	test('deserialize empty addonId throws', () => {
		expect(() => deserializeCart(':2')).toThrowError(/Empty addonId/)
	})

	test('deserialize negative qty throws', () => {
		expect(() => deserializeCart('addn_brk:-1')).toThrowError(/Invalid qty/)
	})

	test('deserialize zero qty throws (positive integer required)', () => {
		expect(() => deserializeCart('addn_brk:0')).toThrowError(/Invalid qty/)
	})

	test('deserialize non-integer qty throws', () => {
		expect(() => deserializeCart('addn_brk:1.5')).toThrowError(/Invalid qty/)
	})

	test('deserialize NaN qty throws', () => {
		expect(() => deserializeCart('addn_brk:abc')).toThrowError(/Invalid qty/)
	})
})

describe('setCartQuantity / getCartQuantity', () => {
	test('getCartQuantity defaults to 0 (opt-in canon)', () => {
		expect(getCartQuantity([], 'addn_brk')).toBe(0)
	})

	test('getCartQuantity returns existing qty', () => {
		expect(getCartQuantity([{ addonId: 'addn_brk', quantity: 3 }], 'addn_brk')).toBe(3)
	})

	test('setCartQuantity adds new entry', () => {
		expect(setCartQuantity([], 'addn_brk', 2)).toEqual([{ addonId: 'addn_brk', quantity: 2 }])
	})

	test('setCartQuantity updates existing entry', () => {
		expect(setCartQuantity([{ addonId: 'addn_brk', quantity: 1 }], 'addn_brk', 3)).toEqual([
			{ addonId: 'addn_brk', quantity: 3 },
		])
	})

	test('setCartQuantity qty=0 removes entry (opt-in toggle off)', () => {
		expect(
			setCartQuantity(
				[
					{ addonId: 'addn_brk', quantity: 2 },
					{ addonId: 'addn_trf', quantity: 1 },
				],
				'addn_brk',
				0,
			),
		).toEqual([{ addonId: 'addn_trf', quantity: 1 }])
	})

	test('setCartQuantity is immutable (returns new array)', () => {
		const cart: AddonCartEntry[] = [{ addonId: 'addn_brk', quantity: 1 }]
		const next = setCartQuantity(cart, 'addn_brk', 2)
		expect(next).not.toBe(cart)
		expect(cart[0]?.quantity).toBe(1) // original untouched
	})

	test('setCartQuantity negative throws', () => {
		expect(() => setCartQuantity([], 'addn_brk', -1)).toThrowError(/qty negative/)
	})

	test('setCartQuantity non-integer throws', () => {
		expect(() => setCartQuantity([], 'addn_brk', 1.5)).toThrowError(/qty not integer/)
	})
})
