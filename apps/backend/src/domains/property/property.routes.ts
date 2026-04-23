import { zValidator } from '@hono/zod-validator'
import {
	propertyCreateInput,
	propertyIdParam,
	propertyListParams,
	propertyUpdateInput,
} from '@horeca/shared'
import { Hono } from 'hono'
import { NotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { PropertyFactory } from './property.factory.ts'

/**
 * Property CRUD routes.
 * All endpoints require auth + active organization. The tenantId is pulled
 * from session by tenantMiddleware — clients never pass it explicitly.
 * Returns are wrapped in `{ data: ... }` for a stable envelope across domains.
 */
export function createPropertyRoutes(f: PropertyFactory) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get('/', zValidator('query', propertyListParams), async (c) => {
			const { includeInactive } = c.req.valid('query')
			const items = await service.list(c.var.tenantId, includeInactive)
			return c.json({ data: items }, 200)
		})
		.get('/:id', zValidator('param', propertyIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const item = await service.getById(c.var.tenantId, id)
			if (!item) throw new NotFoundError('Property', id)
			return c.json({ data: item }, 200)
		})
		.post('/', zValidator('json', propertyCreateInput), async (c) => {
			const input = c.req.valid('json')
			const created = await service.create(c.var.tenantId, input)
			return c.json({ data: created }, 201)
		})
		.patch(
			'/:id',
			zValidator('param', propertyIdParam),
			zValidator('json', propertyUpdateInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const patch = c.req.valid('json')
				const updated = await service.update(c.var.tenantId, id, patch)
				if (!updated) throw new NotFoundError('Property', id)
				return c.json({ data: updated }, 200)
			},
		)
		.delete('/:id', zValidator('param', propertyIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const ok = await service.delete(c.var.tenantId, id)
			if (!ok) throw new NotFoundError('Property', id)
			return c.json({ data: { success: true } }, 200)
		})
}
