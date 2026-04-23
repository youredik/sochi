import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * RoomType — sellable category of rooms (Standard Double, Suite, Apartment).
 * In the ARI model, bookings attach to roomType, not to a specific physical
 * room. `inventoryCount` = total physical rooms of this type and seeds the
 * default allotment when generating the availability calendar.
 */

/** `maxOccupancy` cap chosen to cover family suites; adjust if we add hostels. */
const occupancySchema = z.coerce.number().int().min(1).max(20)
const bedsSchema = z.coerce.number().int().min(0).max(10)
const baseBedsSchema = z.coerce.number().int().min(1).max(10)
const areaSqmSchema = z.coerce.number().int().min(1).max(1000)
/** 500 is a generous upper bound for a single roomType in one property. */
const inventoryCountSchema = z.coerce.number().int().min(0).max(500)

export const roomTypeCreateInput = z.object({
	name: z.string().min(1).max(100),
	description: z.string().max(2000).optional(),
	maxOccupancy: occupancySchema,
	baseBeds: baseBedsSchema,
	extraBeds: bedsSchema.default(0),
	areaSqm: areaSqmSchema.optional(),
	inventoryCount: inventoryCountSchema,
})
export type RoomTypeCreateInput = z.infer<typeof roomTypeCreateInput>

export const roomTypeUpdateInput = z
	.object({
		name: z.string().min(1).max(100).optional(),
		description: z.string().max(2000).nullable().optional(),
		maxOccupancy: occupancySchema.optional(),
		baseBeds: baseBedsSchema.optional(),
		extraBeds: bedsSchema.optional(),
		areaSqm: areaSqmSchema.nullable().optional(),
		inventoryCount: inventoryCountSchema.optional(),
		isActive: z.boolean().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, 'At least one field must be provided')
export type RoomTypeUpdateInput = z.infer<typeof roomTypeUpdateInput>

export const roomTypeIdParam = z.object({ id: idSchema('roomType') })

export const roomTypePropertyParam = z.object({
	propertyId: idSchema('property'),
})

export const roomTypeListParams = z.object({
	includeInactive: z.coerce.boolean().optional().default(false),
})

/** RoomType as returned by API. */
export type RoomType = {
	id: string
	tenantId: string
	propertyId: string
	name: string
	description: string | null
	maxOccupancy: number
	baseBeds: number
	extraBeds: number
	areaSqm: number | null
	inventoryCount: number
	isActive: boolean
	createdAt: string
	updatedAt: string
}
