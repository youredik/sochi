import type { sql as SQL } from '../../db/index.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import { createRoomRepo } from './room.repo.ts'
import { createRoomService } from './room.service.ts'

/**
 * Room factory. Depends on PropertyService (for list scoping) and
 * RoomTypeService (for create/update parent resolution).
 */
export function createRoomFactory(
	sql: typeof SQL,
	propertyService: PropertyService,
	roomTypeService: RoomTypeService,
) {
	const repo = createRoomRepo(sql)
	const service = createRoomService(repo, propertyService, roomTypeService)
	return { service }
}

export type RoomFactory = ReturnType<typeof createRoomFactory>
