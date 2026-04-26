import { zValidator } from '@hono/zod-validator'
import { notificationIdParam, notificationListParams } from '@horeca/shared'
import { Hono } from 'hono'
import type { NotificationService } from '../../domains/notification/notification.service.ts'
import { NotificationAlreadySentError, NotificationNotFoundError } from '../../errors/domain.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'

/**
 * Admin notifications console routes — `/api/admin/notifications/*`.
 *
 *   GET  /                  — cursor-paginated list (filters: status/kind/
 *                              recipient/from/to/limit/cursor)
 *   GET  /:id               — single drill-down with attempt timeline
 *   POST /:id:retry         — operator-triggered retry (idempotent — repeated
 *                              clicks against same row are safe; row stays
 *                              `pending` after first reset, follow-up clicks
 *                              just re-write the same fields)
 *
 * Permissions: `notification:read` (list/get), `notification:retry` (POST).
 * Owner + manager only — staff cannot.
 */
export function createAdminNotificationsRoutesInner(service: NotificationService) {
	return new Hono<AppEnv>()
		.get(
			'/notifications',
			requirePermission({ notification: ['read'] }),
			zValidator('query', notificationListParams),
			async (c) => {
				const params = c.req.valid('query')
				const page = await service.list(c.var.tenantId, params)
				return c.json({ data: page }, 200)
			},
		)
		.get(
			'/notifications/:id',
			requirePermission({ notification: ['read'] }),
			zValidator('param', notificationIdParam),
			async (c) => {
				const { id } = c.req.valid('param')
				const detail = await service.getDetail(c.var.tenantId, id)
				if (!detail) throw new NotificationNotFoundError(id)
				return c.json({ data: detail }, 200)
			},
		)
		.post(
			'/notifications/:id/retry',
			requirePermission({ notification: ['retry'] }),
			zValidator('param', notificationIdParam),
			async (c) => {
				const { id } = c.req.valid('param')
				try {
					const detail = await service.markForRetry(c.var.tenantId, id, c.var.user.id)
					return c.json({ data: detail }, 200)
				} catch (err) {
					if (err instanceof NotificationNotFoundError) {
						return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404)
					}
					if (err instanceof NotificationAlreadySentError) {
						return c.json({ error: { code: err.code, message: err.message } }, 409)
					}
					throw err
				}
			},
		)
}

/** Production wrapper — full middleware chain. */
export function createAdminNotificationsRoutes(service: NotificationService) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createAdminNotificationsRoutesInner(service))
}
