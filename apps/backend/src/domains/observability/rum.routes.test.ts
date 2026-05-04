/**
 * RUM ingest routes — integration tests RUM1-RUM4 (M9.widget.7 / A5.2).
 *
 * Per plan §5: «4 RUM integration (rate-limit / shape validate / 152-ФЗ
 * post-anonymize verify / cross-tenant)».
 *
 * Strict-test canon:
 *   - Exact-value asserts (toBe, not toContain).
 *   - Adversarial: missing fields, oversize batch, malformed enum.
 *   - Cross-tenant: 2 distinct slugs ingest into 1 buffer with distinct labels.
 *   - 152-ФЗ: real X-Forwarded-For propagated → truncated form persisted.
 *
 * No DB required — buffer is in-memory; routes use pure Hono.
 */

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../../factory.ts'
import { RumBuffer } from './rum.repo.ts'
import { createRumRoutes } from './rum.routes.ts'

function buildApp() {
	const buffer = new RumBuffer({ capacity: 100 })
	const root = new Hono<AppEnv>()
	root.route('/api/rum', createRumRoutes({ buffer, disableRateLimit: true }))
	return { buffer, app: root }
}

const baseMetric = {
	metric: 'INP' as const,
	value: 180,
	rating: 'good' as const,
	id: 'v5-inp-1',
	path: '/widget/demo-sirius',
	ua: { browser: 'chrome' as const, os: 'macos' as const, mobile: false },
	tenantSlug: 'demo-sirius',
	ts: Date.now(),
}

describe('POST /api/rum/v1/web-vitals', () => {
	it('[RUM1] valid batch → 200 + buffer.size grows by N', async () => {
		const { buffer, app } = buildApp()
		const body = {
			metrics: [
				{ ...baseMetric, id: 'v5-inp-A' },
				{ ...baseMetric, id: 'v5-inp-B', metric: 'LCP', value: 1234.5 },
				{ ...baseMetric, id: 'v5-cls-C', metric: 'CLS', value: 0.05 },
			],
		}
		const res = await app.request('/api/rum/v1/web-vitals', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
		expect(res.status).toBe(200)
		const json = (await res.json()) as { ok: boolean }
		expect(json.ok).toBe(true)
		expect(buffer.size).toBe(3)
	})

	it('[RUM2] invalid body shape → 400 (zValidator rejects)', async () => {
		const { buffer, app } = buildApp()
		// Multi-shape sweep: missing field / wrong enum / >16 batch
		const cases: ReadonlyArray<{ name: string; body: unknown }> = [
			{ name: 'missing metrics array', body: {} },
			{ name: 'wrong metric enum', body: { metrics: [{ ...baseMetric, metric: 'XYZ' }] } },
			{ name: 'wrong rating enum', body: { metrics: [{ ...baseMetric, rating: 'meh' }] } },
			{ name: 'negative value', body: { metrics: [{ ...baseMetric, value: -1 }] } },
			{
				name: 'over batch limit',
				body: {
					metrics: Array.from({ length: 17 }, (_, i) => ({ ...baseMetric, id: `v5-${i}` })),
				},
			},
			{ name: 'extra field violates strict()', body: { metrics: [{ ...baseMetric, evil: 'x' }] } },
		]
		for (const tc of cases) {
			const res = await app.request('/api/rum/v1/web-vitals', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(tc.body),
			})
			expect(res.status, `${tc.name} → expected 400, got ${res.status}`).toBe(400)
		}
		expect(buffer.size).toBe(0) // ничего не просочилось
	})

	it('[RUM3] 152-ФЗ post-anonymize: X-Forwarded-For truncated before storage', async () => {
		const { buffer, app } = buildApp()
		const body = { metrics: [{ ...baseMetric, id: 'v5-inp-anon' }] }
		const res = await app.request('/api/rum/v1/web-vitals', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-forwarded-for': '203.0.113.42, 10.0.0.1', // proxy chain
			},
			body: JSON.stringify(body),
		})
		expect(res.status).toBe(200)
		const stored = buffer.peek()
		expect(stored).toBeDefined()
		// Leftmost IP (203.0.113.42) → last octet zeroed (203.0.113.0).
		expect(stored?.truncatedIp).toBe('203.0.113.0')
		expect(stored?.id).toBe('v5-inp-anon')
	})

	it('[RUM3.b] missing X-Forwarded-For → "anonymous" → "unknown" sentinel', async () => {
		const { buffer, app } = buildApp()
		const body = { metrics: [{ ...baseMetric, id: 'v5-inp-noip' }] }
		const res = await app.request('/api/rum/v1/web-vitals', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
		expect(res.status).toBe(200)
		// extractClientIp returns 'anonymous' which truncateIp recognizes as
		// non-IP → 'unknown'. NEVER leak literal 'anonymous' string into RUM.
		expect(buffer.peek()?.truncatedIp).toBe('unknown')
	})

	it('[RUM4] cross-tenant: 2 slugs → 2 distinct buffer entries with distinct labels', async () => {
		const { buffer, app } = buildApp()
		const body = {
			metrics: [
				{ ...baseMetric, id: 'v5-inp-A', tenantSlug: 'demo-sirius', value: 100 },
				{ ...baseMetric, id: 'v5-inp-B', tenantSlug: 'sochi-rosa', value: 200 },
			],
		}
		const res = await app.request('/api/rum/v1/web-vitals', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-forwarded-for': '203.0.113.42',
			},
			body: JSON.stringify(body),
		})
		expect(res.status).toBe(200)
		expect(buffer.size).toBe(2)
		const head = buffer.peek()
		expect(head?.tenantSlug).toBe('demo-sirius')
		expect(head?.value).toBe(100)
		// Drain 2 → tail entry has tenantSlug='sochi-rosa'.
		const drained = buffer.drain(2)
		expect(drained).toHaveLength(2)
		expect(drained[0]?.tenantSlug).toBe('demo-sirius')
		expect(drained[1]?.tenantSlug).toBe('sochi-rosa')
		// Both entries share same truncatedIp (one POST, one IP).
		expect(drained[0]?.truncatedIp).toBe('203.0.113.0')
		expect(drained[1]?.truncatedIp).toBe('203.0.113.0')
	})

	it('[RUM4.b] invalid tenantSlug regex → 400 (defense-in-depth)', async () => {
		const { app } = buildApp()
		// Slug with uppercase / underscore / leading dash should be rejected
		// by zod regex `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`.
		const cases: ReadonlyArray<string> = ['DEMO', 'demo_sirius', '-demo', 'a', 'a'.repeat(40)]
		for (const slug of cases) {
			const res = await app.request('/api/rum/v1/web-vitals', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ metrics: [{ ...baseMetric, tenantSlug: slug }] }),
			})
			expect(res.status, `slug="${slug}"`).toBe(400)
		}
	})
})
