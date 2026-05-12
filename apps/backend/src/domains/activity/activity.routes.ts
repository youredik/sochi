import { zValidator } from '@hono/zod-validator'
import { activityListParams, activityRecentParams } from '@horeca/shared'
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
 *   GET /api/v1/activity/recent?limit=20  (A.bis.3 — operator dashboard feed)
 *
 * `/activity/recent` is declared BEFORE `/activity` so Hono's first-match
 * routing surfaces the dashboard endpoint without colliding with the
 * per-record endpoint's zod validator.
 */
export function createActivityRoutes(f: ReturnType<typeof createActivityFactory>) {
	const { repo } = f
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get('/activity/recent', zValidator('query', activityRecentParams), async (c) => {
			const { limit } = c.req.valid('query')
			const items = await repo.listRecent(c.var.tenantId, limit)
			return c.json({ data: items }, 200)
		})
		.get('/activity', zValidator('query', activityListParams), async (c) => {
			const { objectType, recordId, limit } = c.req.valid('query')
			const items = await repo.listForRecord(c.var.tenantId, objectType, recordId, limit)
			return c.json({ data: items }, 200)
		})
}
