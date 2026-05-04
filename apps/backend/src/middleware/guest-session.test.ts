/**
 * Strict tests для guest-session middleware (M9.widget.5 / A3.1.b).
 *
 * Pure middleware test — forge signed cookies через Hono cookie helpers
 * directly (no dependency on widget domain — depcruise canon: middleware
 * MUST NOT depend on domain layer).
 *
 * Coverage matrix:
 *   ─── Happy path ──────────────────────────────────────────────
 *     [GS1] valid cookie set with proper HMAC → middleware sets c.var.guestSession
 *     [GS2] guestSession contains tenantId + bookingId + scope + jti
 *
 *   ─── Adversarial ─────────────────────────────────────────────
 *     [GS3] no cookie → 401 GUEST_SESSION_REQUIRED
 *     [GS4] malformed JSON cookie payload → 401 GUEST_SESSION_INVALID
 *     [GS5] valid JSON но missing fields → 401 GUEST_SESSION_INVALID
 *     [GS6] tampered HMAC signature → 401 GUEST_SESSION_INVALID
 *     [GS7] cookie with mismatched tenantId payload+secret → 401 GUEST_SESSION_INVALID
 *     [GS8] cross-tenant: tenant A's cookie с tenant B secret resolver → reject
 */

import { Hono } from 'hono'
import { setSignedCookie } from 'hono/cookie'
import { describe, expect, test } from 'vitest'
import type { AppEnv } from '../factory.ts'
import { type GuestSession, guestSessionMiddleware } from './guest-session.ts'

const TENANT_A = 'org_01HABC0001'
const TENANT_B = 'org_01HABC0002'
const BOOKING_A = 'book_01HBOK0001'
const SECRET_A = 'test-secret-tenant-a-32bytes-padding'
const SECRET_B = 'test-secret-tenant-b-32bytes-padding'

interface CookiePayload {
	t: string
	b: string
	s: 'view' | 'mutate'
	j: string
}

/** Build app — middleware resolves secret per provided map. */
function buildApp(secretMap: Record<string, string>) {
	return new Hono<AppEnv>()
		.post('/issue/:tenantId/:secret', async (c) => {
			const tenantId = c.req.param('tenantId')
			const secret = c.req.param('secret') === 'A' ? SECRET_A : SECRET_B
			const payload: CookiePayload = {
				t: tenantId,
				b: BOOKING_A,
				s: 'mutate',
				j: 'jti-test-123',
			}
			await setSignedCookie(c, 'guest_session', JSON.stringify(payload), secret, {
				prefix: 'host',
				httpOnly: true,
				secure: true,
				sameSite: 'Lax',
				maxAge: 60,
			})
			return c.json({ ok: true })
		})
		.use(
			'/private/*',
			guestSessionMiddleware({
				resolveCookieSecret: async (tenantId) => {
					const s = secretMap[tenantId]
					if (!s) throw new Error(`no secret для tenant ${tenantId}`)
					return s
				},
			}),
		)
		.get('/private/whoami', (c) => {
			const session: GuestSession = c.var.guestSession
			return c.json({ session })
		})
}

async function obtainCookie(
	app: ReturnType<typeof buildApp>,
	tenantId: string,
	secretLabel: 'A' | 'B',
): Promise<string> {
	const res = await app.request(`/issue/${tenantId}/${secretLabel}`, { method: 'POST' })
	const setCookie = res.headers.get('set-cookie') ?? ''
	const match = /__Host-guest_session=([^;]+)/.exec(setCookie)
	expect(match).not.toBeNull()
	return `__Host-guest_session=${match?.[1]}`
}

