import { zValidator } from '@hono/zod-validator'
import {
	availabilityCheckParams,
	propertyBlockCreateInput,
	propertyBlockIdParam,
	propertyBlockListParams,
	propertyBlockUpdateInput,
} from '@horeca/shared'
import type { AvailabilityCheckResult } from '@horeca/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { PropertyBlockNotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../middleware/idempotency.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { BookingRepo } from '../booking/booking.repo.ts'
import type { RoomService } from '../room/room.service.ts'
import type { PropertyBlockFactory } from './property-block.factory.ts'
import { idSchema } from '@horeca/shared'

/**
 * Property-block (OOO/maintenance) routes + availability check endpoint
 * (G9 Surface 1 + Surface 2, 2026-05-16).
 *
 * Routes:
 *   GET    /api/v1/properties/:propertyId/blocks?from=&to=
 *   POST   /api/v1/properties/:propertyId/blocks
 *   GET    /api/v1/properties/:propertyId/availability?roomTypeId=&from=&to=
 *   GET    /api/v1/blocks/:id
 *   PATCH  /api/v1/blocks/:id
 *   DELETE /api/v1/blocks/:id
 *
 * Availability endpoint joins bookings + blocks — placed here (not booking
 * routes) because it depends on both domains and the property-block factory
 * already has both deps wired (boooking.repo + room.service).
 */
const propertyParam = z.object({ propertyId: idSchema('property') })

export function createPropertyBlockRoutes(
	f: PropertyBlockFactory,
	bookingRepo: BookingRepo,
	roomService: RoomService,
	idempotency: IdempotencyMiddleware,
) {
	const { service } = f
	return (
		new Hono<AppEnv>()
			.use('*', authMiddleware(), tenantMiddleware())
			// G11 (2026-05-16): idempotency-key replay safety для offline mutation
			// queue. Same key + same body → cached response; same key + different
			// body → 422. Required prerequisite per backend recon canon — POST
			// /blocks previously lacked it, blocking offline replay.
			.use('*', idempotency)
			.get(
				'/properties/:propertyId/blocks',
				zValidator('param', propertyParam),
				zValidator('query', propertyBlockListParams),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const { from, to } = c.req.valid('query')
					const items = await service.listByPropertyWindow(c.var.tenantId, propertyId, from, to)
					return c.json({ data: items }, 200)
				},
			)
			.post(
				'/properties/:propertyId/blocks',
				zValidator('param', propertyParam),
				zValidator('json', propertyBlockCreateInput),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const input = c.req.valid('json')
					const result = await service.createBlocks(c.var.tenantId, propertyId, input, {
						actorUserId: c.var.user.id,
					})
					return c.json({ data: result }, 201)
				},
			)
			.get(
				'/properties/:propertyId/availability',
				zValidator('param', propertyParam),
				zValidator('query', availabilityCheckParams),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const { roomTypeId, from, to } = c.req.valid('query')

					// 1) Active rooms of this type
					const rooms = await roomService.listByProperty(c.var.tenantId, propertyId, {
						includeInactive: false,
						roomTypeId,
					})
					const activeRoomIds = new Set(rooms.map((r) => r.id))
					const totalRooms = activeRoomIds.size

					// 2) Bookings touching window — count UNIQUE assigned roomIds.
					// Unassigned confirmed bookings ALSO count against capacity (they
					// will need a room of this type), match Cloudbeds behaviour.
					const bookings = await bookingRepo.listAssignedBookingsByRoomTypeWindow(
						c.var.tenantId,
						propertyId,
						roomTypeId,
						from,
						to,
					)
					const bookedRoomIds = new Set(
						bookings
							.map((b) => b.assignedRoomId)
							.filter((r): r is string => r !== null && activeRoomIds.has(r)),
					)
					// Plus unassigned bookings of this roomType in window — each
					// reserves one room of capacity though no specific room is pinned.
					const allBookings = await bookingRepo.listByProperty(c.var.tenantId, propertyId, {
						from,
						to,
						roomTypeId,
					})
					const unassignedConfirmedCount = allBookings.filter(
						(b) =>
							b.assignedRoomId === null &&
							(b.status === 'confirmed' || b.status === 'in_house') &&
							b.checkIn < to &&
							b.checkOut > from,
					).length

					// 3) Blocks in window for this property — narrow к rooms of this type
					const blockedAll = await f.repo.listBlockedRoomIdsInWindow(
						c.var.tenantId,
						propertyId,
						from,
						to,
					)
					const blockedRoomIds = new Set(blockedAll.filter((rid) => activeRoomIds.has(rid)))

					// Capacity math: a room is unavailable if booked OR blocked
					const unavailableRoomIds = new Set<string>([...bookedRoomIds, ...blockedRoomIds])
					const pinnedUnavailable = unavailableRoomIds.size
					const availableCount = Math.max(
						0,
						totalRooms - pinnedUnavailable - unassignedConfirmedCount,
					)

					const result: AvailabilityCheckResult = {
						roomTypeId,
						from,
						to,
						totalRooms,
						bookedCount: bookedRoomIds.size + unassignedConfirmedCount,
						blockedCount: blockedRoomIds.size,
						availableCount,
					}
					return c.json({ data: result }, 200)
				},
			)
			.get('/blocks/:id', zValidator('param', propertyBlockIdParam), async (c) => {
				const { id } = c.req.valid('param')
				const item = await service.getById(c.var.tenantId, id)
				if (!item) throw new PropertyBlockNotFoundError(id)
				return c.json({ data: item }, 200)
			})
			.patch(
				'/blocks/:id',
				zValidator('param', propertyBlockIdParam),
				zValidator('json', propertyBlockUpdateInput),
				async (c) => {
					const { id } = c.req.valid('param')
					const input = c.req.valid('json')
					const updated = await service.update(c.var.tenantId, id, input)
					return c.json({ data: updated }, 200)
				},
			)
			.delete('/blocks/:id', zValidator('param', propertyBlockIdParam), async (c) => {
				const { id } = c.req.valid('param')
				const ok = await service.delete(c.var.tenantId, id)
				if (!ok) throw new PropertyBlockNotFoundError(id)
				return c.json({ data: { id, deleted: true } }, 200)
			})
	)
}
