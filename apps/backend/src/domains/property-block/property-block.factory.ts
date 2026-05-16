import type { sql as SQL } from '../../db/index.ts'
import type { BookingRepo } from '../booking/booking.repo.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RoomService } from '../room/room.service.ts'
import { createPropertyBlockRepo } from './property-block.repo.ts'
import { createPropertyBlockService } from './property-block.service.ts'

type SqlInstance = typeof SQL

export function createPropertyBlockFactory(
	sql: SqlInstance,
	bookingRepo: BookingRepo,
	propertyService: PropertyService,
	roomService: RoomService,
) {
	const repo = createPropertyBlockRepo(sql)
	const service = createPropertyBlockService({
		blockRepo: repo,
		bookingRepo,
		propertyService,
		roomService,
	})
	return { repo, service }
}

export type PropertyBlockFactory = ReturnType<typeof createPropertyBlockFactory>
