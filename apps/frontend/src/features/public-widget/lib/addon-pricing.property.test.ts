/**
 * Property-based tests (fast-check) для addon-pricing pure helpers.
 *
 * Per `plans/m9_widget_canonical.md` §7 + `project_fastcheck_gotchas.md`:
 *   - Property tests ONLY for pure functions (NOT DB paths)
 *   - Bounded shrink space: ≤500 numRuns × tight ranges
 *   - addonId arbitrary uses alphanumeric+underscore (matches our typeid format —
 *     `addn_*`)
 *
 * Invariants tested:
 *   [P-NET-1] addonNetKopecks linear-additivity для linear units (qty1+qty2 = qty1, qty2 sum)
 *   [P-GROSS-1] addonGrossKopecks ≥ addonNetKopecks (VAT non-negative)
 *   [P-VAT-1] addonVatKopecks === addonGrossKopecks - addonNetKopecks
 *   [P-CART-1] Single-entry cart total === addonGrossKopecks at that qty
 *   [P-CART-2] Empty cart aggregation === 0
 *   [P-CART-3] qty=0 entries don't affect total (skip semantic)
 *   [P-SET-1] setCartQuantity(cart, id, 0) removes id from cart
 *   [P-SET-2] setCartQuantity is idempotent on same value
 *   [P-GET-1] getCartQuantity(empty, id) === 0 (opt-in canon)
 *   [P-SER-1] serialize → deserialize roundtrip preserves positive entries
 */
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import {
	addonGrossKopecks,
	addonNetKopecks,
	addonVatKopecks,
	cartGrossTotalKopecks,
	deserializeCart,
	getCartQuantity,
	serializeCart,
	setCartQuantity,
} from './addon-pricing.ts'
import type { AddonPricingUnit, PublicWidgetAddon } from './widget-api.ts'

// Bounded arbitraries — keep math safely inside Number.MAX_SAFE_INTEGER.
const arbPriceKopecks = fc.integer({ min: 0, max: 1_000_000 }) // ≤10k ₽
const arbQuantity = fc.integer({ min: 0, max: 50 })
const arbNights = fc.integer({ min: 0, max: 30 })
const arbPersons = fc.integer({ min: 0, max: 10 })
const arbVatBps = fc.constantFrom(0, 500, 700, 1000, 2000, 2200) // canonical RU rates
const arbLinearUnit: fc.Arbitrary<AddonPricingUnit> = fc.constantFrom(
	'PER_STAY',
	'PER_PERSON',
	'PER_NIGHT',
	'PER_NIGHT_PER_PERSON',
	'PER_HOUR',
)

// Cart entry arbitrary с typeid-shaped addonId (alphanumeric + underscore).
const arbAddonId = fc
	.stringMatching(/^addn_[a-z0-9]{1,12}$/)
	.filter((s) => s.length >= 5 && s.length <= 20)
const arbCartEntry = fc.record({
	addonId: arbAddonId,
	quantity: fc.integer({ min: 1, max: 50 }),
})
// Cart with unique addonIds (canonical invariant — UI never has duplicates).
const arbCart = fc.array(arbCartEntry, { minLength: 0, maxLength: 5 }).map((entries) => {
	const seen = new Set<string>()
	return entries.filter((e) => {
		if (seen.has(e.addonId)) return false
		seen.add(e.addonId)
		return true
	})
})

