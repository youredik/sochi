import type { RoomCreateInput, RoomUpdateInput } from '@horeca/shared'
import type { PropertyService } from '../property/property.service.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import { PropertyNotFoundError } from '../roomType/roomType.service.ts'
import type { RoomRepo } from './room.repo.ts'

export class RoomTypeNotFoundError extends Error {
	constructor(id: string) {
		super(`Room type not found: ${id}`)
		this.name = 'RoomTypeNotFoundError'
	}
}

/**
 * Room service.
 *
 * Write paths resolve the parent roomType (which carries propertyId) within
 * the tenant, guaranteeing:
 *   • room.propertyId always matches its roomType.propertyId
 *   • a room cannot be assigned to a roomType from a different tenant
 *
 * Listing is scoped by propertyId and validated against the PropertyService
 * so a non-member / wrong-tenant caller can't probe property existence.
 */
export function createRoomService(
	repo: RoomRepo,
	propertyService: PropertyService,
	roomTypeService: RoomTypeService,
) {
	const ensureRoomType = async (tenantId: string, roomTypeId: string) => {
		const rt = await roomTypeService.getById(tenantId, roomTypeId)
		if (!rt) throw new RoomTypeNotFoundError(roomTypeId)
		return rt
	}

	return {
		listByProperty: async (
			tenantId: string,
			propertyId: string,
			opts: { includeInactive?: boolean; roomTypeId?: string } = {},
		) => {
			const property = await propertyService.getById(tenantId, propertyId)
			if (!property) throw new PropertyNotFoundError(propertyId)
			if (opts.roomTypeId) {
				// Quick sanity: verify the roomType belongs to this property+tenant
				const rt = await roomTypeService.getById(tenantId, opts.roomTypeId)
				if (!rt || rt.propertyId !== propertyId) throw new RoomTypeNotFoundError(opts.roomTypeId)
			}
			return repo.listByProperty(tenantId, propertyId, {
				includeInactive: opts.includeInactive ?? false,
				roomTypeId: opts.roomTypeId,
			})
		},

		getById: (tenantId: string, id: string) => repo.getById(tenantId, id),

		create: async (tenantId: string, input: RoomCreateInput) => {
			const rt = await ensureRoomType(tenantId, input.roomTypeId)
			return repo.create(tenantId, rt.propertyId, rt.id, input)
		},

		update: async (tenantId: string, id: string, patch: RoomUpdateInput) => {
			// If the caller reassigns the roomType, resolve the new property from it.
			let newPropertyId: string | undefined
			if (patch.roomTypeId) {
				const rt = await ensureRoomType(tenantId, patch.roomTypeId)
				newPropertyId = rt.propertyId
			}
			return repo.update(tenantId, id, patch, newPropertyId)
		},

		delete: (tenantId: string, id: string) => repo.delete(tenantId, id),
	}
}

export type RoomService = ReturnType<typeof createRoomService>
