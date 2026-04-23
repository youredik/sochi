import { zValidator } from '@hono/zod-validator'
import {
	roomCreateInput,
	roomIdParam,
	roomListParams,
	roomPropertyParam,
	roomUpdateInput,
} from '@horeca/shared'
import { Hono } from 'hono'
import { NotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { RoomFactory } from './room.factory.ts'

/**
 * Room routes.
 * List is nested under /properties/:pid/rooms (optional ?roomTypeId=...).
 * Create is POST /rooms (roomTypeId in body — service resolves parent property).
 * Item ops are flat /rooms/:id.
 *
 * Error handling: domain errors (PropertyNotFoundError / RoomTypeNotFoundError /
 * RoomNumberTakenError) are thrown by the service layer and caught by the
 * global `app.onError` handler in `app.ts`, mapped to 404/409 via
 * `HTTP_STATUS_MAP`. Routes only handle the "getById returned null" case where
 * the domain didn't have enough context to throw.
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
				// Under exactOptionalPropertyTypes we must omit `roomTypeId` instead of
				// passing `undefined` — the listByProperty signature declares it optional.
				const items = await service.listByProperty(c.var.tenantId, propertyId, {
					includeInactive,
					...(roomTypeId ? { roomTypeId } : {}),
				})
				return c.json({ data: items }, 200)
			},
		)
		.post('/rooms', zValidator('json', roomCreateInput), async (c) => {
			const input = c.req.valid('json')
			const created = await service.create(c.var.tenantId, input)
			return c.json({ data: created }, 201)
		})
		.get('/rooms/:id', zValidator('param', roomIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const item = await service.getById(c.var.tenantId, id)
			if (!item) throw new NotFoundError('Room', id)
			return c.json({ data: item }, 200)
		})
		.patch(
			'/rooms/:id',
			zValidator('param', roomIdParam),
			zValidator('json', roomUpdateInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const patch = c.req.valid('json')
				const updated = await service.update(c.var.tenantId, id, patch)
				if (!updated) throw new NotFoundError('Room', id)
				return c.json({ data: updated }, 200)
			},
		)
		.delete('/rooms/:id', zValidator('param', roomIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const ok = await service.delete(c.var.tenantId, id)
			if (!ok) throw new NotFoundError('Room', id)
			return c.json({ data: { success: true } }, 200)
		})
}
