import type { RatePlanCreateInput, RatePlanUpdateInput } from '@horeca/shared'
import { PropertyNotFoundError, RoomTypeNotFoundError } from '../../errors/domain.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import type { RatePlanRepo } from './ratePlan.repo.ts'

/**
 * RatePlan service.
 *
 * Like room.service, write paths resolve the parent roomType (which carries
 * propertyId) within the tenant, guaranteeing:
 *   • ratePlan.propertyId always matches its roomType.propertyId
 *   • a rate plan cannot reference a roomType from a different tenant
 */
export function createRatePlanService(
	repo: RatePlanRepo,
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
				const rt = await roomTypeService.getById(tenantId, opts.roomTypeId)
				if (!rt || rt.propertyId !== propertyId) throw new RoomTypeNotFoundError(opts.roomTypeId)
			}
			return repo.listByProperty(tenantId, propertyId, {
				includeInactive: opts.includeInactive ?? false,
				...(opts.roomTypeId ? { roomTypeId: opts.roomTypeId } : {}),
			})
		},

		getById: (tenantId: string, id: string) => repo.getById(tenantId, id),

		create: async (tenantId: string, input: RatePlanCreateInput) => {
			const rt = await ensureRoomType(tenantId, input.roomTypeId)
			return repo.create(tenantId, rt.propertyId, rt.id, input)
		},

		update: async (tenantId: string, id: string, patch: RatePlanUpdateInput) => {
			return repo.update(tenantId, id, patch)
		},

		delete: (tenantId: string, id: string) => repo.delete(tenantId, id),
	}
}
