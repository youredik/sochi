import { zValidator } from '@hono/zod-validator'
import { activityListParams } from '@horeca/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'
import type { createActivityFactory } from './activity.factory.ts'

/**
 * Activity read API — admin UI uses this to render a record's audit timeline.
 * Write side is CDC-only (see `apps/backend/src/workers/cdc-consumer.ts`);
 * no POST / PATCH / DELETE here by design.
 *
 *   GET /api/v1/activity?objectType=booking&recordId=book_...&limit=50
 */
export function createActivityRoutes(f: ReturnType<typeof createActivityFactory>) {
	const { repo } = f
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get('/activity', zValidator('query', activityListParams), async (c) => {
			const { objectType, recordId, limit } = c.req.valid('query')
			const items = await repo.listForRecord(c.var.tenantId, objectType, recordId, limit)
			return c.json({ data: items }, 200)
		})
}
