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

export const propertyCreateInput = z.object({
	name: z.string().min(1).max(200),
	address: z.string().min(1).max(500),
	city: citySchema,
	timezone: timezoneSchema.optional(),
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
	isActive: boolean
	createdAt: string
	updatedAt: string
}
