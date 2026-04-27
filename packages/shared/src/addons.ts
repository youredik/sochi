/**
 * Addons — bookable services / extras attached to a stay (Apaleo Services
 * pattern). Per plan v2 §7.1 #4 + research/hotel-addons-extras.md §§1-6.
 *
 * Schema decisions:
 *   - 12 canonical categories (research §4) — Sochi-specific (ski-pass,
 *     sea-season tags) + global (transfer, parking, breakfast).
 *   - 6 pricing units (research §5.1): PER_STAY, PER_PERSON, PER_NIGHT,
 *     PER_NIGHT_PER_PERSON, PER_HOUR, PERCENT_OF_ROOM_RATE.
 *   - 3 inventory modes (research §6.1): NONE, DAILY_COUNTER, TIME_SLOT.
 *     Implemented now: NONE + DAILY_COUNTER. TIME_SLOT deferred to M9+.
 *   - VAT rate stored as basis-points (1 bp = 0.01%) snapshot at addon
 *     creation; folio lines snapshot the rate at service-date so that a
 *     mid-year НДС change (376-ФЗ) doesn't retroactively re-tax.
 *   - Money in micro-RUB Int64 (codebase convention); price always positive.
 *
 * Tax notes (research §5.2 — confidence 60%, requires tax-lawyer review
 * before production):
 *   - F&B 22% (or 0% общепит-льгота if applicable per НК 149.1)
 *   - Wellness 22% (0% only with medical license)
 *   - Activities (ski-pass resale) — depends on commission vs revenue model
 *   - Early/late check-in 0% if accommodation льгота applies
 */

import { z } from 'zod'
import { int64WireSchema } from './schemas.ts'

/**
 * Money-bigint accepting wire form (`string`) and bigint. Coerces to bigint.
 * Specific to non-negative price values.
 */
const priceMicrosSchema = int64WireSchema.refine((v) => v >= 0n, 'priceMicros must be >= 0')

// ─── Categories (12) ─────────────────────────────────────────────────────

export const addonCategoryValues = [
	'FOOD_AND_BEVERAGES',
	'TRANSFER',
	'PARKING',
	'WELLNESS',
	'ACTIVITIES',
	'EARLY_CHECK_IN',
	'LATE_CHECK_OUT',
	'CLEANING',
	'EQUIPMENT',
	'PET_FEE',
	'CONNECTIVITY',
	'OTHER',
] as const
export const addonCategorySchema = z.enum(addonCategoryValues)
export type AddonCategory = z.infer<typeof addonCategorySchema>

// ─── Pricing units (6) ───────────────────────────────────────────────────

export const addonPricingUnitValues = [
	'PER_STAY',
	'PER_PERSON',
	'PER_NIGHT',
	'PER_NIGHT_PER_PERSON',
	'PER_HOUR',
	'PERCENT_OF_ROOM_RATE',
] as const
export const addonPricingUnitSchema = z.enum(addonPricingUnitValues)
export type AddonPricingUnit = z.infer<typeof addonPricingUnitSchema>

// ─── Inventory modes (3) ─────────────────────────────────────────────────

export const addonInventoryModeValues = ['NONE', 'DAILY_COUNTER', 'TIME_SLOT'] as const
export const addonInventoryModeSchema = z.enum(addonInventoryModeValues)
export type AddonInventoryMode = z.infer<typeof addonInventoryModeSchema>

// ─── VAT rate (basis points) ─────────────────────────────────────────────

/**
 * Basis points: 1 bp = 0.01%. 22% НДС = 2200 bps. Allowed values bounded
 * to [0, 10000] to catch typos (e.g. 22000 instead of 2200).
 */
/**
 * Canonical RU 2026 VAT rates in basis-points:
 *   - **0** bps — accommodation льгота (НК ст.149.1.18, продлено до 30.06.2027)
 *   - **500** bps (5%) — УСН-НДС нижний тариф (376-ФЗ; для УСН с выручкой 60-250M ₽)
 *   - **700** bps (7%) — УСН-НДС средний тариф (376-ФЗ; УСН с выручкой 250-450M ₽)
 *   - **1000** bps (10%) — пониженный (продукты, детские товары, печатная продукция)
 *   - **2000** bps (20%) — переходная для 2025 (некоторых сделок)
 *   - **2200** bps (22%) — основная с 01.01.2026 (376-ФЗ от 12.07.2025)
 *
 * Range [0, 10000] sanity-bound. Unsupported (e.g. 1500) refined out.
 */
