import { zValidator } from '@hono/zod-validator'
import {
	bookingCancelInput,
	bookingChangeGuestsCountInput,
	bookingChangeRatePlanInput,
	bookingChangeRoomTypeInput,
	bookingCheckInInput,
	bookingCreateInput,
	bookingIdParam,
	bookingListParams,
	bookingMarkNoShowInput,
	bookingMoveDatesInput,
	bookingPropertyParam,
	tourismTaxReportParams,
} from '@horeca/shared'
import { Hono } from 'hono'
import { BookingNotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../middleware/idempotency.ts'
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
export function createBookingRoutes(f: BookingFactory, idempotency: IdempotencyMiddleware) {
	const { service } = f

	return (
		new Hono<AppEnv>()
			.use('*', authMiddleware(), tenantMiddleware())
			.use('*', idempotency)
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
			// G5 Apaleo Amend-Stay endpoints — 3 independent atomic operations per
			// service-method canon (mirrors check-in/check-out/cancel separation).
			.patch(
				'/bookings/:id/move-dates',
				zValidator('param', bookingIdParam),
				zValidator('json', bookingMoveDatesInput),
				async (c) => {
					const { id } = c.req.valid('param')
					const input = c.req.valid('json')
					const updated = await service.moveDates(c.var.tenantId, id, input, c.var.user.id)
					if (!updated) throw new BookingNotFoundError(id)
					return c.json({ data: updated }, 200)
				},
			)
			.patch(
				'/bookings/:id/change-rate-plan',
				zValidator('param', bookingIdParam),
				zValidator('json', bookingChangeRatePlanInput),
				async (c) => {
					const { id } = c.req.valid('param')
					const input = c.req.valid('json')
					const updated = await service.changeRatePlan(c.var.tenantId, id, input, c.var.user.id)
					if (!updated) throw new BookingNotFoundError(id)
					return c.json({ data: updated }, 200)
				},
			)
			.patch(
				'/bookings/:id/change-guests-count',
				zValidator('param', bookingIdParam),
				zValidator('json', bookingChangeGuestsCountInput),
				async (c) => {
					const { id } = c.req.valid('param')
					const input = c.req.valid('json')
					const updated = await service.changeGuestsCount(c.var.tenantId, id, input, c.var.user.id)
					if (!updated) throw new BookingNotFoundError(id)
					return c.json({ data: updated }, 200)
				},
			)
			// G7 (2026-05-16) drag-move band к different roomType row OR pointer-
			// alternative «Переместить в категорию» amend dialog (WCAG 2.5.7).
			.patch(
				'/bookings/:id/change-room-type',
				zValidator('param', bookingIdParam),
				zValidator('json', bookingChangeRoomTypeInput),
				async (c) => {
					const { id } = c.req.valid('param')
					const input = c.req.valid('json')
					const updated = await service.moveToRoomType(c.var.tenantId, id, input, c.var.user.id)
					if (!updated) throw new BookingNotFoundError(id)
					return c.json({ data: updated }, 200)
				},
			)
			.get(
				'/properties/:propertyId/reports/tourism-tax',
				zValidator('param', bookingPropertyParam),
				zValidator('query', tourismTaxReportParams),
				async (c) => {
					const { propertyId } = c.req.valid('param')
					const params = c.req.valid('query')
					const report = await service.getTourismTaxReport(c.var.tenantId, propertyId, params)
					return c.json({ data: report }, 200)
				},
			)
	)
}
