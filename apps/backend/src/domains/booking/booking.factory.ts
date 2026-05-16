import type { sql as SQL } from '../../db/index.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RateRepo } from '../rate/rate.repo.ts'
import type { RatePlanService } from '../ratePlan/ratePlan.service.ts'
import type { RoomService } from '../room/room.service.ts'
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
	// G8 (2026-05-16) — roomService added для assign-room + auto-assign
	// operations. Optional с default undefined for backward-compat wiring
	// в old call-sites; new endpoints check at runtime and throw if missing.
	roomService?: RoomService,
) {
	const repo = createBookingRepo(sql)
	const service = createBookingService(
		repo,
		rateRepo,
		propertyService,
		roomTypeService,
		ratePlanService,
		roomService,
	)
	return { repo, service }
}

export type BookingFactory = ReturnType<typeof createBookingFactory>
