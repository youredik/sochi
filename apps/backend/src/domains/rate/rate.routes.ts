import { zValidator } from '@hono/zod-validator'
import {
	rateBulkUpsertInput,
	rateDateParam,
	rateRangeParams,
	rateRatePlanParam,
} from '@horeca/shared'
import { Hono } from 'hono'
import { NotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { RateFactory } from './rate.factory.ts'

/**
 * Rate routes — nested under rate-plan because a rate's PK includes
 * `ratePlanId` (and propertyId/roomTypeId resolved from it). Shapes:
 *
 *   GET    /api/v1/rate-plans/:ratePlanId/rates?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   POST   /api/v1/rate-plans/:ratePlanId/rates            — bulk upsert
 *   GET    /api/v1/rate-plans/:ratePlanId/rates/:date      — one day
 *   DELETE /api/v1/rate-plans/:ratePlanId/rates/:date      — remove one day
 */
export function createRateRoutes(f: RateFactory) {
	const { service } = f

	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get(
			'/rate-plans/:ratePlanId/rates',
			zValidator('param', rateRatePlanParam),
			zValidator('query', rateRangeParams),
			async (c) => {
				const { ratePlanId } = c.req.valid('param')
				const { from, to } = c.req.valid('query')
				const items = await service.listRange(c.var.tenantId, ratePlanId, { from, to })
				return c.json({ data: items }, 200)
			},
		)
		.post(
			'/rate-plans/:ratePlanId/rates',
			zValidator('param', rateRatePlanParam),
			zValidator('json', rateBulkUpsertInput),
			async (c) => {
				const { ratePlanId } = c.req.valid('param')
				const input = c.req.valid('json')
				const items = await service.bulkUpsert(c.var.tenantId, ratePlanId, input)
				return c.json({ data: items }, 200)
			},
		)
		.get('/rate-plans/:ratePlanId/rates/:date', zValidator('param', rateDateParam), async (c) => {
			const { ratePlanId, date } = c.req.valid('param')
			const item = await service.getOne(c.var.tenantId, ratePlanId, date)
			if (!item) throw new NotFoundError('Rate', `${ratePlanId} / ${date}`)
			return c.json({ data: item }, 200)
		})
		.delete(
			'/rate-plans/:ratePlanId/rates/:date',
			zValidator('param', rateDateParam),
			async (c) => {
				const { ratePlanId, date } = c.req.valid('param')
				const ok = await service.deleteOne(c.var.tenantId, ratePlanId, date)
				if (!ok) throw new NotFoundError('Rate', `${ratePlanId} / ${date}`)
				return c.json({ data: { success: true } }, 200)
			},
		)
}