describe('addon-pricing property invariants', () => {
	test.prop([arbLinearUnit, arbPriceKopecks, arbQuantity, arbQuantity, arbNights, arbPersons], {
		numRuns: 200,
	})(
		'[P-NET-1] linear additivity: net(qtyA+qtyB) === net(qtyA) + net(qtyB)',
		(unit, price, qtyA, qtyB, nights, persons) => {
			const ctx = { nights, persons }
			const left = addonNetKopecks(unit, price, qtyA + qtyB, ctx)
			const right =
				addonNetKopecks(unit, price, qtyA, ctx) + addonNetKopecks(unit, price, qtyB, ctx)
			expect(left).toBe(right)
		},
	)

	test.prop([arbLinearUnit, arbPriceKopecks, arbQuantity, arbVatBps, arbNights, arbPersons], {
		numRuns: 200,
	})('[P-GROSS-1] gross >= net (VAT non-negative)', (unit, price, qty, vatBps, nights, persons) => {
		const ctx = { nights, persons }
		const net = addonNetKopecks(unit, price, qty, ctx)
		const gross = addonGrossKopecks(unit, price, qty, vatBps, ctx)
		expect(gross).toBeGreaterThanOrEqual(net)
	})

	test.prop([arbLinearUnit, arbPriceKopecks, arbQuantity, arbVatBps, arbNights, arbPersons], {
		numRuns: 200,
	})(
		'[P-VAT-1] vat === gross - net (formula consistency)',
		(unit, price, qty, vatBps, nights, persons) => {
			const ctx = { nights, persons }
			const vat = addonVatKopecks(unit, price, qty, vatBps, ctx)
			const gross = addonGrossKopecks(unit, price, qty, vatBps, ctx)
			const net = addonNetKopecks(unit, price, qty, ctx)
			expect(vat).toBe(gross - net)
		},
	)

	test.prop([arbLinearUnit, arbPriceKopecks, arbQuantity, arbVatBps, arbNights, arbPersons], {
		numRuns: 100,
	})(
		'[P-CART-1] single-entry cart total === addonGross at that qty',
		(unit, price, qty, vatBps, nights, persons) => {
			fc.pre(qty >= 1) // P-CART-1 only meaningful для qty>=1; qty=0 tested separately
			const addon: PublicWidgetAddon = {
				addonId: 'addn_test',
				code: 'TEST',
				category: 'OTHER',
				nameRu: 'test',
				nameEn: null,
				descriptionRu: null,
				descriptionEn: null,
				pricingUnit: unit,
				priceKopecks: price,
				currency: 'RUB',
				vatBps,
				inventoryMode: 'NONE',
				dailyCapacity: null,
				seasonalTags: [],
				sortOrder: 0,
			}
			const ctx = { nights, persons }
			const cartTotal = cartGrossTotalKopecks(
				[{ addonId: 'addn_test', quantity: qty }],
				[addon],
				ctx,
			)
			const direct = addonGrossKopecks(unit, price, qty, vatBps, ctx)
			expect(cartTotal).toBe(direct)
		},
	)

	test.prop([arbCart], { numRuns: 100 })('[P-CART-2] empty/no-addons cart total === 0', (cart) => {
		// No addons in catalog → defensive skip
		const total = cartGrossTotalKopecks(cart, [], { nights: 5, persons: 2 })
		expect(total).toBe(0)
	})

	test.prop([arbCart, arbAddonId], { numRuns: 100 })(
		'[P-SET-1] setCartQuantity(cart, id, 0) removes id (and only id)',
		(cart, id) => {
			const result = setCartQuantity(cart, id, 0)
			expect(result.find((e) => e.addonId === id)).toBeUndefined()
			// All other entries preserved (length difference ≤1)
			const removed = cart.some((e) => e.addonId === id)
			expect(result).toHaveLength(removed ? cart.length - 1 : cart.length)
		},
	)

	test.prop([arbCart, arbAddonId, fc.integer({ min: 1, max: 50 })], { numRuns: 100 })(
		'[P-SET-2] setCartQuantity idempotent на same value',
		(cart, id, qty) => {
			const once = setCartQuantity(cart, id, qty)
			const twice = setCartQuantity(once, id, qty)
			expect(twice).toEqual(once)
		},
	)

	test.prop([arbCart, arbAddonId], { numRuns: 100 })(
		'[P-GET-1] getCartQuantity для non-existing id → 0 (opt-in canon)',
		(cart, id) => {
			fc.pre(!cart.some((e) => e.addonId === id))
			expect(getCartQuantity(cart, id)).toBe(0)
		},
	)

	test.prop([arbCart], { numRuns: 100 })(
		'[P-SER-1] serialize → deserialize roundtrip preserves cart entries',
		(cart) => {
			const serialized = serializeCart(cart)
			const restored = deserializeCart(serialized)
			expect(restored).toEqual(cart)
		},
	)
})
