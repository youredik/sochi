/**
 * Demo-inbox route — HTTP-level strict tests.
 *
 * Pre-done audit:
 *   [E1] enabled=false → 404 NOT_FOUND с canonical error shape
 *   [E2] enabled=true + no active inbox singleton → 200 + null fields
 *        (deployment came up but no email yet dispatched)
 *   [E3] enabled=true + active inbox с capture → 200 + filled fields
 *   [Q1] missing email param → 400
 *   [Q2] malformed email format → 400
 *   [Q3] email URL-encoded (Cyrillic local-part) → 400 (RFC 5321 disallows
 *        non-ASCII without explicit IDN/SMTPUTF8 — z.email() reject is
 *        sufficient для demo seam)
 *   [N1] case-insensitive lookup: `User@X.com` query → matches lowercase capture
 *   [N2] unknown email → 200 + null fields (не leak existence)
 *   [I1] capture с null magic-link URL surfaces correctly (subject-only email)
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
	__resetDemoInboxForTesting,
	getDemoInboxIfActive,
} from '../../workers/lib/postbox-adapter.ts'
import { DemoInboxAdapter } from '../../workers/lib/demo-inbox-adapter.ts'
import { createDemoInboxRoutes } from './inbox.routes.ts'

const VERIFY_URL =
	'http://localhost:8787/api/auth/magic-link/verify?token=abc&callbackURL=%2Fwelcome%3Fn%3DTest'

function makeApp(enabled: boolean): Hono {
	return new Hono().route('/api/public/demo', createDemoInboxRoutes({ enabled }))
}

afterEach(() => {
	__resetDemoInboxForTesting()
})

describe('demo-inbox route — gating', () => {
	test('[E1] enabled=false → 404 NOT_FOUND', async () => {
		const app = makeApp(false)
		const res = await app.request('/api/public/demo/inbox?email=user%40x.com')
		expect(res.status).toBe(404)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('NOT_FOUND')
	})

	test('[E2] enabled=true + no singleton → 200 with null fields', async () => {
		const app = makeApp(true)
		const res = await app.request('/api/public/demo/inbox?email=user%40x.com')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: { email: string; latestUrl: string | null; capturedAt: string | null }
		}
		expect(body.data.email).toBe('user@x.com')
		expect(body.data.latestUrl).toBe(null)
		expect(body.data.capturedAt).toBe(null)
	})
})

describe('demo-inbox route — capture surface', () => {
	test('[E3] enabled=true + active inbox с capture → 200 + filled fields', async () => {
		// Prime singleton via the factory (mirrors the production path).
		// Direct setter not exported deliberately; use email-adapter factory.
		const { createEmailAdapter } = await import('../../workers/lib/postbox-adapter.ts')
		const adapter = createEmailAdapter(
			{
				POSTBOX_ENABLED: false,
				POSTBOX_ENDPOINT: 'https://example.com',
				SMTP_HOST: '',
				SMTP_PORT: 0,
				DEMO_DEPLOYMENT: true,
			},
			{ info: () => {}, warn: () => {} },
		)
		await adapter.send({
			from: '"HoReCa" <noreply@horeca.local>',
			to: 'user@x.com',
			subject: 'Вход в HoReCa',
			html: `<a href="${VERIFY_URL}">Войти</a>`,
			text: `Войдите: ${VERIFY_URL}`,
		})
		const inbox = getDemoInboxIfActive()
		expect(inbox).not.toBe(null)

		const app = makeApp(true)
		const res = await app.request('/api/public/demo/inbox?email=user%40x.com')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: {
				email: string
				latestUrl: string | null
				capturedAt: string | null
				subject: string | null
			}
		}
		expect(body.data.email).toBe('user@x.com')
		expect(body.data.latestUrl).toBe(VERIFY_URL)
		expect(body.data.subject).toBe('Вход в HoReCa')
		expect(typeof body.data.capturedAt).toBe('string')
	})

	test('[N1] case-insensitive lookup: User@X.com query matches lowercase capture', async () => {
		const inbox = new DemoInboxAdapter()
		await inbox.send({
			from: '"HoReCa" <noreply@horeca.local>',
			to: 'user@x.com',
			subject: 'Hi',
			html: `<a href="${VERIFY_URL}">Войти</a>`,
			text: VERIFY_URL,
		})
		// Direct singleton inject via factory side-effect:
		await (
			await import('../../workers/lib/postbox-adapter.ts')
		)
			.createEmailAdapter(
				{
					POSTBOX_ENABLED: false,
					POSTBOX_ENDPOINT: 'https://example.com',
					SMTP_HOST: '',
					SMTP_PORT: 0,
					DEMO_DEPLOYMENT: true,
				},
				{ info: () => {}, warn: () => {} },
			)
			.send({
				from: '"HoReCa" <noreply@horeca.local>',
				to: 'user@x.com',
				subject: 'Hi',
				html: `<a href="${VERIFY_URL}">Войти</a>`,
				text: VERIFY_URL,
			})
		const app = makeApp(true)
		const res = await app.request('/api/public/demo/inbox?email=User%40X.com')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: { latestUrl: string | null } }
		expect(body.data.latestUrl).toBe(VERIFY_URL)
	})

	test('[N2] unknown email → 200 + null fields (no existence leak)', async () => {
		const app = makeApp(true)
		const res = await app.request('/api/public/demo/inbox?email=ghost%40x.com')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: { latestUrl: string | null; capturedAt: string | null }
		}
		expect(body.data.latestUrl).toBe(null)
		expect(body.data.capturedAt).toBe(null)
	})

	test('[I1] capture без magic-link URL surfaces latestUrl=null but subject filled', async () => {
		await (
			await import('../../workers/lib/postbox-adapter.ts')
		)
			.createEmailAdapter(
				{
					POSTBOX_ENABLED: false,
					POSTBOX_ENDPOINT: 'https://example.com',
					SMTP_HOST: '',
					SMTP_PORT: 0,
					DEMO_DEPLOYMENT: true,
				},
				{ info: () => {}, warn: () => {} },
			)
			.send({
				from: '"HoReCa" <noreply@horeca.local>',
				to: 'noting@x.com',
				subject: 'Welcome',
				html: '<p>Hi!</p>',
				text: 'Hi!',
			})
		const app = makeApp(true)
		const res = await app.request('/api/public/demo/inbox?email=noting%40x.com')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			data: { latestUrl: string | null; subject: string | null }
		}
		expect(body.data.latestUrl).toBe(null)
		expect(body.data.subject).toBe('Welcome')
	})
})

describe('demo-inbox route — input validation', () => {
	test('[Q1] missing email param → 400', async () => {
		const app = makeApp(true)
		const res = await app.request('/api/public/demo/inbox')
		expect(res.status).toBe(400)
	})

	test('[Q2] malformed email → 400', async () => {
		const app = makeApp(true)
		const res = await app.request('/api/public/demo/inbox?email=not-an-email')
		expect(res.status).toBe(400)
	})

	test('[Q3] malformed `since` (not ISO datetime) → 400', async () => {
		const app = makeApp(true)
		const res = await app.request('/api/public/demo/inbox?email=user%40x.com&since=not-iso')
		expect(res.status).toBe(400)
	})
})

describe('demo-inbox route — since filter (Round 7 v3 race-free polling)', () => {
	test('[S1] since=capturedAt1 returns SECOND capture (race-free repeat send)', async () => {
		const { createEmailAdapter } = await import('../../workers/lib/postbox-adapter.ts')
		const env = {
			POSTBOX_ENABLED: false,
			POSTBOX_ENDPOINT: 'https://example.com',
			SMTP_HOST: '',
			SMTP_PORT: 0,
			DEMO_DEPLOYMENT: true,
		}
		const adapter = createEmailAdapter(env, { info: () => {}, warn: () => {} })
		await adapter.send({
			from: '"HoReCa" <noreply@horeca.local>',
			to: 'race@x.com',
			subject: 'First',
			html: `<a href="${VERIFY_URL}">Войти</a>`,
			text: VERIFY_URL,
		})
		const app = makeApp(true)

		// First poll — get latest, capture timestamp
		const r1 = await app.request('/api/public/demo/inbox?email=race%40x.com')
		const b1 = (await r1.json()) as { data: { capturedAt: string | null } }
		const since1 = b1.data.capturedAt!
		expect(typeof since1).toBe('string')

		// Wait 50ms, send second email (same URL — simulates BA token reuse)
		await new Promise((r) => setTimeout(r, 50))
		await adapter.send({
			from: '"HoReCa" <noreply@horeca.local>',
			to: 'race@x.com',
			subject: 'Second',
			html: `<a href="${VERIFY_URL}">Войти</a>`,
			text: VERIFY_URL,
		})

		// Poll с since=first → returns SECOND capture (subject reflects it)
		const r2 = await app.request(
			`/api/public/demo/inbox?email=race%40x.com&since=${encodeURIComponent(since1)}`,
		)
		const b2 = (await r2.json()) as {
			data: { latestUrl: string | null; capturedAt: string | null; subject: string | null }
		}
		expect(b2.data.subject).toBe('Second')
		expect(b2.data.capturedAt).not.toBe(since1)
		expect(b2.data.latestUrl).toBe(VERIFY_URL) // same URL ok — time-based filter race-free
	})

	test('[S2] since=now returns null (no captures after current time)', async () => {
		const { createEmailAdapter } = await import('../../workers/lib/postbox-adapter.ts')
		await createEmailAdapter(
			{
				POSTBOX_ENABLED: false,
				POSTBOX_ENDPOINT: 'https://example.com',
				SMTP_HOST: '',
				SMTP_PORT: 0,
				DEMO_DEPLOYMENT: true,
			},
			{ info: () => {}, warn: () => {} },
		).send({
			from: '"HoReCa" <noreply@horeca.local>',
			to: 'user@x.com',
			subject: 'Hi',
			html: `<a href="${VERIFY_URL}">Войти</a>`,
			text: VERIFY_URL,
		})
		const app = makeApp(true)
		const future = new Date(Date.now() + 10_000).toISOString()
		const res = await app.request(
			`/api/public/demo/inbox?email=user%40x.com&since=${encodeURIComponent(future)}`,
		)
		const body = (await res.json()) as {
			data: { latestUrl: string | null; capturedAt: string | null }
		}
		expect(body.data.latestUrl).toBe(null)
		expect(body.data.capturedAt).toBe(null)
	})
})
