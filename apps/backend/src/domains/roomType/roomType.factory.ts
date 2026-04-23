import type { sql as SQL } from '../../db/index.ts'
import type { PropertyService } from '../property/property.service.ts'
import { createRoomTypeRepo } from './roomType.repo.ts'
import { createRoomTypeService } from './roomType.service.ts'

/**
 * RoomType has a hard dependency on PropertyService — it validates the
 * parent property belongs to the tenant on every write. Pass the service
 * from the property factory.
 */
export function createRoomTypeFactory(sql: typeof SQL, propertyService: PropertyService) {
	const repo = createRoomTypeRepo(sql)
	const service = createRoomTypeService(repo, propertyService)
	return { service }
}

export type RoomTypeFactory = ReturnType<typeof createRoomTypeFactory>
