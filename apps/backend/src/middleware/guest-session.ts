/**
 * Guest session middleware (M9.widget.5 / A3.1.b — consumer A3.3 guest portal).
 *
 * Reads `__Host-guest_session` signed cookie set by magic-link-consume route.
 * Resolves cookie payload (tenantId / bookingId / scope / jti) → sets
 * `c.var.guestSession` for downstream handlers (guest-portal routes A3.3).
 *
 * Per `plans/m9_widget_5_canonical.md` §D3:
 *   - `__Host-` prefix auto-enforces Path=/ + Secure + no Domain (compile-time
 *     CookieConstraint type + runtime generateCookie enforce per Hono 4.12.16).
 *   - SameSite=Lax (Strict drops cookie на cross-site magic-link click).
 *   - HttpOnly via cookie helper.
 *   - HMAC-SHA-256 signature verified inside `getSignedCookie` —
 *     constant-time via crypto.subtle.verify (per Hono utils/cookie.ts).
 *
 * Failure modes:
 *   - Cookie missing: 401 Unauthorized («Войдите по ссылке из письма»)
 *   - Cookie tampered (HMAC mismatch): 401 (same response — never reveal which)
 *   - Cookie payload malformed: 401 (defensive — should not happen в production)
 *
 * Per-tenant secret resolution: cookie was signed с tenant's secret. To
 * verify, need tenantId — but cookie payload contains tenantId... chicken-egg
 * solved via decode-without-verify pattern. Read cookie raw, parse JSON,
 * extract tenantId, resolve secret, then verify signature against payload.
 */

import { getCookie, getSignedCookie } from 'hono/cookie'
import { factory } from '../factory.ts'

export const GUEST_SESSION_COOKIE_NAME = 'guest_session' as const
export const GUEST_SESSION_COOKIE_NAME_PREFIXED = '__Host-guest_session' as const

export interface GuestSession {
	readonly tenantId: string
	readonly bookingId: string
	readonly scope: 'view' | 'mutate'
	readonly jti: string
}

declare module 'hono' {
	interface ContextVariableMap {
		readonly guestSession: GuestSession
	}
}

interface CookiePayload {
	t?: unknown
	b?: unknown
	s?: unknown
	j?: unknown
}

function parseCookiePayload(raw: string): GuestSession | null {
	let parsed: CookiePayload
	try {
		parsed = JSON.parse(raw) as CookiePayload
	} catch {
		return null
	}
	if (
		typeof parsed.t !== 'string' ||
		typeof parsed.b !== 'string' ||
		typeof parsed.j !== 'string' ||
		(parsed.s !== 'view' && parsed.s !== 'mutate')
	) {
		return null
	}
	return {
		tenantId: parsed.t,
		bookingId: parsed.b,
		scope: parsed.s,
		jti: parsed.j,
	}
}

interface GuestSessionMiddlewareDeps {
	readonly resolveCookieSecret: (tenantId: string) => Promise<string>
}

export function guestSessionMiddleware(deps: GuestSessionMiddlewareDeps) {
	return factory.createMiddleware(async (c, next) => {
		// Phase 1: read raw cookie. Hono `getCookie` returns the URL-decoded
		// whole signed value: `<json>.<base64url_hmac>` (length 44 ending '=').
		// We split off the signature suffix to extract provisional tenantId
		// from the JSON payload — needed to load the per-tenant secret BEFORE
		// HMAC verify (chicken-egg). Forged tenantId не grant access — Phase 2
		// HMAC verify against THAT tenant's secret will fail.
		const rawCookie = getCookie(c, GUEST_SESSION_COOKIE_NAME_PREFIXED)
		if (!rawCookie) {
			return c.json(
				{
					error: {
						code: 'GUEST_SESSION_REQUIRED',
						message: 'Войдите по ссылке из письма для доступа к управлению бронированием.',
					},
				},
				401,
			)
		}
		const lastDotIdx = rawCookie.lastIndexOf('.')
		if (lastDotIdx < 1) {
			return c.json(
				{ error: { code: 'GUEST_SESSION_INVALID', message: 'Недействительная сессия.' } },
				401,
			)
		}
		const payloadJson = rawCookie.substring(0, lastDotIdx)
		const provisional = parseCookiePayload(payloadJson)
		if (!provisional) {
			return c.json(
				{ error: { code: 'GUEST_SESSION_INVALID', message: 'Недействительная сессия.' } },
				401,
			)
		}

		// Phase 2: verify HMAC against tenant's secret.
		const secret = await deps.resolveCookieSecret(provisional.tenantId)
		const verifiedRaw = await getSignedCookie(c, secret, GUEST_SESSION_COOKIE_NAME, 'host')
		if (verifiedRaw === false || verifiedRaw === undefined) {
			return c.json(
				{ error: { code: 'GUEST_SESSION_INVALID', message: 'Недействительная сессия.' } },
				401,
			)
		}
		// Re-parse — verifiedRaw is the cookie value post-HMAC-verify (just JSON).
		const session = parseCookiePayload(verifiedRaw)
		if (!session || session.tenantId !== provisional.tenantId) {
			return c.json(
				{ error: { code: 'GUEST_SESSION_INVALID', message: 'Недействительная сессия.' } },
				401,
			)
		}

		c.set('guestSession', session)
		return next()
	})
}