export const VAT_RATE_BPS_VALUES = [0, 500, 700, 1000, 2000, 2200] as const
export type AddonVatBps = (typeof VAT_RATE_BPS_VALUES)[number]
export const addonVatBpsSchema = z
	.number()
	.int()
	.min(0)
	.max(10_000)
	.refine((v) => (VAT_RATE_BPS_VALUES as readonly number[]).includes(v), {
		message: `Unsupported VAT rate (allowed: ${VAT_RATE_BPS_VALUES.join(', ')})`,
	})

// ─── Currency (3-letter ISO 4217 — RUB / KZT / BYN) ──────────────────────

export const addonCurrencyValues = ['RUB', 'KZT', 'BYN'] as const
export const addonCurrencySchema = z.enum(addonCurrencyValues)
export type AddonCurrency = z.infer<typeof addonCurrencySchema>

// ─── Sochi seasonal tags (research §4) ───────────────────────────────────

export const addonSeasonalTagValues = [
	'ski-season', // 15.12-15.04
	'sea-season', // 01.06-30.09
	'new-year-peak', // 28.12-08.01
	'may-holidays',
] as const
export const addonSeasonalTagSchema = z.enum(addonSeasonalTagValues)
export type AddonSeasonalTag = z.infer<typeof addonSeasonalTagSchema>

// ─── Domain row + inputs ─────────────────────────────────────────────────

export const addonSchema = z.object({
	tenantId: z.string(),
	propertyId: z.string(),
	addonId: z.string(),
	code: z.string().min(1).max(50),
	category: addonCategorySchema,
	nameRu: z.string().min(1).max(200),
	nameEn: z.string().min(1).max(200).nullable(),
	descriptionRu: z.string().max(2000).nullable(),
	descriptionEn: z.string().max(2000).nullable(),
	pricingUnit: addonPricingUnitSchema,
	priceMicros: priceMicrosSchema,
	currency: addonCurrencySchema,
	vatBps: addonVatBpsSchema,
	isActive: z.boolean(),
	isMandatory: z.boolean(),
	inventoryMode: addonInventoryModeSchema,
	dailyCapacity: z.number().int().min(0).nullable(),
	seasonalTags: z.array(addonSeasonalTagSchema),
	sortOrder: z.number().int().min(0),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
})
export type Addon = z.infer<typeof addonSchema>

export const addonCreateInputSchema = z
	.object({
		code: z.string().min(1).max(50),
		category: addonCategorySchema,
		nameRu: z.string().min(1).max(200),
		nameEn: z.string().min(1).max(200).nullable().optional(),
		descriptionRu: z.string().max(2000).nullable().optional(),
		descriptionEn: z.string().max(2000).nullable().optional(),
		pricingUnit: addonPricingUnitSchema,
		priceMicros: priceMicrosSchema,
		currency: addonCurrencySchema.default('RUB'),
		vatBps: addonVatBpsSchema,
		isActive: z.boolean().default(true),
		isMandatory: z.boolean().default(false),
		inventoryMode: addonInventoryModeSchema.default('NONE'),
		dailyCapacity: z.number().int().min(0).nullable().optional(),
		seasonalTags: z.array(addonSeasonalTagSchema).default([]),
		sortOrder: z.number().int().min(0).default(0),
	})
	.refine(
		(obj) => {
			if (obj.inventoryMode === 'DAILY_COUNTER') {
				return typeof obj.dailyCapacity === 'number' && obj.dailyCapacity > 0
			}
			return true
		},
		{
			message: 'inventoryMode=DAILY_COUNTER requires dailyCapacity > 0',
			path: ['dailyCapacity'],
		},
	)
	.refine(
		(obj) => {
			if (obj.inventoryMode === 'TIME_SLOT') {
				return false // Not supported in M8.A.0.5 (deferred to M9+)
			}
			return true
		},
		{
			message: 'inventoryMode=TIME_SLOT not supported yet (deferred to M9)',
			path: ['inventoryMode'],
		},
	)
	.refine(
		(obj) => {
			// PERCENT_OF_ROOM_RATE: priceMicros encodes basis points × MICROS,
			// e.g. 5% = 50_000_000 micros (when treated as bp). We keep micros
			// for storage uniformity; consumers MUST detect the unit and divide.
			// Sanity: ≤ 10000 bps (100%) → ≤ 100_000_000 micros.
			if (obj.pricingUnit === 'PERCENT_OF_ROOM_RATE') {
				return obj.priceMicros <= 100_000_000n
			}
			return true
		},
		{
			message: 'PERCENT_OF_ROOM_RATE: priceMicros must be ≤ 100_000_000 (= 100%)',
			path: ['priceMicros'],
		},
	)
