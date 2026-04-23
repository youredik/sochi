import { zValidator } from '@hono/zod-validator'
import {
	bookingCancelInput,
	bookingCheckInInput,
	bookingCreateInput,
	bookingIdParam,
	bookingListParams,
	bookingMarkNoShowInput,
	bookingPropertyParam,
} from '@horeca/shared'
import { Hono } from 'hono'
import { BookingNotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { BookingFactory } from './booking.factory.ts'

/**
 * Booking routes — full M4b API surface.
 *   GET    /api/v1/properties/:propertyId/bookings
 *   POST   /api/v1/properties/:propertyId/bookings
 *   GET    /api/v1/bookings/:id
 *   PATCH  /api/v1/bookings/:id/cancel
 *   PATCH  /api/v1/bookings/:id/check-in
 *   PATCH  /api/v1/bookings/:id/check-out
 *   PATCH  /api/v1/bookings/:id/no-show
 */
export function createBookingRoutes(f: BookingFactory) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get(
			'/properties/:propertyId/bookings',
			zValidator('param', bookingPropertyParam),
			zValidator('query', bookingListParams),
			async (c) => {
				const { propertyId } = c.req.valid('param')
				const { from, to, status, roomTypeId } = c.req.valid('query')
				const items = await service.listByProperty(c.var.tenantId, propertyId, {
					...(from ? { from } : {}),
					...(to ? { to } : {}),
					...(status ? { status } : {}),
					...(roomTypeId ? { roomTypeId } : {}),
				})
				return c.json({ data: items }, 200)
			},
		)
		.post(
			'/properties/:propertyId/bookings',
			zValidator('param', bookingPropertyParam),
			zValidator('json', bookingCreateInput),
			async (c) => {
				const { propertyId } = c.req.valid('param')
				const input = c.req.valid('json')
				const created = await service.create(c.var.tenantId, propertyId, input, c.var.user.id)
				return c.json({ data: created }, 201)
			},
		)
		.get('/bookings/:id', zValidator('param', bookingIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const item = await service.getById(c.var.tenantId, id)
			if (!item) throw new BookingNotFoundError(id)
			return c.json({ data: item }, 200)
		})
		.patch(
			'/bookings/:id/cancel',
			zValidator('param', bookingIdParam),
			zValidator('json', bookingCancelInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const input = c.req.valid('json')
				const updated = await service.cancel(c.var.tenantId, id, input, c.var.user.id)
				if (!updated) throw new BookingNotFoundError(id)
				return c.json({ data: updated }, 200)
			},
		)
		.patch(
			'/bookings/:id/check-in',
			zValidator('param', bookingIdParam),
			zValidator('json', bookingCheckInInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const input = c.req.valid('json')
				const updated = await service.checkIn(c.var.tenantId, id, input, c.var.user.id)
				if (!updated) throw new BookingNotFoundError(id)
				return c.json({ data: updated }, 200)
			},
		)
		.patch('/bookings/:id/check-out', zValidator('param', bookingIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const updated = await service.checkOut(c.var.tenantId, id, c.var.user.id)
			if (!updated) throw new BookingNotFoundError(id)
			return c.json({ data: updated }, 200)
		})
		.patch(
			'/bookings/:id/no-show',
			zValidator('param', bookingIdParam),
			zValidator('json', bookingMarkNoShowInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const input = c.req.valid('json')
				const updated = await service.markNoShow(c.var.tenantId, id, input, c.var.user.id)
				if (!updated) throw new BookingNotFoundError(id)
				return c.json({ data: updated }, 200)
			},
		)
}
