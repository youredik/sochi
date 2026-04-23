import { zValidator } from '@hono/zod-validator'
import {
	roomTypeCreateInput,
	roomTypeIdParam,
	roomTypeListParams,
	roomTypePropertyParam,
	roomTypeUpdateInput,
} from '@horeca/shared'
import { Hono } from 'hono'
import { NotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { RoomTypeFactory } from './roomType.factory.ts'

/**
 * RoomType routes. List/create nested under /properties/:pid/room-types,
 * item ops flat under /room-types/:id. Mount at /api/v1.
 *
 * Domain errors (PropertyNotFoundError) are handled by app.onError.
 */
export function createRoomTypeRoutes(f: RoomTypeFactory) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get(
			'/properties/:propertyId/room-types',
			zValidator('param', roomTypePropertyParam),
			zValidator('query', roomTypeListParams),
			async (c) => {
				const { propertyId } = c.req.valid('param')
				const { includeInactive } = c.req.valid('query')
				const items = await service.listByProperty(c.var.tenantId, propertyId, includeInactive)
				return c.json({ data: items }, 200)
			},
		)
		.post(
			'/properties/:propertyId/room-types',
			zValidator('param', roomTypePropertyParam),
			zValidator('json', roomTypeCreateInput),
			async (c) => {
				const { propertyId } = c.req.valid('param')
				const input = c.req.valid('json')
				const created = await service.create(c.var.tenantId, propertyId, input)
				return c.json({ data: created }, 201)
			},
		)
		.get('/room-types/:id', zValidator('param', roomTypeIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const item = await service.getById(c.var.tenantId, id)
			if (!item) throw new NotFoundError('RoomType', id)
			return c.json({ data: item }, 200)
		})
		.patch(
			'/room-types/:id',
			zValidator('param', roomTypeIdParam),
			zValidator('json', roomTypeUpdateInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const patch = c.req.valid('json')
				const updated = await service.update(c.var.tenantId, id, patch)
				if (!updated) throw new NotFoundError('RoomType', id)
				return c.json({ data: updated }, 200)
			},
		)
		.delete('/room-types/:id', zValidator('param', roomTypeIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const ok = await service.delete(c.var.tenantId, id)
			if (!ok) throw new NotFoundError('RoomType', id)
			return c.json({ data: { success: true } }, 200)
		})
}