export type AddonCreateInput = z.infer<typeof addonCreateInputSchema>

export const addonPatchSchema = z
	.object({
		code: z.string().min(1).max(50).optional(),
		category: addonCategorySchema.optional(),
		nameRu: z.string().min(1).max(200).optional(),
		nameEn: z.string().min(1).max(200).nullable().optional(),
		descriptionRu: z.string().max(2000).nullable().optional(),
		descriptionEn: z.string().max(2000).nullable().optional(),
		pricingUnit: addonPricingUnitSchema.optional(),
		priceMicros: priceMicrosSchema.optional(),
		currency: addonCurrencySchema.optional(),
		vatBps: addonVatBpsSchema.optional(),
		isActive: z.boolean().optional(),
		isMandatory: z.boolean().optional(),
		inventoryMode: addonInventoryModeSchema.optional(),
		dailyCapacity: z.number().int().min(0).nullable().optional(),
		seasonalTags: z.array(addonSeasonalTagSchema).optional(),
		sortOrder: z.number().int().min(0).optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, 'At least one field must be provided')
export type AddonPatch = z.infer<typeof addonPatchSchema>

// ─── Pricing calculator (pure) ───────────────────────────────────────────

export interface AddonChargeContext {
	readonly nights: number
	readonly persons: number
	readonly hours: number
	/** Room subtotal in micros (used for PERCENT_OF_ROOM_RATE). */
	readonly roomSubtotalMicros: bigint
}

export interface AddonChargeResult {
	readonly netMicros: bigint
	readonly vatMicros: bigint
	readonly grossMicros: bigint
}

/**
 * Compute the gross charge for an addon. Pure — no DB / clock / random.
 *
 * Semantics (research §5.1):
 *   PER_STAY              → price × 1
 *   PER_PERSON            → price × persons
 *   PER_NIGHT             → price × nights
 *   PER_NIGHT_PER_PERSON  → price × nights × persons
 *   PER_HOUR              → price × hours
 *   PERCENT_OF_ROOM_RATE  → roomSubtotal × (priceMicros / 1_000_000_000)
 *                            (where priceMicros encodes bp × micros,
 *                             100_000_000 = 100% threshold; see
 *                             addonCreateInputSchema refinement)
 *
 * VAT layered on top of net: gross = net × (1 + vatBps/10000).
 * All bigint arithmetic — no precision loss.
 */
export function computeAddonCharge(
	addon: Pick<Addon, 'pricingUnit' | 'priceMicros' | 'vatBps'>,
	ctx: AddonChargeContext,
): AddonChargeResult {
	if (ctx.nights < 0 || ctx.persons < 0 || ctx.hours < 0) {
		throw new Error('AddonChargeContext: nights, persons, hours must be non-negative')
	}
	if (!Number.isInteger(ctx.nights) || !Number.isInteger(ctx.persons)) {
		throw new Error('AddonChargeContext: nights, persons must be integers')
	}
	let netMicros: bigint
	switch (addon.pricingUnit) {
		case 'PER_STAY':
			netMicros = addon.priceMicros
			break
		case 'PER_PERSON':
			netMicros = addon.priceMicros * BigInt(ctx.persons)
			break
		case 'PER_NIGHT':
			netMicros = addon.priceMicros * BigInt(ctx.nights)
			break
		case 'PER_NIGHT_PER_PERSON':
			netMicros = addon.priceMicros * BigInt(ctx.nights) * BigInt(ctx.persons)
			break
		case 'PER_HOUR': {
			// Hours can be fractional → scale to bigint via multiplying by 1000
			// (millihours), priceMicros × millihours / 1000.
			const millihours = BigInt(Math.round(ctx.hours * 1000))
			netMicros = (addon.priceMicros * millihours) / 1000n
			break
		}
		case 'PERCENT_OF_ROOM_RATE':
			// priceMicros encodes (bp × MICROS_PER_UNIT). 5% = 5_000_000.
			// formula: roomSubtotal × priceMicros / 100_000_000.
			netMicros = (ctx.roomSubtotalMicros * addon.priceMicros) / 100_000_000n
			break
	}
	const vatMicros = (netMicros * BigInt(addon.vatBps)) / 10_000n
	const grossMicros = netMicros + vatMicros
	return { netMicros, vatMicros, grossMicros }
}
