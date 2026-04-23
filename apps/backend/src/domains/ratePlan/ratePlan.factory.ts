import type { sql as SQL } from '../../db/index.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import { createRatePlanRepo } from './ratePlan.repo.ts'
import { createRatePlanService } from './ratePlan.service.ts'

type SqlInstance = typeof SQL

export function createRatePlanFactory(
	sql: SqlInstance,
	propertyService: PropertyService,
	roomTypeService: RoomTypeService,
) {
	const repo = createRatePlanRepo(sql)
	const service = createRatePlanService(repo, propertyService, roomTypeService)
	return { repo, service }
}

export type RatePlanFactory = ReturnType<typeof createRatePlanFactory>
