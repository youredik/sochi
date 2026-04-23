import type { sql as SQL } from '../../db/index.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RateRepo } from '../rate/rate.repo.ts'
import type { RatePlanService } from '../ratePlan/ratePlan.service.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import { createBookingRepo } from './booking.repo.ts'
import { createBookingService } from './booking.service.ts'

type SqlInstance = typeof SQL

export function createBookingFactory(
	sql: SqlInstance,
	rateRepo: RateRepo,
	propertyService: PropertyService,
	roomTypeService: RoomTypeService,
	ratePlanService: RatePlanService,
) {
	const repo = createBookingRepo(sql)
	const service = createBookingService(
		repo,
		rateRepo,
		propertyService,
		roomTypeService,
		ratePlanService,
	)
	return { repo, service }
}

export type BookingFactory = ReturnType<typeof createBookingFactory>
