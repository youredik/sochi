/**
 * Strict tests для widget-tenant-resolver middleware.
 *
 * Test matrix:
 *   ─── Happy path ──────────────────────────────────────────────
 *     [WTR1] Known slug → c.var.tenantId set, c.var.tenant set, handler reached
 *     [WTR2] Mode demo propagates в c.var.tenant
 *     [WTR3] Mode production propagates в c.var.tenant
 *     [WTR4] Mode null (tenant без organizationProfile) propagates
 *
 *   ─── 404 paths ───────────────────────────────────────────────
 *     [WTR5] Unknown slug → 404 NOT_FOUND, handler not reached
 *     [WTR6] Empty slug param → 404 NOT_FOUND
 *     [WTR7] Malformed slug (Cyrillic) → 404 (resolver returns null)
 *
 *   ─── Idempotency middleware integration (downstream c.var.tenantId) ─
 *     [WTR8] Existing idempotencyMiddleware works AS-IS after widget-tenant-resolver
 *           (platform-first canon — no fork)
 */
import { newId } from '@horeca/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { onError } from '../errors/on-error.ts'
import type { AppEnv } from '../factory.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { createIdempotencyRepo } from './idempotency.repo.ts'
import { idempotencyMiddleware } from './idempotency.ts'
import { widgetTenantResolverMiddleware } from './widget-tenant-resolver.ts'

describe('widget-tenant-resolver middleware', { tags: ['db'], timeout: 30_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	async function seedTenant(opts: { slug: string; mode?: 'demo' | 'production' | null }) {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const now = new Date()
		await sql`
			UPSERT INTO organization (id, name, slug, createdAt)
			VALUES (${tenantId}, ${'Test'}, ${opts.slug}, ${now})
		`
		if (opts.mode !== undefined) {
			await sql`
				UPSERT INTO organizationProfile (organizationId, plan, createdAt, updatedAt, mode)
				VALUES (${tenantId}, ${'free'}, ${now}, ${now}, ${opts.mode})
			`
		}
		return { tenantId }
	}

	function buildApp() {
		const app = new Hono<AppEnv>()
			.use('/widget/:tenantSlug/*', widgetTenantResolverMiddleware())
			.post('/widget/:tenantSlug/booking', (c) => {
				return c.json(
					{
						tenantId: c.var.tenantId,
						tenant: c.var.tenant,
					},
					200,
				)
			})
		app.onError(onError)
		return app
	}

	test('[WTR1] Known slug → tenantId + tenant set, handler reached', async () => {
		const slug = `wtr1-${Date.now().toString(36)}`
		const { tenantId } = await seedTenant({ slug })
		const app = buildApp()
		const res = await app.request(`/widget/${slug}/booking`, { method: 'POST', body: '{}' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { tenantId: string; tenant: { slug: string; mode: unknown } }
		expect(body.tenantId).toBe(tenantId)
		expect(body.tenant.slug).toBe(slug)
	})

	test('[WTR2] mode=demo propagates в c.var.tenant', async () => {
		const slug = `wtr2-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'demo' })
		const app = buildApp()
		const res = await app.request(`/widget/${slug}/booking`, { method: 'POST', body: '{}' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { tenant: { mode: string | null } }
		expect(body.tenant.mode).toBe('demo')
	})

	test('[WTR3] mode=production propagates', async () => {
		const slug = `wtr3-${Date.now().toString(36)}`
		await seedTenant({ slug, mode: 'production' })
		const app = buildApp()
		const res = await app.request(`/widget/${slug}/booking`, { method: 'POST', body: '{}' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { tenant: { mode: string | null } }
		expect(body.tenant.mode).toBe('production')
	})

	test('[WTR4] mode=null (no organizationProfile) propagates as null', async () => {
		const slug = `wtr4-${Date.now().toString(36)}`
		await seedTenant({ slug })
		const app = buildApp()
		const res = await app.request(`/widget/${slug}/booking`, { method: 'POST', body: '{}' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { tenant: { mode: string | null } }
		expect(body.tenant.mode).toBeNull()
	})

	test('[WTR5] Unknown slug → 404, handler не достигнут', async () => {
		const handler = vi.fn(() => Response.json({ ok: true }))
		const app = new Hono<AppEnv>()
			.use('/widget/:tenantSlug/*', widgetTenantResolverMiddleware())
			.post('/widget/:tenantSlug/booking', handler)

		const res = await app.request(`/widget/never-exists-${Date.now()}/booking`, {
			method: 'POST',
			body: '{}',
		})
		expect(res.status).toBe(404)
		expect(handler).not.toHaveBeenCalled()
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('NOT_FOUND')
	})

	test('[WTR6] Empty slug param → 404 (timing-safe)', async () => {
		const app = buildApp()
		// Hono routing won't match empty param; simulate via direct param=''
		// (unreachable via valid URL — but defensive code path)
		const res = await app.request('/widget//booking', { method: 'POST', body: '{}' })
		// Hono returns 404 for malformed paths
		expect(res.status).toBe(404)
	})

	test('[WTR7] Malformed slug (Cyrillic, non-ASCII) → 404', async () => {
		const app = buildApp()
		const res = await app.request(`/widget/${encodeURIComponent('демо')}/booking`, {
			method: 'POST',
			body: '{}',
		})
		expect(res.status).toBe(404)
	})

	test('[WTR8] Existing idempotencyMiddleware composes seamlessly (platform-first)', async () => {
		const slug = `wtr8-${Date.now().toString(36)}`
		await seedTenant({ slug })
		const repo = createIdempotencyRepo(getTestSql())
		const app = new Hono<AppEnv>()
			.use('/widget/:tenantSlug/*', widgetTenantResolverMiddleware())
			.use('/widget/:tenantSlug/*', idempotencyMiddleware(repo))
			.post('/widget/:tenantSlug/booking', (c) => c.json({ ok: true, t: Date.now() }, 200))

		const idempKey = `wtr8-key-${Date.now()}`
		const res1 = await app.request(`/widget/${slug}/booking`, {
			method: 'POST',
			body: '{"a":1}',
			headers: { 'Idempotency-Key': idempKey, 'Content-Type': 'application/json' },
		})
		expect(res1.status).toBe(200)
		const body1 = await res1.text()

		// Replay — same key + same body → idempotency middleware returns cached
		const res2 = await app.request(`/widget/${slug}/booking`, {
			method: 'POST',
			body: '{"a":1}',
			headers: { 'Idempotency-Key': idempKey, 'Content-Type': 'application/json' },
		})
		expect(res2.status).toBe(200)
		const body2 = await res2.text()
		expect(body2).toBe(body1) // cached, NOT re-run
	})
})
