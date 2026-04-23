import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Room — a specific physical unit of a given roomType.
 * In the ARI model, guests book a roomType (category), and a room is
 * assigned to a booking at check-in / by an auto-assignment job. Rooms
 * therefore carry no pricing or availability themselves — just identity,
 * floor, housekeeping-relevant notes.
 */

const floorSchema = z.coerce.number().int().min(-5).max(100)

export const roomCreateInput = z.object({
	roomTypeId: idSchema('roomType'),
	number: z.string().min(1).max(20),
	floor: floorSchema.optional(),
	notes: z.string().max(1000).optional(),
})
export type RoomCreateInput = z.infer<typeof roomCreateInput>

export const roomUpdateInput = z
	.object({
		roomTypeId: idSchema('roomType').optional(),
		number: z.string().min(1).max(20).optional(),
		floor: floorSchema.nullable().optional(),
		notes: z.string().max(1000).nullable().optional(),
		isActive: z.boolean().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, 'At least one field must be provided')
export type RoomUpdateInput = z.infer<typeof roomUpdateInput>

export const roomIdParam = z.object({ id: idSchema('room') })

export const roomPropertyParam = z.object({ propertyId: idSchema('property') })
export const roomRoomTypeParam = z.object({ roomTypeId: idSchema('roomType') })

export const roomListParams = z.object({
	includeInactive: z.coerce.boolean().optional().default(false),
	roomTypeId: idSchema('roomType').optional(),
})
export type RoomListParams = z.infer<typeof roomListParams>

export type Room = {
	id: string
	tenantId: string
	propertyId: string
	roomTypeId: string
	number: string
	floor: number | null
	isActive: boolean
	notes: string | null
	createdAt: string
	updatedAt: string
}
