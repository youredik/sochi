import type { RoomTypeCreateInput, RoomTypeUpdateInput } from '@horeca/shared'
import type { PropertyService } from '../property/property.service.ts'
import type { RoomTypeRepo } from './roomType.repo.ts'

/**
 * Thrown by `create` when the target property does not exist in the caller's
 * tenant. Routes translate this into 404 on the property resource.
 */
export class PropertyNotFoundError extends Error {
	constructor(propertyId: string) {
		super(`Property not found: ${propertyId}`)
		this.name = 'PropertyNotFoundError'
	}
}

/**
 * RoomType service. Validates the parent property belongs to the current
 * tenant before accepting writes — the repo itself trusts its arguments,
 * so that tenant guarantee lives at this layer.
 */
export function createRoomTypeService(repo: RoomTypeRepo, propertyService: PropertyService) {
	return {
		listByProperty: async (tenantId: string, propertyId: string, includeInactive = false) => {
			const property = await propertyService.getById(tenantId, propertyId)
			if (!property) throw new PropertyNotFoundError(propertyId)
			return repo.listByProperty(tenantId, propertyId, { includeInactive })
		},

		getById: (tenantId: string, id: string) => repo.getById(tenantId, id),

		create: async (tenantId: string, propertyId: string, input: RoomTypeCreateInput) => {
			const property = await propertyService.getById(tenantId, propertyId)
			if (!property) throw new PropertyNotFoundError(propertyId)
			return repo.create(tenantId, propertyId, input)
		},

		update: (tenantId: string, id: string, patch: RoomTypeUpdateInput) =>
			repo.update(tenantId, id, patch),

		delete: (tenantId: string, id: string) => repo.delete(tenantId, id),
	}
}

export type RoomTypeService = ReturnType<typeof createRoomTypeService>
