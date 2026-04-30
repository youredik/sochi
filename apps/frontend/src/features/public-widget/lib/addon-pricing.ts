/**
 * Pure pricing helpers для public booking widget Extras screen (M9.widget.3).
 *
 * Per `plans/m9_widget_canonical.md` §3 + Round 2 verified:
 *   - `priceKopecks` (wire format) = NET (без НДС); UI отображает GROSS
 *     согласно ст. 10 ЗоЗПП — обязательная цена с НДС для потребителя.
 *   - НДС = 22% с 01.01.2026 (425-ФЗ от 28.11.2025) для a-la-carte addons.
 *   - Floor rounding favors guest (РФ canon for tax-inflows).
 *   - All math в `number` — kopecks fit Number.MAX_SAFE_INTEGER (≤9×10¹⁵
 *     kopecks = ≤90 трлн ₽; HoReCa Сочи никогда не достигнет).
 *   - `bigint` НЕ используется на client per Round 2 finding (JSON.stringify
 *     bigint throws; TanStack Router search params не выдержит).
 */

import type { AddonPricingUnit, PublicWidgetAddon } from './widget-api.ts'

const VAT_DENOM = 10_000

export interface AddonCartEntry {
	readonly addonId: string
	readonly quantity: number
}

export interface AddonPricingContext {
	readonly nights: number
	readonly persons: number
}

export interface AddonQtyBounds {
	readonly min: 0
	readonly max: number
	readonly step: 1
	readonly label: string
}

function assertContext(quantity: number, ctx: AddonPricingContext): void {
	if (!Number.isInteger(quantity)) throw new Error(`quantity not integer: ${quantity}`)
	if (quantity < 0) throw new Error(`quantity negative: ${quantity}`)
	if (!Number.isInteger(ctx.nights)) throw new Error(`nights not integer: ${ctx.nights}`)
	if (ctx.nights < 0) throw new Error(`nights negative: ${ctx.nights}`)
	if (!Number.isInteger(ctx.persons)) throw new Error(`persons not integer: ${ctx.persons}`)
	if (ctx.persons < 0) throw new Error(`persons negative: ${ctx.persons}`)
}

/**
 * Compute NET subtotal (без НДС) для one addon at given qty + booking context.
 * Throws on negative / non-integer inputs (defensive — UI должен validate before).
 */
export function addonNetKopecks(
	pricingUnit: AddonPricingUnit,
	priceKopecks: number,
	quantity: number,
	ctx: AddonPricingContext,
): number {
	if (priceKopecks < 0) throw new Error(`priceKopecks negative: ${priceKopecks}`)
	if (!Number.isInteger(priceKopecks)) {
		throw new Error(`priceKopecks not integer: ${priceKopecks}`)
	}
	assertContext(quantity, ctx)
	if (quantity === 0) return 0
	switch (pricingUnit) {
		case 'PER_STAY':
			return priceKopecks * quantity
		case 'PER_PERSON':
			return priceKopecks * quantity
		case 'PER_NIGHT':
			return priceKopecks * quantity * ctx.nights
		case 'PER_NIGHT_PER_PERSON':
			return priceKopecks * quantity * ctx.nights
		case 'PER_HOUR':
			return priceKopecks * quantity
		case 'PERCENT_OF_ROOM_RATE':
			// Not user-selectable on Extras screen (computed from room subtotal).
			// Defensive throw — server filters TIME_SLOT but not PERCENT, поэтому
			// если демо-seed где-то добавит такое — UI не должен молча silently
			// разломаться.
			throw new Error('PERCENT_OF_ROOM_RATE not supported on Extras screen')
	}
}

/**
 * Compute GROSS (с НДС) — floor rounding на VAT step.
 *
 * gross = floor(net × (VAT_DENOM + vatBps) / VAT_DENOM)
 *
 * Для НДС 22%: gross = floor(net × 12200 / 10000) = floor(net × 1.22).
 */
export function addonGrossKopecks(
	pricingUnit: AddonPricingUnit,
	priceKopecks: number,
	quantity: number,
	vatBps: number,
	ctx: AddonPricingContext,
): number {
	if (!Number.isInteger(vatBps)) throw new Error(`vatBps not integer: ${vatBps}`)
	if (vatBps < 0) throw new Error(`vatBps negative: ${vatBps}`)
	const net = addonNetKopecks(pricingUnit, priceKopecks, quantity, ctx)
	return Math.floor((net * (VAT_DENOM + vatBps)) / VAT_DENOM)
}

/**
 * Compute VAT portion (gross - net) — для UI «в т.ч. НДС 22%».
 */
