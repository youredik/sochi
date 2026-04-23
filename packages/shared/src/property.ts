import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Property — physical accommodation object (guest house, mini-hotel, apartment).
 * Pairs 1:N with roomType (room categories) and rooms.
 * Always scoped by tenantId (= organization.id).
 */

const cityValues = ['Sochi', 'Adler', 'Sirius', 'KrasnayaPolyana', 'Other'] as const
export const citySchema = z.enum(cityValues)
export type City = z.infer<typeof citySchema>

/** IANA timezone, e.g. 'Europe/Moscow'. Free-form Utf8 in DB. */
const timezoneSchema = z.string().min(1).max(64).default('Europe/Moscow')

/**
 * Tourism-tax rate in basis points (1 bp = 0.01%). Configured per property
 * because municipal rates differ (Sochi / Anapa / Gelendzhik / Gorychy Klyuch
 * all sit at 2% = 200 bps for 2026 per Краснодарский край decision; other
 * regions may opt out or differ). НК РФ ст.418.5 allows differentiated rates
 * by season and accommodation category — we store a single flat rate here
 * and revisit when Phase 3 adds seasonal slabs.
 *
 * Roadmap per federal law (2026-verified): 2026 → 2%, 2027 → 3%, 2028 → 4%,
 * 2029 → 5%. Max range [0, 500] covers through 2029 without schema change.
 * Null = not configured → tax compute treats as 0 (no tax applied).
 */
const tourismTaxRateBpsSchema = z.coerce.number().int().min(0).max(500)

export const propertyCreateInput = z.object({
	name: z.string().min(1).max(200),
	address: z.string().min(1).max(500),
	city: citySchema,
	timezone: timezoneSchema.optional(),
	tourismTaxRateBps: tourismTaxRateBpsSchema.nullable().optional(),
})
export type PropertyCreateInput = z.infer<typeof propertyCreateInput>

/** Patch-style update: all fields optional, at least one required. */
export const propertyUpdateInput = z
	.object({
		name: z.string().min(1).max(200).optional(),
		address: z.string().min(1).max(500).optional(),
		city: citySchema.optional(),
		timezone: z.string().min(1).max(64).optional(),
		classificationId: z.string().min(1).max(100).nullable().optional(),
		tourismTaxRateBps: tourismTaxRateBpsSchema.nullable().optional(),
		isActive: z.boolean().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, 'At least one field must be provided')
export type PropertyUpdateInput = z.infer<typeof propertyUpdateInput>

export const propertyIdParam = z.object({
	id: idSchema('property'),
})

export const propertyListParams = z.object({
	includeInactive: z.coerce.boolean().optional().default(false),
})

/** Property as returned by API. */
export type Property = {
	id: string
	tenantId: string
	name: string
	address: string
	city: City
	timezone: string
	classificationId: string | null
	tourismTaxRateBps: number | null
	isActive: boolean
	createdAt: string
	updatedAt: string
}
