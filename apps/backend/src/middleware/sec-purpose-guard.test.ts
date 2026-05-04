/**
 * Sec-Purpose: prefetch guard — strict tests SP1-SP5 (M9.widget.7 / A5.4 / D12).
 *
 * Per `plans/m9_widget_7_canonical.md` §2 D12 + R2 §7:
 *   «Backend `/book/...` returns 503 для `Sec-Purpose: prefetch` when not
 *    from hosted facade origin. Cross-tenant prefetch DDoS / scraping
 *    defense».
 *
 * Strict-test canon:
 *   - Exact 503 status + Cache-Control: no-store on rejection.
 *   - Pass-through on regular nav (no header).
 *   - Pass-through on same-origin prefetch (Origin matches request).
 *   - 503 on foreign-origin prefetch.
 *   - 503 on prefetch с absent Origin/Referer (conservative deny).
 *   - allowlist explicit override.
 */

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../factory.ts'
import { secPurposeGuard } from './sec-purpose-guard.ts'

function buildApp(opts?: Parameters<typeof secPurposeGuard>[0]) {
	const app = new Hono<AppEnv>()
	app.use('/protected/*', secPurposeGuard(opts))
	app.get('/protected/page', (c) => c.text('OK'))
	return app
}

describe('Sec-Purpose: prefetch guard (D12)', () => {
	it('[SP1] no Sec-Purpose header → pass through (regular nav, 200)', async () => {
		const app = buildApp()
		const res = await app.request('http://example.com/protected/page')
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('OK')
	})

	it('[SP2] same-origin prefetch (Origin matches request URL host) → pass through', async () => {
		const app = buildApp()
		const res = await app.request('http://example.com/protected/page', {
			headers: {
				'sec-purpose': 'prefetch',
				origin: 'http://example.com',
			},
		})
		expect(res.status).toBe(200)
	})

	it('[SP3] foreign-origin prefetch → 503 + Cache-Control: no-store', async () => {
		const app = buildApp()
		const res = await app.request('http://example.com/protected/page', {
			headers: {
				'sec-purpose': 'prefetch',
				origin: 'https://attacker.example',
			},
		})
		expect(res.status).toBe(503)
		expect(res.headers.get('cache-control')).toBe('no-store')
	})

	it('[SP3.b] foreign-origin prerender (Sec-Purpose: prerender;prefetch) → 503', async () => {
		// Sec-Purpose tokens may stack — `prefetch` substring catches all
		// prefetch-class purposes (also `prefetch;anonymous-client-ip`).
		const app = buildApp()
		const res = await app.request('http://example.com/protected/page', {
			headers: {
				'sec-purpose': 'prefetch;anonymous-client-ip',
				origin: 'https://attacker.example',
			},
		})
		expect(res.status).toBe(503)
	})

	it('[SP3.c] case-insensitive header value match', async () => {
		const app = buildApp()
		const res = await app.request('http://example.com/protected/page', {
			headers: {
				'sec-purpose': 'PREFETCH',
				origin: 'https://attacker.example',
			},
		})
		expect(res.status).toBe(503)
	})

	it('[SP4] prefetch с absent Origin AND Referer → 503 (conservative deny)', async () => {
		const app = buildApp()
		const res = await app.request('http://example.com/protected/page', {
			headers: { 'sec-purpose': 'prefetch' },
		})
		expect(res.status).toBe(503)
	})

	it('[SP4.b] prefetch with valid Referer same-origin → pass through (Origin fallback)', async () => {
		const app = buildApp()
		const res = await app.request('http://example.com/protected/page', {
			headers: {
				'sec-purpose': 'prefetch',
				referer: 'http://example.com/some-page',
			},
		})
		expect(res.status).toBe(200)
	})

	it('[SP4.c] prefetch с malformed Referer → treated as foreign → 503', async () => {
		const app = buildApp()
		const res = await app.request('http://example.com/protected/page', {
			headers: {
				'sec-purpose': 'prefetch',
				referer: 'not-a-valid-url',
			},
		})
		expect(res.status).toBe(503)
	})

	it('[SP5] explicit allowlist origin → pass through', async () => {
		const app = buildApp({ allowedPrefetchOrigins: ['https://hosted.facade.example'] })
		const res = await app.request('http://example.com/protected/page', {
			headers: {
				'sec-purpose': 'prefetch',
				origin: 'https://hosted.facade.example',
			},
		})
		expect(res.status).toBe(200)
	})

	it('[SP5.b] non-prefetch Sec-Purpose token (e.g. "subresource") → pass through', async () => {
		// Per spec, future tokens may exist (e.g. resource hints). We only
		// guard against `prefetch` substring; everything else passes.
		const app = buildApp()
		const res = await app.request('http://example.com/protected/page', {
			headers: {
				'sec-purpose': 'subresource',
				origin: 'https://attacker.example',
			},
		})
		expect(res.status).toBe(200)
	})
})
