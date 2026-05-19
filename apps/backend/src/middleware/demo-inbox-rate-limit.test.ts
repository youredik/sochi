/**
 * Strict tests for demo-inbox-rate-limit middleware (2026-05-19).
 *
 * Coverage:
 *   [DRL1] Key = IP only (no slug — anonymous demo route)
 *   [DRL2] Different IPs share NO bucket
 *   [DRL3] At limit+1 → 429 + standard RateLimit headers
 *   [DRL4] 429 body shape — RU message + RATE_LIMITED code
 *   [DRL5] noopDemoInboxRateLimiter never returns 429
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { rateLimiter } from 'hono-rate-limiter'
import { describe, expect, test } from 'bun:test'
import type { AppEnv } from '../factory.ts'
import {
	__testDemoInboxRateLimitInternals,
	noopDemoInboxRateLimiter,
} from './demo-inbox-rate-limit.ts'

const { demoInboxRateLimitKey } = __testDemoInboxRateLimitInternals

describe('demo-inbox-rate-limit — key generation', () => {
	test('[DRL1] Key = client IP (no slug — anonymous endpoint)', () => {
		const ctx = makeMockCtx({ headers: { 'x-forwarded-for': '203.0.113.1' } })
		expect(demoInboxRateLimitKey(ctx)).toBe('203.0.113.1')
	})

	test('[DRL1.b] anonymous literal when no IP headers', () => {
		const ctx = makeMockCtx({ headers: {} })
		expect(demoInboxRateLimitKey(ctx)).toBe('anonymous')
	})
})

describe('demo-inbox-rate-limit — 429 path', () => {
	test('[DRL2] Different IPs share NO bucket', async () => {
		const limiter = rateLimiter<AppEnv>({
			windowMs: 60_000,
			limit: 1,
			keyGenerator: (c) => demoInboxRateLimitKey(c),
			standardHeaders: 'draft-7',
		})
		const app = new Hono<AppEnv>()
		app.use('/inbox', limiter).get('/inbox', (c) => c.text('ok'))
		const a = await app.request('/inbox', { headers: { 'x-forwarded-for': '203.0.113.1' } })
		const b = await app.request('/inbox', { headers: { 'x-forwarded-for': '203.0.113.2' } })
		expect(a.status).toBe(200)
		expect(b.status).toBe(200)
	})

	test('[DRL3] At limit+1 → 429 + RateLimit-* headers', async () => {
		const limiter = rateLimiter<AppEnv>({
			windowMs: 60_000,
			limit: 2,
			keyGenerator: (c) => demoInboxRateLimitKey(c),
			standardHeaders: 'draft-7',
			statusCode: 429,
		})
		const app = new Hono<AppEnv>()
		app.use('/inbox', limiter).get('/inbox', (c) => c.text('ok'))
		const headers = { 'x-forwarded-for': '203.0.113.10' }
		const r1 = await app.request('/inbox', { headers })
		const r2 = await app.request('/inbox', { headers })
		const r3 = await app.request('/inbox', { headers })
		expect(r1.status).toBe(200)
		expect(r2.status).toBe(200)
		expect(r3.status).toBe(429)
		const rl = r3.headers.get('RateLimit')
		expect(rl).not.toBe(null)
		expect(rl).toMatch(/limit=2/)
		expect(rl).toMatch(/remaining=0/)
	})

	test('[DRL4] 429 body shape — RU message + RATE_LIMITED code', async () => {
		const limiter = rateLimiter<AppEnv>({
			windowMs: 60_000,
			limit: 1,
			keyGenerator: (c) => demoInboxRateLimitKey(c),
			standardHeaders: 'draft-7',
			statusCode: 429,
			message: {
				error: { code: 'RATE_LIMITED', message: 'Слишком много запросов к demo-инбоксу.' },
			},
		})
		const app = new Hono<AppEnv>()
		app.use('/inbox', limiter).get('/inbox', (c) => c.text('ok'))
		const headers = { 'x-forwarded-for': '203.0.113.20' }
		await app.request('/inbox', { headers })
		const blocked = await app.request('/inbox', { headers })
		expect(blocked.status).toBe(429)
		const body = (await blocked.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe('RATE_LIMITED')
		expect(body.error.message).toMatch(/Слишком много запросов/)
	})

	test('[DRL5] noopDemoInboxRateLimiter never returns 429 (pass-through для тестов)', async () => {
		const app = new Hono<AppEnv>()
		app.use('/inbox', noopDemoInboxRateLimiter).get('/inbox', (c) => c.text('ok'))
		const results = await Promise.all(
			Array.from({ length: 50 }, () =>
				app.request('/inbox', { headers: { 'x-forwarded-for': '203.0.113.1' } }),
			),
		)
		expect(results.every((r) => r.status === 200)).toBe(true)
	})
})

type MockHeaders = Record<string, string>

function makeMockCtx({ headers = {} }: { headers?: MockHeaders }): Context<AppEnv> {
	const lower: MockHeaders = {}
	for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
	const minimal = {
		req: {
			header: (name: string) => lower[name.toLowerCase()],
			param: (_name: string) => undefined,
		},
	}
	return minimal as unknown as Context<AppEnv>
}
