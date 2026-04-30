/**
 * Strict tests для widget-rate-limit middleware (M9.widget.4 / D6).
 *
 * Coverage matrix (paste-and-fill canon):
 *   ─── extractClientIp ─────────────────────────────────────────
 *     [WRL1] X-Forwarded-For leftmost wins over X-Real-IP
 *     [WRL2] X-Forwarded-For trims whitespace + handles single value
 *     [WRL3] X-Real-IP fallback when no X-Forwarded-For
 *     [WRL4] 'anonymous' literal when no headers (NEVER fall back на host)
 *     [WRL5] Empty X-Forwarded-For string falls through to X-Real-IP
 *
 *   ─── widgetRateLimitKey ──────────────────────────────────────
 *     [WRL6] Key = ip::slug — stable format
 *     [WRL7] Different IP same slug → different keys
 *     [WRL8] Same IP different slug → different keys
 *     [WRL9] Missing slug param → 'unknown' literal slug
 *
 *   ─── 429 path (real limiter) ─────────────────────────────────
 *     [WRL10] Single client at burst+1 → 429 + retry-after header set
 *     [WRL11] Different IPs share NO bucket (independent counters)
 *     [WRL12] Same IP different slugs share NO bucket
 *     [WRL13] 429 body shape — RU message + RATE_LIMITED code
 *     [WRL14] noopRateLimiter never returns 429 (test pass-through)
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { beforeEach, describe, expect, test } from 'vitest'
import type { AppEnv } from '../factory.ts'
import {
	__testWidgetRateLimitInternals,
	makeTestRateLimiter,
	noopRateLimiter,
} from './widget-rate-limit.ts'

const { extractClientIp, widgetRateLimitKey } = __testWidgetRateLimitInternals

describe('widget-rate-limit — extractClientIp', () => {
	test('[WRL1] X-Forwarded-For leftmost wins over X-Real-IP', () => {
		const ctx = makeMockCtx({
			headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1', 'x-real-ip': '198.51.100.5' },
		})
		expect(extractClientIp(ctx)).toBe('203.0.113.1')
	})

	test('[WRL2] X-Forwarded-For trims whitespace + handles single value', () => {
		const ctx = makeMockCtx({ headers: { 'x-forwarded-for': '  203.0.113.7  ' } })
		expect(extractClientIp(ctx)).toBe('203.0.113.7')
	})

	test('[WRL3] X-Real-IP fallback когда no X-Forwarded-For', () => {
		const ctx = makeMockCtx({ headers: { 'x-real-ip': '198.51.100.42' } })
		expect(extractClientIp(ctx)).toBe('198.51.100.42')
	})

	test('[WRL4] anonymous literal когда нет headers (NEVER host fallback)', () => {
		const ctx = makeMockCtx({ headers: {} })
		expect(extractClientIp(ctx)).toBe('anonymous')
	})

	test('[WRL5] Empty X-Forwarded-For falls through к X-Real-IP', () => {
		const ctx = makeMockCtx({ headers: { 'x-forwarded-for': '', 'x-real-ip': '203.0.113.99' } })
		// Empty string passes truthy check on header existence; first split = '',
		// trimmed empty falls through к real-ip.
		expect(extractClientIp(ctx)).toBe('203.0.113.99')
	})
})

describe('widget-rate-limit — widgetRateLimitKey', () => {
	test('[WRL6] Key = ip::slug stable format', () => {
		const ctx = makeMockCtx({
			headers: { 'x-forwarded-for': '203.0.113.1' },
			params: { tenantSlug: 'acme-hotel' },
		})
		expect(widgetRateLimitKey(ctx)).toBe('203.0.113.1::acme-hotel')
	})

	test('[WRL7] Different IP same slug → different keys', () => {
		const a = makeMockCtx({
			headers: { 'x-forwarded-for': '203.0.113.1' },
			params: { tenantSlug: 'acme' },
		})
		const b = makeMockCtx({
			headers: { 'x-forwarded-for': '203.0.113.2' },
			params: { tenantSlug: 'acme' },
		})
		expect(widgetRateLimitKey(a)).not.toBe(widgetRateLimitKey(b))
	})

	test('[WRL8] Same IP different slug → different keys', () => {
		const a = makeMockCtx({
			headers: { 'x-forwarded-for': '203.0.113.1' },
			params: { tenantSlug: 'acme' },
		})
		const b = makeMockCtx({
			headers: { 'x-forwarded-for': '203.0.113.1' },
			params: { tenantSlug: 'beta' },
		})
		expect(widgetRateLimitKey(a)).not.toBe(widgetRateLimitKey(b))
	})

	test('[WRL9] Missing slug param → unknown literal slug', () => {
		const ctx = makeMockCtx({ headers: { 'x-forwarded-for': '203.0.113.1' }, params: {} })
		expect(widgetRateLimitKey(ctx)).toBe('203.0.113.1::unknown')
	})
})

describe('widget-rate-limit — 429 path', () => {
	let app: Hono<AppEnv>

	beforeEach(() => {
		app = new Hono<AppEnv>()
	})

	test('[WRL10] Single client at burst+1 → 429 + RateLimit-* headers set', async () => {
		// Cap = 2 within 60s window. Third request from same client trips 429.
		const limiter = makeTestRateLimiter({ limit: 2, windowMs: 60_000 })
		app.use('/x/:tenantSlug', limiter).get('/x/:tenantSlug', (c) => c.text('ok'))

		const headers = { 'x-forwarded-for': '203.0.113.10' }
		const r1 = await app.request('/x/acme', { headers })
		const r2 = await app.request('/x/acme', { headers })
		const r3 = await app.request('/x/acme', { headers })

		expect(r1.status).toBe(200)
		expect(r2.status).toBe(200)
		expect(r3.status).toBe(429)
		// draft-7 standard combined header: `RateLimit: limit=2, remaining=0, reset=N`
		const rl = r3.headers.get('RateLimit')
		expect(rl).toBeTruthy()
		expect(rl).toMatch(/limit=2/)
		expect(rl).toMatch(/remaining=0/)
		expect(rl).toMatch(/reset=\d+/)
	})

	test('[WRL11] Different IPs share NO bucket — independent counters', async () => {
		const limiter = makeTestRateLimiter({ limit: 1, windowMs: 60_000 })
		app.use('/x/:tenantSlug', limiter).get('/x/:tenantSlug', (c) => c.text('ok'))

		const a = await app.request('/x/acme', {
			headers: { 'x-forwarded-for': '203.0.113.1' },
		})
		const b = await app.request('/x/acme', {
			headers: { 'x-forwarded-for': '203.0.113.2' },
		})
		// Both clients get 200 — separate buckets despite limit=1
		expect(a.status).toBe(200)
		expect(b.status).toBe(200)
	})

	test('[WRL12] Same IP different slugs share NO bucket', async () => {
		const limiter = makeTestRateLimiter({ limit: 1, windowMs: 60_000 })
		app.use('/x/:tenantSlug', limiter).get('/x/:tenantSlug', (c) => c.text('ok'))

		const a = await app.request('/x/acme', {
			headers: { 'x-forwarded-for': '203.0.113.1' },
		})
		const b = await app.request('/x/beta', {
			headers: { 'x-forwarded-for': '203.0.113.1' },
		})
		expect(a.status).toBe(200)
		expect(b.status).toBe(200)
	})

	test('[WRL13] 429 body shape — RU message + RATE_LIMITED code', async () => {
		const limiter = makeTestRateLimiter({ limit: 1, windowMs: 60_000 })
		app.use('/x/:tenantSlug', limiter).get('/x/:tenantSlug', (c) => c.text('ok'))

		const headers = { 'x-forwarded-for': '203.0.113.20' }
		await app.request('/x/acme', { headers })
		const blocked = await app.request('/x/acme', { headers })

		expect(blocked.status).toBe(429)
		const body = (await blocked.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe('RATE_LIMITED')
		expect(body.error.message).toMatch(/Слишком много запросов/)
	})

	test('[WRL14] noopRateLimiter never returns 429 (pass-through)', async () => {
		app.use('/x/:tenantSlug', noopRateLimiter).get('/x/:tenantSlug', (c) => c.text('ok'))

		// 100 requests must all pass — confirms noop has no counter
		const results = await Promise.all(
			Array.from({ length: 100 }, () =>
				app.request('/x/acme', { headers: { 'x-forwarded-for': '203.0.113.1' } }),
			),
		)
		expect(results.every((r) => r.status === 200)).toBe(true)
	})
})

/**
 * Minimal Hono Context mock — only fields used by `extractClientIp` and
 * `widgetRateLimitKey` (req.header + req.param). The cast through `unknown`
 * is the canonical TS escape для structural-mock compatibility — Hono Context
 * has 22+ fields we don't need для these pure helpers.
 */
type MockHeaders = Record<string, string>
type MockParams = Record<string, string>

function makeMockCtx({
	headers = {},
	params = {},
}: {
	headers?: MockHeaders
	params?: MockParams
}): Context<AppEnv> {
	const lower: MockHeaders = {}
	for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
	const minimal = {
		req: {
			header: (name: string) => lower[name.toLowerCase()],
			param: (name: string) => params[name],
		},
	}
	return minimal as unknown as Context<AppEnv>
}
