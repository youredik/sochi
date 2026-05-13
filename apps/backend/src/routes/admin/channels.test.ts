/**
 * Admin channels route — strict tests AC1-AC4 (M10 / A7.5.fix).
 *
 * Verifies GET /api/admin/channels returns canonical shape consumable by
 * `<ChannelStatusOverlay>`. Uses inner factory bypassing auth/tenant
 * middleware (test sets c.var.tenantId via Hono direct).
 */

import { Hono } from 'hono'
import { describe, expect, it } from 'bun:test'
import type { ChannelFactory } from '../../domains/channel/channel.factory.ts'
import type { AppEnv } from '../../factory.ts'
import { createAdminChannelRoutesInner } from './channels.ts'

function buildStubChannelFactory(
	connections: ReadonlyArray<{
		channelId: string
		mode: 'mock' | 'sandbox' | 'live'
		syncStatus: 'idle' | 'syncing' | 'error' | 'auto_disabled'
		lastSyncAt: string | null
		autoDisabledReason: string | null
		isEnabled: boolean
	}>,
): ChannelFactory {
	return {
		connectionRepo: {
			async listByTenant(tenantId: string) {
				return connections.map((c) => ({
					tenantId,
					propertyId: 'prop_main',
					channelId: c.channelId,
					mode: c.mode,
					role: 'processor_with_dpa' as const,
					credentialsLockboxRef: null,
					dpaSignedAt: null,
					rknOperatorId: null,
					crossBorderNotificationStatus: null,
					syncStatus: c.syncStatus,
					lastSyncAt: c.lastSyncAt,
					autoDisabledReason: c.autoDisabledReason,
					autoDisabledAt: null,
					isEnabled: c.isEnabled,
					createdAt: '2026-05-05T00:00:00.000Z',
					updatedAt: '2026-05-05T00:00:00.000Z',
				}))
			},
			// biome-ignore lint/suspicious/noExplicitAny: stub narrow shape
		} as any,
		// biome-ignore lint/suspicious/noExplicitAny: rest of factory not needed для this test
	} as any
}

function mountRoutes(channelFactory: ChannelFactory) {
	const app = new Hono<AppEnv>()
	app.use('*', async (c, next) => {
		c.set('tenantId', 'org_test_a')
		c.set('memberRole', 'owner')
		await next()
	})
	app.route('/api/admin', createAdminChannelRoutesInner(channelFactory))
	return app
}

describe('GET /api/admin/channels (AC1-AC4)', () => {
	it('[AC1] empty channelConnection → returns empty array', async () => {
		const factory = buildStubChannelFactory([])
		const app = mountRoutes(factory)
		const res = await app.request('/api/admin/channels')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: unknown[] }
		expect(body.data).toEqual([])
	})

	it('[AC2] 3-channel list — TL/YT/ETG returned with displayName mapping', async () => {
		const factory = buildStubChannelFactory([
			{
				channelId: 'TL',
				mode: 'mock',
				syncStatus: 'idle',
				lastSyncAt: '2026-05-05T11:55:00.000Z',
				autoDisabledReason: null,
				isEnabled: true,
			},
			{
				channelId: 'YT',
				mode: 'mock',
				syncStatus: 'syncing',
				lastSyncAt: null,
				autoDisabledReason: null,
				isEnabled: true,
			},
			{
				channelId: 'ETG',
				mode: 'mock',
				syncStatus: 'idle',
				lastSyncAt: null,
				autoDisabledReason: null,
				isEnabled: true,
			},
		])
		const app = mountRoutes(factory)
		const res = await app.request('/api/admin/channels')
		const body = (await res.json()) as { data: Array<{ channelId: string; displayName: string }> }
		expect(body.data).toHaveLength(3)
		const tl = body.data.find((d) => d.channelId === 'TL')
		const yt = body.data.find((d) => d.channelId === 'YT')
		const etg = body.data.find((d) => d.channelId === 'ETG')
		expect(tl?.displayName).toBe('TravelLine')
		expect(yt?.displayName).toBe('Яндекс.Путешествия')
		expect(etg?.displayName).toBe('Ostrovok ETG')
	})

	it('[AC3] error syncStatus → errorMessage populated from autoDisabledReason', async () => {
		const factory = buildStubChannelFactory([
			{
				channelId: 'TL',
				mode: 'mock',
				syncStatus: 'error',
				lastSyncAt: '2026-05-05T11:55:00.000Z',
				autoDisabledReason: 'TL OAuth token rejected (401)',
				isEnabled: true,
			},
		])
		const app = mountRoutes(factory)
		const res = await app.request('/api/admin/channels')
		const body = (await res.json()) as {
			data: Array<{ channelId: string; errorMessage: string | null }>
		}
		expect(body.data[0]?.errorMessage).toBe('TL OAuth token rejected (401)')
	})

	it('[AC4] healthy syncStatus=idle → errorMessage=null even if autoDisabledReason present', async () => {
		const factory = buildStubChannelFactory([
			{
				channelId: 'TL',
				mode: 'mock',
				syncStatus: 'idle',
				lastSyncAt: '2026-05-05T11:55:00.000Z',
				autoDisabledReason: 'old failure cleaned up',
				isEnabled: true,
			},
		])
		const app = mountRoutes(factory)
		const res = await app.request('/api/admin/channels')
		const body = (await res.json()) as {
			data: Array<{ channelId: string; errorMessage: string | null }>
		}
		expect(body.data[0]?.errorMessage).toBeNull()
	})
})
