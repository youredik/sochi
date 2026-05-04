/**
 * Admin channel routes — M10 / A7.5.fix.
 *
 * Operator-facing read endpoint для admin channel-status overlay UI:
 *   GET /api/admin/channels — list channelConnection rows for current tenant
 *
 * Permissions: `report:read` (owner + manager). Staff cannot view connections.
 *
 * Returns canonical shape consumable by `<ChannelStatusOverlay>` React component.
 */

import { Hono } from 'hono'
import type { ChannelFactory } from '../../domains/channel/channel.factory.ts'
import type { AppEnv } from '../../factory.ts'
import { authMiddleware } from '../../middleware/auth.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../middleware/tenant.ts'

const CHANNEL_DISPLAY_NAMES: Record<string, string> = {
	TL: 'TravelLine',
	YT: 'Яндекс.Путешествия',
	ETG: 'Ostrovok ETG',
}

export function createAdminChannelRoutesInner(channelFactory: ChannelFactory) {
	return new Hono<AppEnv>()
		.use('*', requirePermission({ report: ['read'] }))
		.get('/channels', async (c) => {
			const tenantId = c.var.tenantId
			const connections = await channelFactory.connectionRepo.listByTenant(tenantId)
			const rows = connections.map((conn) => ({
				channelId: conn.channelId,
				displayName: CHANNEL_DISPLAY_NAMES[conn.channelId] ?? conn.channelId,
				mode: conn.mode,
				syncStatus: conn.syncStatus,
				lastSyncAt: conn.lastSyncAt,
				errorMessage:
					conn.syncStatus === 'error' || conn.syncStatus === 'auto_disabled'
						? conn.autoDisabledReason
						: null,
				isEnabled: conn.isEnabled,
			}))
			return c.json({ data: rows }, 200)
		})
}

export function createAdminChannelRoutes(channelFactory: ChannelFactory) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.route('/', createAdminChannelRoutesInner(channelFactory))
}
