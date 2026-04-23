import type { sql as SQL } from '../../db/index.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import { createAvailabilityRepo } from './availability.repo.ts'
import { createAvailabilityService } from './availability.service.ts'

type SqlInstance = typeof SQL

export function createAvailabilityFactory(sql: SqlInstance, roomTypeService: RoomTypeService) {
	const repo = createAvailabilityRepo(sql)
	const service = createAvailabilityService(repo, roomTypeService)
	return { repo, service }
}

export type AvailabilityFactory = ReturnType<typeof createAvailabilityFactory>