describe('guestSessionMiddleware', () => {
	test('[GS1] valid cookie set with proper HMAC → middleware sets c.var.guestSession', async () => {
		const app = buildApp({ [TENANT_A]: SECRET_A })
		const cookie = await obtainCookie(app, TENANT_A, 'A')
		const res = await app.request('/private/whoami', { headers: { Cookie: cookie } })
		expect(res.status).toBe(200)
	})

	test('[GS2] guestSession contains tenantId + bookingId + scope + jti', async () => {
		const app = buildApp({ [TENANT_A]: SECRET_A })
		const cookie = await obtainCookie(app, TENANT_A, 'A')
		const res = await app.request('/private/whoami', { headers: { Cookie: cookie } })
		const body = (await res.json()) as { session: GuestSession }
		expect(body.session.tenantId).toBe(TENANT_A)
		expect(body.session.bookingId).toBe(BOOKING_A)
		expect(body.session.scope).toBe('mutate')
		expect(body.session.jti).toBe('jti-test-123')
	})

	test('[GS3] no cookie → 401 GUEST_SESSION_REQUIRED', async () => {
		const app = buildApp({ [TENANT_A]: SECRET_A })
		const res = await app.request('/private/whoami')
		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('GUEST_SESSION_REQUIRED')
	})

	test('[GS4] malformed JSON payload → 401 GUEST_SESSION_INVALID', async () => {
		const app = buildApp({ [TENANT_A]: SECRET_A })
		const res = await app.request('/private/whoami', {
			headers: { Cookie: '__Host-guest_session=not-json-at-all' },
		})
		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('GUEST_SESSION_INVALID')
	})

	test('[GS5] valid JSON but missing fields → 401 GUEST_SESSION_INVALID', async () => {
		const app = buildApp({ [TENANT_A]: SECRET_A })
		const incomplete = encodeURIComponent(JSON.stringify({ t: TENANT_A }))
		const res = await app.request('/private/whoami', {
			headers: { Cookie: `__Host-guest_session=${incomplete}` },
		})
		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('GUEST_SESSION_INVALID')
	})

	test('[GS6] tampered HMAC signature → 401 GUEST_SESSION_INVALID', async () => {
		const app = buildApp({ [TENANT_A]: SECRET_A })
		const cookie = await obtainCookie(app, TENANT_A, 'A')
		const tamperedCookie = `${cookie.substring(0, cookie.length - 1)}X`
		const res = await app.request('/private/whoami', {
			headers: { Cookie: tamperedCookie },
		})
		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('GUEST_SESSION_INVALID')
	})

	test('[GS7] forged tenantId payload (HMAC was for A, payload claims B) → reject', async () => {
		const app = buildApp({ [TENANT_A]: SECRET_A, [TENANT_B]: SECRET_B })
		const aCookie = await obtainCookie(app, TENANT_A, 'A')
		// Decode A's cookie, swap payload tenantId к B, re-encode WITHOUT re-signing.
		const cookieValue = decodeURIComponent(aCookie.replace('__Host-guest_session=', ''))
		const lastDotIdx = cookieValue.lastIndexOf('.')
		const hmac = cookieValue.substring(lastDotIdx + 1)
		const payload: CookiePayload = {
			t: TENANT_B, // FORGED — claims tenant B
			b: BOOKING_A,
			s: 'mutate',
			j: 'jti-test-123',
		}
		const forgedRaw = `${JSON.stringify(payload)}.${hmac}`
		const forgedCookie = `__Host-guest_session=${encodeURIComponent(forgedRaw)}`
		// Middleware reads payload tenantId=B, resolves secret B, HMAC verify fails
		// (HMAC was computed with secret A для different payload).
		const res = await app.request('/private/whoami', {
			headers: { Cookie: forgedCookie },
		})
		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('GUEST_SESSION_INVALID')
	})

	test('[GS8] cross-tenant: cookie signed for A NOT verifiable когда middleware resolves для B', async () => {
		// Middleware будет looking up secret based on payload tenantId.
		// If payload says tenantA but secretMap doesn't have A — resolveCookieSecret throws.
		// Or если payload says A and secretMap has A but signature was made с secret B,
		// HMAC verify fails → 401.
		const app = buildApp({ [TENANT_A]: SECRET_B }) // wrong secret для tenant A
		const cookie = await obtainCookie(app, TENANT_A, 'A') // signed with SECRET_A
		const res = await app.request('/private/whoami', { headers: { Cookie: cookie } })
		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('GUEST_SESSION_INVALID')
	})
})

describe('guestSessionMiddleware — D3 Lax→Strict rotation', () => {
	test('[GS9] re-emits Set-Cookie с SameSite=Strict on authenticated request', async () => {
		const app = buildApp({ [TENANT_A]: SECRET_A })
		const cookie = await obtainCookie(app, TENANT_A, 'A')
		const res = await app.request('/private/whoami', { headers: { Cookie: cookie } })
		expect(res.status).toBe(200)
		const setCookieAfter = res.headers.get('set-cookie') ?? ''
		// Middleware re-emits с Strict (rotation per plan §D3 — initial Lax
		// from /consume rotates → Strict on first authenticated read).
		expect(setCookieAfter).toContain('__Host-guest_session=')
		expect(setCookieAfter).toMatch(/SameSite=Strict/i)
		expect(setCookieAfter).toMatch(/HttpOnly/i)
		expect(setCookieAfter).toMatch(/Secure/)
		expect(setCookieAfter).toMatch(/Path=\//)
	})

	test('[GS10] rotated cookie verifiable on subsequent request (HMAC roundtrip preserved)', async () => {
		const app = buildApp({ [TENANT_A]: SECRET_A })
		const cookie = await obtainCookie(app, TENANT_A, 'A')

		// Phase 1: first authenticated request — receives Set-Cookie с Strict
		const res1 = await app.request('/private/whoami', { headers: { Cookie: cookie } })
		expect(res1.status).toBe(200)
		const setCookie1 = res1.headers.get('set-cookie') ?? ''
		const match = /__Host-guest_session=([^;]+)/.exec(setCookie1)
		expect(match).not.toBeNull()
		const rotatedCookie = `__Host-guest_session=${match?.[1]}`

		// Phase 2: send rotated cookie back — middleware verifies HMAC OK,
		// session resolved correctly (rotation didn't break signature).
		const res2 = await app.request('/private/whoami', { headers: { Cookie: rotatedCookie } })
		expect(res2.status).toBe(200)
		const body = (await res2.json()) as { session: GuestSession }
		expect(body.session.tenantId).toBe(TENANT_A)
	})
})
