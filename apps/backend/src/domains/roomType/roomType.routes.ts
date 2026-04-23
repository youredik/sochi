import { zValidator } from '@hono/zod-validator'
import {
	roomTypeCreateInput,
	roomTypeIdParam,
	roomTypeListParams,
	roomTypePropertyParam,
	roomTypeUpdateInput,
} from '@horeca/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { RoomTypeFactory } from './roomType.factory.ts'
import { PropertyNotFoundError } from './roomType.service.ts'

/**
 * RoomType routes. Uses resource nesting for list/create (`/properties/:pid/room-types`)
 * and flat paths for item-level ops (`/room-types/:id`).
 * Mount at /api/v1.
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
				try {
					const items = await service.listByProperty(c.var.tenantId, propertyId, includeInactive)
					return c.json({ data: items }, 200)
				} catch (err) {
					if (err instanceof PropertyNotFoundError) {
						return c.json({ error: { code: 'NOT_FOUND', message: 'Property not found' } }, 404)
					}
					throw err
				}
			},
		)
		.post(
			'/properties/:propertyId/room-types',
			zValidator('param', roomTypePropertyParam),
			zValidator('json', roomTypeCreateInput),
			async (c) => {
				const { propertyId } = c.req.valid('param')
				const input = c.req.valid('json')
				try {
					const created = await service.create(c.var.tenantId, propertyId, input)
					return c.json({ data: created }, 201)
				} catch (err) {
					if (err instanceof PropertyNotFoundError) {
						return c.json({ error: { code: 'NOT_FOUND', message: 'Property not found' } }, 404)
					}
					throw err
				}
			},
		)
		.get('/room-types/:id', zValidator('param', roomTypeIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const item = await service.getById(c.var.tenantId, id)
			if (!item) {
				return c.json({ error: { code: 'NOT_FOUND', message: 'Room type not found' } }, 404)
			}
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
				if (!updated) {
					return c.json({ error: { code: 'NOT_FOUND', message: 'Room type not found' } }, 404)
				}
				return c.json({ data: updated }, 200)
			},
		)
		.delete('/room-types/:id', zValidator('param', roomTypeIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const ok = await service.delete(c.var.tenantId, id)
			if (!ok) {
				return c.json({ error: { code: 'NOT_FOUND', message: 'Room type not found' } }, 404)
			}
			return c.json({ data: { success: true } }, 200)
		})
}
