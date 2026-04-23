import { zValidator } from '@hono/zod-validator'
import {
	ratePlanCreateInput,
	ratePlanIdParam,
	ratePlanListParams,
	ratePlanPropertyParam,
	ratePlanUpdateInput,
} from '@horeca/shared'
import { Hono } from 'hono'
import { NotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { RatePlanFactory } from './ratePlan.factory.ts'

/**
 * RatePlan routes. Same shape as room.routes:
 *   GET    /api/v1/properties/:propertyId/rate-plans  — list, optional ?roomTypeId
 *   POST   /api/v1/rate-plans                         — create (roomTypeId in body)
 *   GET    /api/v1/rate-plans/:id                     — one
 *   PATCH  /api/v1/rate-plans/:id                     — patch
 *   DELETE /api/v1/rate-plans/:id                     — delete
 */
export function createRatePlanRoutes(f: RatePlanFactory) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get(
			'/properties/:propertyId/rate-plans',
			zValidator('param', ratePlanPropertyParam),
			zValidator('query', ratePlanListParams),
			async (c) => {
				const { propertyId } = c.req.valid('param')
				const { includeInactive, roomTypeId } = c.req.valid('query')
				const items = await service.listByProperty(c.var.tenantId, propertyId, {
					includeInactive,
					...(roomTypeId ? { roomTypeId } : {}),
				})
				return c.json({ data: items }, 200)
			},
		)
		.post('/rate-plans', zValidator('json', ratePlanCreateInput), async (c) => {
			const input = c.req.valid('json')
			const created = await service.create(c.var.tenantId, input)
			return c.json({ data: created }, 201)
		})
		.get('/rate-plans/:id', zValidator('param', ratePlanIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const item = await service.getById(c.var.tenantId, id)
			if (!item) throw new NotFoundError('RatePlan', id)
			return c.json({ data: item }, 200)
		})
		.patch(
			'/rate-plans/:id',
			zValidator('param', ratePlanIdParam),
			zValidator('json', ratePlanUpdateInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const patch = c.req.valid('json')
				const updated = await service.update(c.var.tenantId, id, patch)
				if (!updated) throw new NotFoundError('RatePlan', id)
				return c.json({ data: updated }, 200)
			},
		)
		.delete('/rate-plans/:id', zValidator('param', ratePlanIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const ok = await service.delete(c.var.tenantId, id)
			if (!ok) throw new NotFoundError('RatePlan', id)
			return c.json({ data: { success: true } }, 200)
		})
}
