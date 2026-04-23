import type { AvailabilityBulkUpsertInput } from '@horeca/shared'
import { RoomTypeNotFoundError } from '../../errors/domain.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import type { AvailabilityRepo } from './availability.repo.ts'

/**
 * Availability service. Resolves parent roomType (which carries propertyId
 * + tenant scope) so callers only pass `roomTypeId`.
 */
export function createAvailabilityService(
	repo: AvailabilityRepo,
	roomTypeService: RoomTypeService,
) {
	const resolveRoomType = async (tenantId: string, roomTypeId: string) => {
		const rt = await roomTypeService.getById(tenantId, roomTypeId)
		if (!rt) throw new RoomTypeNotFoundError(roomTypeId)
		return rt
	}

	return {
		listRange: async (
			tenantId: string,
			roomTypeId: string,
			range: { from: string; to: string },
		) => {
			const rt = await resolveRoomType(tenantId, roomTypeId)
			return repo.listRange(tenantId, rt.propertyId, roomTypeId, range)
		},

		getOne: async (tenantId: string, roomTypeId: string, date: string) => {
			const rt = await resolveRoomType(tenantId, roomTypeId)
			return repo.getOne(tenantId, rt.propertyId, roomTypeId, date)
		},

		bulkUpsert: async (
			tenantId: string,
			roomTypeId: string,
			input: AvailabilityBulkUpsertInput,
		) => {
			const rt = await resolveRoomType(tenantId, roomTypeId)
			return repo.bulkUpsert(tenantId, rt.propertyId, roomTypeId, input)
		},

		deleteOne: async (tenantId: string, roomTypeId: string, date: string) => {
			const rt = await resolveRoomType(tenantId, roomTypeId)
			return repo.deleteOne(tenantId, rt.propertyId, roomTypeId, date)
		},
	}
}
