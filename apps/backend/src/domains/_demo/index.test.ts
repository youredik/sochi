/**
 * Round 14.6 — registerDemoRoutes anonymous-fallback contract tests.
 *
 * Empirically validates the permissive dual-mode auth gate в `_demo/index.ts`:
 *   - [RDR1] Permissive mode pinned к fallback tenant — admin/seed succeeds
 *     anonymously (proves auth-skip wired correctly).
 *   - [RDR2] Permissive mode + fallback tenant scope — admin/reset wipes ONLY
 *     fallback tenant, никакой другой tenant затронут не is (cross-tenant
 *     isolation proof).
 *   - [RDR3] Permissive mode + ostrovok mock endpoint — anonymous POST
 *     `/search/hp/` reaches the handler (proves the chain is permissive end-
 *     to-end, captcha middleware bypassed когда SMARTCAPTCHA_SERVER_KEY unset).
 *
 * Strict-mode contract (no fallback) requires Better Auth DB setup which is
 * out-of-scope для unit tests; covered в integration tests of the auth
 * middleware itself (`/Users/ed/dev/sochi/apps/backend/src/middleware/auth.ts`).
 *
 * Канон `feedback_critical_fix_test_coverage`: each new branch in code needs
 * empirical test before claimed закрытие.
 */
import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { registerDemoRoutes } from './index.ts'
import { createInMemoryOstrovokStore } from './mock-ota-server/ostrovok/store.ts'
import { createInMemoryYandexStore } from './mock-ota-server/yandex/store.ts'

// Round 14.6.4 — propertyId no longer wired here; routes derive per-tenant
// via resolveDemoPropertyId(tenantId).
const COMMON_OPTS = {
	webhookTargetBaseUrl: 'http://test.invalid',
	webhookSecret: 'whsec_test_only',
} as const

function buildApp(opts: { anonymousFallbackTenantId: string }) {
	const app = new Hono<AppEnv>()
	const ostrovokStore = createInMemoryOstrovokStore()
	const yandexStore = createInMemoryYandexStore()
	registerDemoRoutes(app, {
		...COMMON_OPTS,
		ostrovokStore,
		yandexStore,
		anonymousFallbackTenantId: opts.anonymousFallbackTenantId,
	})
	return { app, ostrovokStore, yandexStore }
}

describe('registerDemoRoutes — permissive anonymous fallback', () => {
	it('[RDR1] permissive mode (fallback="demo-tenant") → anonymous /admin/seed returns 200', async () => {
		const { app } = buildApp({ anonymousFallbackTenantId: 'demo-tenant' })
		const res = await app.request('/api/_mock-ota/admin/seed', { method: 'POST' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { ok: boolean }
		expect(body.ok).toBe(true)
	})

	it('[RDR2] permissive mode → /admin/reset scopes к fallback tenant ONLY (cross-tenant isolation)', async () => {
		const fallback = 'demo-tenant'
		const otherTenant = 'org_real_hotel'
		const { app, yandexStore } = buildApp({ anonymousFallbackTenantId: fallback })

		// Seed both tenants directly via store.
		await yandexStore.storeBookingToken(otherTenant, {
			token: 'OTHER_TENANT_TOK',
			hotelId: 'h_other',
			checkinDate: '2027-06-15',
			checkoutDate: '2027-06-17',
			adults: 2,
			children: 0,
			totalPriceMicros: 9_000_000_000n,
		})
		await yandexStore.storeBookingToken(fallback, {
			token: 'FALLBACK_TOK',
			hotelId: 'h_demo',
			checkinDate: '2027-06-15',
			checkoutDate: '2027-06-17',
			adults: 2,
			children: 0,
			totalPriceMicros: 6_000_000_000n,
		})

		// Anonymous reset → pinned к fallback tenant only.
		const res = await app.request('/api/_mock-ota/admin/reset', { method: 'POST' })
		expect(res.status).toBe(200)
		expect((await yandexStore.__listBookingTokens(fallback)).length).toBe(0)
		expect((await yandexStore.__listBookingTokens(otherTenant)).length).toBe(1)
	})

	it('[RDR4] body-cap → POST exceeding 64 KB returns 413 (Yandex)', async () => {
		const { app } = buildApp({ anonymousFallbackTenantId: 'demo-tenant' })
		// 100 KB body — well над 64 KB cap. Hono bodyLimit reads content-length
		// header first; falls back to streaming length. Tests both paths via
		// explicit content-length-derived body.
		const bigPayload = 'a'.repeat(100 * 1024)
		const res = await app.request('/api/_mock-ota/yandex/v1/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: bigPayload,
		})
		expect(res.status).toBe(413)
	})

	it('[RDR5] body-cap → POST exceeding 64 KB returns 413 (Ostrovok)', async () => {
		const { app } = buildApp({ anonymousFallbackTenantId: 'demo-tenant' })
		const bigPayload = 'a'.repeat(100 * 1024)
		const res = await app.request('/api/_mock-ota/ostrovok/v1/search/hp/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: bigPayload,
		})
		expect(res.status).toBe(413)
	})

	it('[RDR3] permissive mode → anonymous Ostrovok /search/hp/ reaches handler (no auth wall)', async () => {
		// Path matches Round 12 pass-2 P0 fix — mount /api/_mock-ota/ostrovok/v1
		// + internal POST /search/hp/ = full URL /api/_mock-ota/ostrovok/v1/search/hp/.
		const { app } = buildApp({ anonymousFallbackTenantId: 'demo-tenant' })
		const res = await app.request('/api/_mock-ota/ostrovok/v1/search/hp/', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Basic ${Buffer.from('demo:key', 'utf-8').toString('base64')}`,
			},
			body: JSON.stringify({
				checkin: '2027-06-15',
				checkout: '2027-06-17',
				hid: 8473727,
				currency: 'RUB',
				language: 'ru',
				residency: 'ru',
				guests: [{ adults: 2, children: [] }],
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			status: 'ok' | 'error'
			data: { hotels: ReadonlyArray<{ hid: number }> }
		}
		expect(body.status).toBe('ok')
		expect(body.data.hotels.length).toBe(1)
		expect(body.data.hotels[0]?.hid).toBe(8473727)
	})
})
