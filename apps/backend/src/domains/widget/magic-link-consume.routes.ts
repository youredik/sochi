/**
 * Magic-link consume routes — two-step GET render → POST consume (M9.widget.5 / A3.1.b).
 *
 * Per `plans/m9_widget_5_canonical.md` §D1 + §D5:
 *   - GET `/api/public/booking/jwt/:jwt/render` — verify (no consume) +
 *     return JSON c booking summary. Frontend renders confirm-button page.
 *     Apple MPP / Slack unfurl / Outlook SafeLinks safely follow GET — no
 *     attempts burned (multi-attempt buffer for view scope = 5 attempts).
 *   - POST `/api/public/booking/jwt/:jwt/consume` — atomic consume +
 *     `Set-Cookie: __Host-guest_session=...; SameSite=Lax; HttpOnly;
 *     Secure; Path=/`. Returns 200 + bookingId payload; frontend redirects
 *     к `/booking/guest-portal/{bookingId}`.
 *
 * Token tenant resolution: extract iss claim BEFORE signature verify (need
 * tenantId to load per-tenant secret). Forged iss → loads target tenant's
 * secret → signature verify still fails (forged JWT NOT signed with that
 * tenant's secret). Two-step lookup pattern is canonical для multi-tenant
 * JWT verification (Better Auth, WorkOS, Clerk).
 *
 * Cookie scheme per plan §D3: `__Host-guest_session` prefix auto-enforces
 * Path=/ + Secure + no Domain (Hono `setSignedCookie({ prefix: 'host' })`).
 * SameSite=Lax (Strict drops cookie на cross-site magic-link click from
 * email client → external site).
 */

import { Hono } from 'hono'
import { setSignedCookie } from 'hono/cookie'
import type { AppEnv } from '../../factory.ts'
import { extractTenantIdFromJwtUnsafe } from '../../lib/magic-link/jwt.ts'
import type { MagicLinkService } from './magic-link.service.ts'
import { MagicLinkVerifyError } from './magic-link.service.ts'

export const GUEST_SESSION_COOKIE_NAME = 'guest_session' as const

interface MagicLinkConsumeRoutesDeps {
	readonly magicLinkService: MagicLinkService
	/**
	 * Per-tenant cookie-signing secret. For Phase 1 reuse magicLinkSecret
	 * (same value, different purpose). Phase 2 separate dedicated cookie
	 * secret в Lockbox.
	 */
	readonly resolveCookieSecret: (tenantId: string) => Promise<string>
	/**
	 * Cookie max-age в seconds. Default: 7 days. Override для tests.
	 */
	readonly sessionCookieMaxAge?: number
}

const DEFAULT_SESSION_MAX_AGE = 7 * 24 * 60 * 60

interface RenderResponseBody {
	readonly bookingId: string
	readonly scope: 'view' | 'mutate'
	readonly attemptsRemaining: number
	readonly expiresAt: string /** ISO */
}

interface ConsumeResponseBody {
	readonly bookingId: string
	readonly scope: 'view' | 'mutate'
}

interface MagicLinkErrorBody {
	readonly error: {
		readonly code:
			| 'MAGIC_LINK_INVALID'
			| 'MAGIC_LINK_EXPIRED'
			| 'MAGIC_LINK_FULLY_CONSUMED'
			| 'MAGIC_LINK_NOT_FOUND'
		readonly message: string
	}
}

function mapVerifyError(err: MagicLinkVerifyError): {
	body: MagicLinkErrorBody
	status: 401 | 410
} {
	switch (err.reason) {
		case 'expired':
			return {
				body: {
					error: {
						code: 'MAGIC_LINK_EXPIRED',
						message: 'Ссылка истекла. Запросите новую через форму поиска брони.',
					},
				},
				status: 410,
			}
		case 'fully_consumed':
			return {
				body: {
					error: {
						code: 'MAGIC_LINK_FULLY_CONSUMED',
						message: 'Ссылка использована. Запросите новую через форму поиска брони.',
					},
				},
				status: 410,
			}
		case 'not_found':
			return {
				body: {
					error: {
						code: 'MAGIC_LINK_NOT_FOUND',
						message: 'Ссылка не найдена. Возможно, она устарела.',
					},
				},
				status: 410,
			}
		default:
			return {
				body: {
					error: {
						code: 'MAGIC_LINK_INVALID',
						message: 'Неверная ссылка.',
					},
				},
				status: 401,
			}
	}
}

export function createMagicLinkConsumeRoutes(deps: MagicLinkConsumeRoutesDeps) {
	const sessionMaxAge = deps.sessionCookieMaxAge ?? DEFAULT_SESSION_MAX_AGE

	const app = new Hono<AppEnv>()

	return app
		.get('/booking/jwt/:jwt/render', async (c) => {
			const jwt = c.req.param('jwt')
			let tenantId: string
			try {
				tenantId = extractTenantIdFromJwtUnsafe(jwt)
			} catch {
				const { body, status } = mapVerifyError(
					new MagicLinkVerifyError('cannot extract tenant', 'malformed'),
				)
				return c.json(body, status)
			}

			try {
				const { claims, token } = await deps.magicLinkService.verify({ tenantId, jwt })
				const body: RenderResponseBody = {
					bookingId: claims.bookingId,
					scope: claims.scope,
					attemptsRemaining: token.attemptsRemaining,
					expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
				}
				// `Cache-Control: no-store` — defense-in-depth против access-log/CDN
				// caching `?token=...` URL leak (per plan §D5 OWASP guidance).
				c.header('Cache-Control', 'no-store')
				c.header('Referrer-Policy', 'no-referrer')
				return c.json(body, 200)
			} catch (err) {
				if (err instanceof MagicLinkVerifyError) {
					const { body, status } = mapVerifyError(err)
					return c.json(body, status)
				}
				throw err
			}
		})
		.post('/booking/jwt/:jwt/consume', async (c) => {
			const jwt = c.req.param('jwt')
			let tenantId: string
			try {
				tenantId = extractTenantIdFromJwtUnsafe(jwt)
			} catch {
				const { body, status } = mapVerifyError(
					new MagicLinkVerifyError('cannot extract tenant', 'malformed'),
				)
				return c.json(body, status)
			}

			const fromIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anonymous'
			const fromUa = c.req.header('user-agent') ?? null

			try {
				const { claims } = await deps.magicLinkService.consume({
					tenantId,
					jwt,
					fromIp,
					fromUa,
				})

				const cookieSecret = await deps.resolveCookieSecret(tenantId)
				// Cookie payload — claim subset для downstream guest-portal middleware.
				// Include tenantId + bookingId + scope + jti (revocation possible later).
				const cookieValue = JSON.stringify({
					t: tenantId,
					b: claims.bookingId,
					s: claims.scope,
					j: claims.jti,
				})
				await setSignedCookie(c, GUEST_SESSION_COOKIE_NAME, cookieValue, cookieSecret, {
					prefix: 'host',
					httpOnly: true,
					secure: true,
					sameSite: 'Lax',
					maxAge: sessionMaxAge,
				})

				const body: ConsumeResponseBody = {
					bookingId: claims.bookingId,
					scope: claims.scope,
				}
				c.header('Cache-Control', 'no-store')
				c.header('Referrer-Policy', 'no-referrer')
				return c.json(body, 200)
			} catch (err) {
				if (err instanceof MagicLinkVerifyError) {
					const { body, status } = mapVerifyError(err)
					return c.json(body, status)
				}
				throw err
			}
		})
}
