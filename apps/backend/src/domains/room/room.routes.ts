import {
	roomCreateInput,
	roomIdParam,
	roomListParams,
	roomPropertyParam,
	roomUpdateInput,
} from '@horeca/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import { PropertyNotFoundError } from '../roomType/roomType.service.ts'
import type { RoomFactory } from './room.factory.ts'
import { RoomTypeNotFoundError } from './room.service.ts'

/**
 * Room routes.
 * List is nested under /properties/:pid/rooms (optional ?roomTypeId=...).
 * Create is POST /room-types/:roomTypeId/rooms so the parent is in the URL,
 * which matches how housekeeping and rooming-list UIs will be shaped.
 * Item ops are flat /rooms/:id.
 */
export function createRoomRoutes(f: RoomFactory) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get(
			'/properties/:propertyId/rooms',
			zValidator('param', roomPropertyParam),
			zValidator('query', roomListParams),
			async (c) => {
				const { propertyId } = c.req.valid('param')
				const { includeInactive, roomTypeId } = c.req.valid('query')
				try {
					const items = await service.listByProperty(c.var.tenantId, propertyId, {
						includeInactive,
						roomTypeId,
					})
					return c.json({ data: items }, 200)
				} catch (err) {
					if (err instanceof PropertyNotFoundError) {
						return c.json({ error: { code: 'NOT_FOUND', message: 'Property not found' } }, 404)
					}
					if (err instanceof RoomTypeNotFoundError) {
						return c.json({ error: { code: 'NOT_FOUND', message: 'Room type not found' } }, 404)
					}
					throw err
				}
			},
		)
		.post('/rooms', zValidator('json', roomCreateInput), async (c) => {
			const input = c.req.valid('json')
			try {
				const created = await service.create(c.var.tenantId, input)
				return c.json({ data: created }, 201)
			} catch (err) {
				if (err instanceof RoomTypeNotFoundError) {
					return c.json({ error: { code: 'NOT_FOUND', message: 'Room type not found' } }, 404)
				}
				throw err
			}
		})
		.get('/rooms/:id', zValidator('param', roomIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const item = await service.getById(c.var.tenantId, id)
			if (!item) {
				return c.json({ error: { code: 'NOT_FOUND', message: 'Room not found' } }, 404)
			}
			return c.json({ data: item }, 200)
		})
		.patch(
			'/rooms/:id',
			zValidator('param', roomIdParam),
			zValidator('json', roomUpdateInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const patch = c.req.valid('json')
				try {
					const updated = await service.update(c.var.tenantId, id, patch)
					if (!updated) {
						return c.json({ error: { code: 'NOT_FOUND', message: 'Room not found' } }, 404)
					}
					return c.json({ data: updated }, 200)
				} catch (err) {
					if (err instanceof RoomTypeNotFoundError) {
						return c.json({ error: { code: 'NOT_FOUND', message: 'Room type not found' } }, 404)
					}
					throw err
				}
			},
		)
		.delete('/rooms/:id', zValidator('param', roomIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const ok = await service.delete(c.var.tenantId, id)
			if (!ok) {
				return c.json({ error: { code: 'NOT_FOUND', message: 'Room not found' } }, 404)
			}
			return c.json({ data: { success: true } }, 200)
		})
}
