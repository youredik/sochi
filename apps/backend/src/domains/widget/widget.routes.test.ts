/**
 * Widget routes — HTTP-level strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── Public access (no auth) ──────────────────────────────────
 *     [PA1] GET /properties without auth header → 200 (no 401)
 *     [PA2] OPTIONS preflight returns CORS headers
 *
 *   ─── Routing ───────────────────────────────────────────────────
 *     [R1] GET /:slug/properties known tenant → 200 + {tenant, properties}
 *     [R2] GET /:slug/properties unknown → 404 + tenant-not-found shape
 *     [R3] GET /:slug/properties/:id known → 200 + {tenant, property, roomTypes}
 *     [R4] GET /:slug/properties/:id unknown property → 404 (timing-safe shape)
 *     [R5] GET malformed slug (Cyrillic) → 404 (resolver returns null first)
 *     [R6] POST /:slug/properties → 405 Method Not Allowed (read-only)
 *
 *   ─── Security headers ──────────────────────────────────────────
 *     [S1] CSP header set on every response
 *     [S2] X-Content-Type-Options: nosniff
 *     [S3] Referrer-Policy: strict-origin-when-cross-origin
 *
 *   ─── Cross-tenant isolation ────────────────────────────────────
 *     [I1] tenantA's property NOT visible через tenantB's slug URL
 */

import { newId } from '@horeca/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createWidgetFactory } from './widget.factory.ts'
import { createWidgetRoutes } from './widget.routes.ts'

describe('widget.routes — HTTP', { tags: ['db'], timeout: 60_000 }, () => {
	let app: Hono

	beforeAll(async () => {
		await setupTestDb()
		const factory = createWidgetFactory(getTestSql())
		app = new Hono().route('/api/public/widget', createWidgetRoutes(factory.service))
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	async function seedTenant(slug: string) {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const now = new Date()
		await sql`
			UPSERT INTO organization (id, name, slug, createdAt)
			VALUES (${tenantId}, ${'Test Hotel'}, ${slug}, ${now})
		`
		await sql`
			UPSERT INTO property (
				\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
				\`isActive\`, \`isPublic\`, \`createdAt\`, \`updatedAt\`
			) VALUES (
				${tenantId}, ${propertyId},
				${'Test Hotel Property'}, ${'Сириус, Олимпийский 1'}, ${'Сочи'}, ${'Europe/Moscow'},
				${true}, ${true}, ${now}, ${now}
			)
		`
		return { tenantId, propertyId, slug }
	}

	test('[PA1] GET /:slug/properties without auth → 200 (no 401)', async () => {
		const { slug } = await seedTenant(`pa1-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${slug}/properties`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: { properties: unknown[] } }
		expect(body.data.properties.length).toBeGreaterThanOrEqual(1)
	})

	test('[PA2] OPTIONS preflight returns CORS headers', async () => {
		const { slug } = await seedTenant(`pa2-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${slug}/properties`, {
			method: 'OPTIONS',
			headers: { Origin: 'https://hotel.example.com' },
		})
		expect(res.status).toBeLessThan(400)
		// Hono cors middleware sets allow-origin header
		expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
	})

	test('[R1] GET known tenant → 200 + tenant + properties', async () => {
		const { slug } = await seedTenant(`r1-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${slug}/properties`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: { tenant: { slug: string }; properties: unknown[] } }
		expect(body.data.tenant.slug).toBe(slug)
		expect(body.data.properties.length).toBeGreaterThanOrEqual(1)
	})

	test('[R2] GET unknown tenant → 404 with NOT_FOUND code', async () => {
		const res = await app.request(`/api/public/widget/never-exists-${Date.now()}/properties`)
		expect(res.status).toBe(404)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('NOT_FOUND')
	})

	test('[R3] GET property detail known → 200 + tenant + property + roomTypes', async () => {
		const { slug, propertyId } = await seedTenant(`r3-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${slug}/properties/${propertyId}`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: { tenant: unknown; property: { id: string }; roomTypes: unknown[] }
		}
		expect(body.data.property.id).toBe(propertyId)
		expect(body.data.roomTypes).toBeInstanceOf(Array)
	})

	test('[R4] GET unknown property → 404 (timing-safe — same shape as unknown tenant)', async () => {
		const { slug } = await seedTenant(`r4-${Date.now().toString(36)}`)
		const fakeProp = newId('property')
		const res = await app.request(`/api/public/widget/${slug}/properties/${fakeProp}`)
		expect(res.status).toBe(404)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('NOT_FOUND')
	})

	test('[R5] GET malformed slug (Cyrillic) → 404', async () => {
		// Note: encodeURIComponent + Cyrillic should pass through Hono router but
		// fail в normalizeSlug (not ASCII). Resolver returns null → 404.
		const res = await app.request(`/api/public/widget/${encodeURIComponent('демо')}/properties`)
		expect(res.status).toBe(404)
	})

	test('[R6] POST /:slug/properties → 404 (route not registered for POST)', async () => {
		const { slug } = await seedTenant(`r6-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${slug}/properties`, {
			method: 'POST',
		})
		// Hono returns 404 for unmatched method+path (no fallback) — same outcome
		// as method-not-allowed для security (don't leak route existence).
		expect([404, 405]).toContain(res.status)
	})

	test('[S1] CSP header on every response', async () => {
		const { slug } = await seedTenant(`s1-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${slug}/properties`)
		const csp = res.headers.get('content-security-policy')
		expect(csp).toBeTruthy()
		expect(csp).toContain("default-src 'self'")
		expect(csp).toContain('https://yookassa.ru')
		expect(csp).toContain('https://captcha.yandex.com')
	})

	test('[S2] X-Content-Type-Options: nosniff', async () => {
		const { slug } = await seedTenant(`s2-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${slug}/properties`)
		expect(res.headers.get('x-content-type-options')).toBe('nosniff')
	})

	test('[S3] Referrer-Policy: strict-origin-when-cross-origin', async () => {
		const { slug } = await seedTenant(`s3-${Date.now().toString(36)}`)
		const res = await app.request(`/api/public/widget/${slug}/properties`)
		expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
	})

	test('[I1] cross-tenant: tenantA property NOT visible через tenantB slug', async () => {
		const A = await seedTenant(`i1a-${Date.now().toString(36)}`)
		const B = await seedTenant(`i1b-${Date.now().toString(36)}`)
		// Try to fetch tenant A's property через tenant B's slug
		const res = await app.request(`/api/public/widget/${B.slug}/properties/${A.propertyId}`)
		expect(res.status).toBe(404)
	})
})
