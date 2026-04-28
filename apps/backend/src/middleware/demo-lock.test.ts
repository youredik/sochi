/**
 * demo-lock middleware — strict tests.
 *
 * Pre-done audit (paste-and-fill):
 *   Operation classification (pure derivation):
 *     [O1] DELETE /api/v1/properties/:id → 'property.delete' blocked
 *     [O2] DELETE /api/v1/room-types/:id → 'roomType.delete' blocked
 *     [O3] DELETE /api/v1/rooms/:id → 'room.delete' blocked
 *     [O4] DELETE /api/auth/organization/:id → 'organization.delete' blocked
 *     [O5] GET /api/v1/properties/:id → null (not destructive)
 *     [O6] DELETE /api/v1/bookings/:id → null (not in blocked list — refresh
 *          cron handles booking cleanup)
 *
 *   Mode-based gating:
 *     [M1] mode='production' + DELETE property → pass-through (no block)
 *     [M2] mode='demo' + DELETE property → 403 DEMO_OPERATION_BLOCKED
 *     [M3] mode='demo' + GET property → pass-through (read allowed)
 *     [M4] mode='demo' + DELETE booking → pass-through (not in blocked list)
 *
 *   Tenant resolution:
 *     [T1] tenantId not set in c.var → pass-through (defensive — middleware
 *          ordering issue)
 *     [T2] tenant row missing in organizationProfile → 'production' default
 *     [T3] mode column null → 'production' default
 */
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NULL_TEXT, toTs } from '../db/ydb-helpers.ts'
import type { AppEnv } from '../factory.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { demoLockMiddleware, loadTenantMode } from './demo-lock.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const RUN_ID = Date.now().toString(36)

async function seedTenantWithMode(
	tenantId: string,
	mode: 'production' | 'demo' | null,
): Promise<void> {
	const sql = getTestSql()
	const nowTs = toTs(new Date())
	const modeValue = mode ?? NULL_TEXT
	await sql`
		UPSERT INTO organizationProfile (
			\`organizationId\`, \`plan\`, \`createdAt\`, \`updatedAt\`, \`mode\`
		) VALUES (
			${tenantId}, ${'free'}, ${nowTs}, ${nowTs}, ${modeValue}
		)
	`
}

function buildApp(tenantId: string | null) {
	const sql = getTestSql()
	const app = new Hono<AppEnv>()
	app.use('*', async (c, next) => {
		// Simulate tenantMiddleware: set c.var.tenantId
		// biome-ignore lint/suspicious/noExplicitAny: simplified tenantId injection for tests
		;(c as any).set('tenantId', tenantId)
		await next()
	})
	app.use('*', demoLockMiddleware(sql))
	app.delete('/api/v1/properties/:id', (c) => c.json({ ok: true }, 200))
	app.delete('/api/v1/room-types/:id', (c) => c.json({ ok: true }, 200))
	app.delete('/api/v1/rooms/:id', (c) => c.json({ ok: true }, 200))
	app.delete('/api/v1/bookings/:id', (c) => c.json({ ok: true }, 200))
	app.get('/api/v1/properties/:id', (c) => c.json({ ok: true }, 200))
	return app
}

describe('demo-lock middleware — mode-based gating', { tags: ['db'] }, () => {
	test('[M1] production tenant + DELETE property → 200 pass-through', async () => {
		const tenantId = `org_demo_lock_prod_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`
		await seedTenantWithMode(tenantId, 'production')
		const res = await buildApp(tenantId).request('/api/v1/properties/abc', {
			method: 'DELETE',
		})
		expect(res.status).toBe(200)
	})

	test('[M2] demo tenant + DELETE property → 403 DEMO_OPERATION_BLOCKED', async () => {
		const tenantId = `org_demo_lock_demo_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`
		await seedTenantWithMode(tenantId, 'demo')
		const res = await buildApp(tenantId).request('/api/v1/properties/abc', {
			method: 'DELETE',
		})
		expect(res.status).toBe(403)
		const body = (await res.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe('DEMO_OPERATION_BLOCKED')
		expect(body.error.message).toContain('demo mode')
	})

	test('[M3] demo tenant + GET property → 200 pass-through (reads always allowed)', async () => {
		const tenantId = `org_demo_lock_read_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`
		await seedTenantWithMode(tenantId, 'demo')
		const res = await buildApp(tenantId).request('/api/v1/properties/abc', {
			method: 'GET',
		})
		expect(res.status).toBe(200)
	})

	test('[M4] demo tenant + DELETE booking → 200 (NOT in blocked list)', async () => {
		const tenantId = `org_demo_lock_book_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`
		await seedTenantWithMode(tenantId, 'demo')
		const res = await buildApp(tenantId).request('/api/v1/bookings/abc', {
			method: 'DELETE',
		})
		expect(res.status).toBe(200)
	})

	test('[M5] demo tenant + DELETE roomType → 403 (in blocked list)', async () => {
		const tenantId = `org_demo_lock_rt_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`
		await seedTenantWithMode(tenantId, 'demo')
		const res = await buildApp(tenantId).request('/api/v1/room-types/abc', {
			method: 'DELETE',
		})
		expect(res.status).toBe(403)
	})

	test('[M6] demo tenant + DELETE room → 403 (in blocked list)', async () => {
		const tenantId = `org_demo_lock_rm_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`
		await seedTenantWithMode(tenantId, 'demo')
		const res = await buildApp(tenantId).request('/api/v1/rooms/abc', {
			method: 'DELETE',
		})
		expect(res.status).toBe(403)
	})
})

describe('demo-lock middleware — tenant resolution', { tags: ['db'] }, () => {
	test('[T1] tenantId not set → pass-through (no block)', async () => {
		const res = await buildApp(null).request('/api/v1/properties/abc', {
			method: 'DELETE',
		})
		expect(res.status).toBe(200)
	})

	test('[T2] tenant row missing → production default → pass-through', async () => {
		const res = await buildApp(`nonexistent-tenant-${RUN_ID}`).request('/api/v1/properties/abc', {
			method: 'DELETE',
		})
		expect(res.status).toBe(200)
	})

	test('[T3] mode column null → production default → pass-through', async () => {
		const tenantId = `org_demo_lock_null_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`
		await seedTenantWithMode(tenantId, null)
		const res = await buildApp(tenantId).request('/api/v1/properties/abc', {
			method: 'DELETE',
		})
		expect(res.status).toBe(200)
	})

	test('[T4] loadTenantMode helper isolated lookup', async () => {
		const sql = getTestSql()
		const tenantId = `org_demo_lock_helper_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`
		await seedTenantWithMode(tenantId, 'demo')
		const mode = await loadTenantMode(sql, tenantId)
		expect(mode).toBe('demo')
	})
})