export function addonVatKopecks(
	pricingUnit: AddonPricingUnit,
	priceKopecks: number,
	quantity: number,
	vatBps: number,
	ctx: AddonPricingContext,
): number {
	return (
		addonGrossKopecks(pricingUnit, priceKopecks, quantity, vatBps, ctx) -
		addonNetKopecks(pricingUnit, priceKopecks, quantity, ctx)
	)
}

/**
 * Aggregate gross total for full cart. Skips qty=0 entries и addons NOT
 * present in catalog (defensive — server pre-filters, но belt-and-suspenders).
 */
export function cartGrossTotalKopecks(
	cart: readonly AddonCartEntry[],
	addons: readonly PublicWidgetAddon[],
	ctx: AddonPricingContext,
): number {
	const byId = new Map(addons.map((a) => [a.addonId, a]))
	let total = 0
	for (const e of cart) {
		if (e.quantity <= 0) continue
		const a = byId.get(e.addonId)
		if (!a) continue
		total += addonGrossKopecks(a.pricingUnit, a.priceKopecks, e.quantity, a.vatBps, ctx)
	}
	return total
}

/**
 * Quantity stepper bounds. min always 0 (opt-in mandate —
 * ЗоЗПП ст. 16 ч. 3.1, 69-ФЗ от 07.04.2025).
 */
export function addonQtyBounds(
	pricingUnit: AddonPricingUnit,
	ctx: AddonPricingContext,
): AddonQtyBounds {
	switch (pricingUnit) {
		case 'PER_PERSON':
		case 'PER_NIGHT_PER_PERSON':
			// Max bounded by booking guest count (нельзя купить завтрак на больше людей).
			return { min: 0, max: Math.max(1, ctx.persons), step: 1, label: 'Гостей' }
		case 'PER_NIGHT':
			return { min: 0, max: 5, step: 1, label: 'Кол-во' }
		case 'PER_STAY':
			return { min: 0, max: 5, step: 1, label: 'Кол-во' }
		case 'PER_HOUR':
			return { min: 0, max: 8, step: 1, label: 'Часов' }
		case 'PERCENT_OF_ROOM_RATE':
			throw new Error('PERCENT_OF_ROOM_RATE has no user-controlled qty')
	}
}

/**
 * Get qty for addon в cart — defaults to 0 (opt-in canon).
 */
export function getCartQuantity(cart: readonly AddonCartEntry[], addonId: string): number {
	return cart.find((e) => e.addonId === addonId)?.quantity ?? 0
}

/**
 * Update qty for addon — immutable. qty=0 removes from cart.
 */
export function setCartQuantity(
	cart: readonly AddonCartEntry[],
	addonId: string,
	qty: number,
): AddonCartEntry[] {
	if (!Number.isInteger(qty)) throw new Error(`qty not integer: ${qty}`)
	if (qty < 0) throw new Error(`qty negative: ${qty}`)
	if (qty === 0) {
		return cart.filter((e) => e.addonId !== addonId)
	}
	const existing = cart.find((e) => e.addonId === addonId)
	if (existing) {
		return cart.map((e) => (e.addonId === addonId ? { ...e, quantity: qty } : e))
	}
	return [...cart, { addonId, quantity: qty }]
}

/**
 * Cart serialization для TanStack Router search params (URL-safe CSV).
 * Format: `addonId:qty,addonId:qty` — addonId это typeid (alphanumeric+_).
 * Skip qty=0 entries.
 */
export function serializeCart(cart: readonly AddonCartEntry[]): string {
	return cart
		.filter((e) => e.quantity > 0)
		.map((e) => `${e.addonId}:${e.quantity}`)
		.join(',')
}

/**
 * Cart deserialization. Strict — invalid format throws (caller fallback to []).
 * Empty string → empty cart (canonical no-extras state).
 */
export function deserializeCart(s: string): AddonCartEntry[] {
	if (!s) return []
	const result: AddonCartEntry[] = []
	for (const pair of s.split(',')) {
		const colon = pair.indexOf(':')
		if (colon === -1) throw new Error(`Malformed cart entry (no colon): '${pair}'`)
		const addonId = pair.slice(0, colon)
		const qtyStr = pair.slice(colon + 1)
		if (!addonId) throw new Error(`Empty addonId в entry: '${pair}'`)
		// Strict parse: reject '1.5' (parseInt would silently return 1), 'abc',
		// empty, signed. Only positive decimal integers allowed.
		if (!/^[1-9]\d*$/.test(qtyStr)) {
			throw new Error(`Invalid qty в cart entry '${pair}': must be positive integer`)
		}
		const qty = Number.parseInt(qtyStr, 10)
		result.push({ addonId, quantity: qty })
	}
	return result
}
