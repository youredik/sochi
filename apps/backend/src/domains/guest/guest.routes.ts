import { zValidator } from '@hono/zod-validator'
import { guestCreateInput, guestIdParam, guestUpdateInput } from '@horeca/shared'
import { Hono } from 'hono'
import { NotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../middleware/idempotency.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { createGuestFactory } from './guest.factory.ts'

/**
 * Guest routes.
 *   GET    /api/v1/guests
 *   POST   /api/v1/guests
 *   GET    /api/v1/guests/:id
 *   PATCH  /api/v1/guests/:id
 *   DELETE /api/v1/guests/:id
 */
export function createGuestRoutes(
	f: ReturnType<typeof createGuestFactory>,
	idempotency: IdempotencyMiddleware,
) {
	const { service } = f
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.use('*', idempotency)
		.get('/guests', async (c) => {
			const items = await service.list(c.var.tenantId)
			return c.json({ data: items }, 200)
		})
		.post('/guests', zValidator('json', guestCreateInput), async (c) => {
			const input = c.req.valid('json')
			const created = await service.create(c.var.tenantId, input)
			return c.json({ data: created }, 201)
		})
		.get('/guests/:id', zValidator('param', guestIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const item = await service.getById(c.var.tenantId, id)
			if (!item) throw new NotFoundError('Guest', id)
			return c.json({ data: item }, 200)
		})
		.patch(
			'/guests/:id',
			zValidator('param', guestIdParam),
			zValidator('json', guestUpdateInput),
			async (c) => {
				const { id } = c.req.valid('param')
				const patch = c.req.valid('json')
				const updated = await service.update(c.var.tenantId, id, patch)
				if (!updated) throw new NotFoundError('Guest', id)
				return c.json({ data: updated }, 200)
			},
		)
		.delete('/guests/:id', zValidator('param', guestIdParam), async (c) => {
			const { id } = c.req.valid('param')
			const ok = await service.delete(c.var.tenantId, id)
			if (!ok) throw new NotFoundError('Guest', id)
			return c.json({ data: { success: true } }, 200)
		})
}
