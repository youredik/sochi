import { zValidator } from '@hono/zod-validator'
import {
	availabilityBulkUpsertInput,
	availabilityDateParam,
	availabilityRangeParams,
	availabilityRoomTypeParam,
} from '@horeca/shared'
import { Hono } from 'hono'
import { NotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { AvailabilityFactory } from './availability.factory.ts'

/**
 * Availability routes:
 *   GET    /api/v1/room-types/:roomTypeId/availability?from=&to=
 *   POST   /api/v1/room-types/:roomTypeId/availability   — bulk upsert
 *   GET    /api/v1/room-types/:roomTypeId/availability/:date
 *   DELETE /api/v1/room-types/:roomTypeId/availability/:date
 */
export function createAvailabilityRoutes(f: AvailabilityFactory) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get(
			'/room-types/:roomTypeId/availability',
			zValidator('param', availabilityRoomTypeParam),
			zValidator('query', availabilityRangeParams),
			async (c) => {
				const { roomTypeId } = c.req.valid('param')
				const { from, to } = c.req.valid('query')
				const items = await service.listRange(c.var.tenantId, roomTypeId, { from, to })
				return c.json({ data: items }, 200)
			},
		)
		.post(
			'/room-types/:roomTypeId/availability',
			zValidator('param', availabilityRoomTypeParam),
			zValidator('json', availabilityBulkUpsertInput),
			async (c) => {
				const { roomTypeId } = c.req.valid('param')
				const input = c.req.valid('json')
				const items = await service.bulkUpsert(c.var.tenantId, roomTypeId, input)
				return c.json({ data: items }, 200)
			},
		)
		.get(
			'/room-types/:roomTypeId/availability/:date',
			zValidator('param', availabilityDateParam),
			async (c) => {
				const { roomTypeId, date } = c.req.valid('param')
				const item = await service.getOne(c.var.tenantId, roomTypeId, date)
				if (!item) throw new NotFoundError('Availability', `${roomTypeId} / ${date}`)
				return c.json({ data: item }, 200)
			},
		)
		.delete(
			'/room-types/:roomTypeId/availability/:date',
			zValidator('param', availabilityDateParam),
			async (c) => {
				const { roomTypeId, date } = c.req.valid('param')
				const ok = await service.deleteOne(c.var.tenantId, roomTypeId, date)
				if (!ok) throw new NotFoundError('Availability', `${roomTypeId} / ${date}`)
				return c.json({ data: { success: true } }, 200)
			},
		)
}
