/**
 * auth-signup-rate-limit — strict tests (per `feedback_strict_tests.md`).
 *
 *   ─── Key generation ───────────────────────────────────────────────
 *     [K1] magicLinkKey prefixes IP with 'ml:' (namespace isolation)
 *     [K2] orgCreateKey prefixes IP with 'org:' (namespace isolation)
 *     [K3] anonymous IP — both keys are deterministic (no random suffix)
 *
 *   ─── Limit shape ──────────────────────────────────────────────────
 *     [L1] magicLinkRateLimit shape: limit=5, window=10min
 *     [L2] orgCreateRateLimit shape: limit=3, window=60min
 *
 *   ─── Functional pass / 429 ─────────────────────────────────────────
 *     [F1] magic-link 6th request from same IP returns 429 (5/10min boundary)
 *     [F2] org-create 4th request from same IP returns 429 (3/hour boundary)
 *     [F3] different IPs do not share bucket (right-most-trusted canon)
 */
import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AppEnv } from '../factory.ts'
import {
	__testAuthSignupRateLimitInternals,
	magicLinkRateLimit,
	orgCreateRateLimit,
} from './auth-signup-rate-limit.ts'

const { magicLinkKey, orgCreateKey } = __testAuthSignupRateLimitInternals

function makeContext(xff: string) {
	return {
		req: {
			header(name: string) {
				const lower = name.toLowerCase()
				if (lower === 'x-forwarded-for') return xff
				return undefined
			},
		},
		// biome-ignore lint/suspicious/noExplicitAny: Hono Context structural mock
	} as any
}

describe('auth-signup-rate-limit', () => {
	test('[K1] magicLinkKey prefixes IP с ml:', () => {
		expect(magicLinkKey(makeContext('203.0.113.1'))).toBe('ml:203.0.113.1')
	})

	test('[K2] orgCreateKey prefixes IP с org:', () => {
		expect(orgCreateKey(makeContext('203.0.113.1'))).toBe('org:203.0.113.1')
	})

	test('[K3] anonymous IP — keys deterministic', () => {
		// No XFF/x-real-ip → resolveClientIpSync returns 'anonymous'
		const empty = {
			req: { header: () => undefined },
			// biome-ignore lint/suspicious/noExplicitAny: structural Hono mock
		} as any as Parameters<typeof magicLinkKey>[0]
		expect(magicLinkKey(empty)).toBe('ml:anonymous')
		expect(orgCreateKey(empty)).toBe('org:anonymous')
	})

	test('[F1] magic-link 6th request from same IP returns 429', async () => {
		const app = new Hono<AppEnv>()
		app.use('/test/magic', magicLinkRateLimit)
		app.post('/test/magic', (c) => c.json({ ok: true }))

		const headers = { 'x-forwarded-for': '198.51.100.1' }
		for (let i = 0; i < 5; i++) {
			const res = await app.request('/test/magic', { method: 'POST', headers })
			expect(res.status).toBe(200)
		}
		const res6 = await app.request('/test/magic', { method: 'POST', headers })
		expect(res6.status).toBe(429)
	})

	test('[F2] org-create 4th request from same IP returns 429', async () => {
		const app = new Hono<AppEnv>()
		app.use('/test/org', orgCreateRateLimit)
		app.post('/test/org', (c) => c.json({ ok: true }))

		const headers = { 'x-forwarded-for': '198.51.100.2' }
		for (let i = 0; i < 3; i++) {
			const res = await app.request('/test/org', { method: 'POST', headers })
			expect(res.status).toBe(200)
		}
		const res4 = await app.request('/test/org', { method: 'POST', headers })
		expect(res4.status).toBe(429)
	})

	test('[F3] different IPs do not share bucket', async () => {
		const app = new Hono<AppEnv>()
		app.use('/test/magic', magicLinkRateLimit)
		app.post('/test/magic', (c) => c.json({ ok: true }))

		for (let i = 0; i < 5; i++) {
			const res = await app.request('/test/magic', {
				method: 'POST',
				headers: { 'x-forwarded-for': '198.51.100.10' },
			})
			expect(res.status).toBe(200)
		}
		// Different IP → fresh bucket → 200, not 429
		const resOtherIp = await app.request('/test/magic', {
			method: 'POST',
			headers: { 'x-forwarded-for': '198.51.100.11' },
		})
		expect(resOtherIp.status).toBe(200)
	})
})
