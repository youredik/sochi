import { zValidator } from '@hono/zod-validator'
import { activityListParams, activityRecentParams, filterActivitiesByRole } from '@horeca/shared'
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
 *
 * **RBAC filtering on `/activity/recent`** (A.bis.5 fix-up — bug A3.1 from
 * senior bug hunt 2026-05-12): the recent-activity dashboard surface is
 * shown to all 3 roles (owner/manager/staff). Staff lacks
 * `notification:read` / `refund:read` / `report:read` (channel-gate),
 * so activity entries for those objectTypes must NOT surface in the feed
 * — otherwise staff reads a one-line summary of every notification
 * dispatch / refund / channel sync via the dashboard, even though
 * the underlying detail pages 403 them. Post-filter via the shared
 * `filterActivitiesByRole(items, role)` helper (mirror of rbac.ts).
 *
 * Note on limit semantics: the post-filter may return < limit items
 * when the most-recent N include role-denied types. Acceptable for an
 * operator-glance feed; if a future use case requires «exactly limit
 * after filter» we'll need server-side WHERE-IN, which YDB requires
 * unnesting the array.
 */
export function createActivityRoutes(f: ReturnType<typeof createActivityFactory>) {
	const { repo } = f
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.get('/activity/recent', zValidator('query', activityRecentParams), async (c) => {
			const { limit } = c.req.valid('query')
			const items = await repo.listRecent(c.var.tenantId, limit)
			const filtered = filterActivitiesByRole(items, c.var.memberRole)
			return c.json({ data: filtered }, 200)
		})
		.get('/activity', zValidator('query', activityListParams), async (c) => {
			const { objectType, recordId, limit } = c.req.valid('query')
			const items = await repo.listForRecord(c.var.tenantId, objectType, recordId, limit)
			return c.json({ data: items }, 200)
		})
}
