/**
 * Round 14.5 tactical bot-defense middleware — captcha gate для demo OTA
 * POST endpoints (`/api/_mock-ota/{yandex,ostrovok}/v1/*` mutations).
 *
 * Empirical context (28.05.2026): после SWS removal боты атакуют public demo
 * POST endpoints, создавая ~130 фейковых бронирований/час → CDC consumers
 * жгут YDB Request Units (56₽/день). Tactical fix = SmartCaptcha gate
 * перед POST mutations.
 *
 * Strategic refactor (per-tenant auth-gated demo + magic-link onboarding +
 * Stripe livemode marker) deferred к dedicated session с ADR upfront,
 * mandatory pnpm test:db pre-push validation, canon `feedback_deploy_as_
 * debug_antipattern_2026_05_19`.
 *
 * Canon refs:
 *   - `feedback_captcha_serverkey_only_canon_2026_05_24` — single signal
 *     activation (`SMARTCAPTCHA_SERVER_KEY` presence)
 *   - Yandex SmartCaptcha docs: https://yandex.cloud/ru/docs/smartcaptcha
 *   - Web research 2026-05-28 confirms canonical token-on-mutation pattern
 *
 * Activation: `SMARTCAPTCHA_SERVER_KEY` env set (production) → enforce;
 * unset (dev/CI/tests) → bypass with structured log warn.
 *
 * Token transport: body field `captchaToken` (matches Better Auth pattern
 * in `captcha-gate.ts`). Frontend демо form needs к include token.
 *
 * Reading endpoints (search, status) NOT gated — they don't create CDC
 * events, low bot-spam value, would hurt UX.
 */

import crypto from 'node:crypto'
import { z } from 'zod'
import { env } from '../env.ts'
import { factory } from '../factory.ts'
import { validateCaptcha } from '../lib/captcha/validate.ts'
import { extractClientIpFromContext } from '../lib/net/client-ip.ts'
import { logger } from '../logger.ts'

// Empty for tests/dev (no trusted proxies); production sets via env config.
const TRUSTED_PROXY_CIDRS: readonly string[] = []

const captchaBodySchema = z.object({
	captchaToken: z.string().min(1).optional(),
})

/**
 * Hono middleware — validate SmartCaptcha token on body before passing к
 * route handler. 422 если token missing / invalid (когда enforced); 200
 * pass-through if `SMARTCAPTCHA_SERVER_KEY` unset (dev).
 *
 * Body parsing: middleware reads body, validates, then re-injects via
 * `c.req.json` cache trick. Hono `c.req.json()` is idempotent — value
 * cached after first call. We call once here, downstream handlers call
 * again без issue.
 */
export function demoCaptchaMiddleware() {
	return factory.createMiddleware(async (c, next) => {
		// Only gate mutations — GET/HEAD pass-through (no body, no state change).
		const method = c.req.method
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
			await next()
			return
		}

		const serverKey = env.SMARTCAPTCHA_SERVER_KEY ?? ''
		if (serverKey.length === 0) {
			// Dev / CI — bypass с structured log signal.
			logger.debug(
				{ event: 'demo.captcha.bypass_disabled', path: c.req.path },
				'Demo captcha disabled (SMARTCAPTCHA_SERVER_KEY unset)',
			)
			await next()
			return
		}

		// Round 7 v3 SWS bypass token — same canonical header pattern as
		// `lib/auth/captcha-gate.ts`. E2E smoke tests + SWS edge allow-rule
		// both send `X-Bypass-Token` с the shared 32-byte secret from
		// `env.SWS_BYPASS_TOKEN` (Lockbox-mounted). Timing-safe compare
		// prevents leak via response-time оракул. Without this, SC deploy
		// playwright-smoke (demo OTA POST endpoints) fails 422 captcha_
		// required — discovered empirically Run #125 2026-05-28.
		const provided = c.req.header('x-bypass-token')?.trim() ?? ''
		const expectedToken = env.SWS_BYPASS_TOKEN ?? ''
		// Empirical diagnostic Run #126+ — structured log every bypass attempt
		// (3 outcomes: no-header / mismatch / match) so production smoke
		// failures can be diagnosed via container logs without guessing.
		// Token VALUES не logged — только length + match-or-not.
		logger.info(
			{
				event: 'demo.captcha.bypass_attempt',
				path: c.req.path,
				providedLen: provided.length,
				expectedLen: expectedToken.length,
				envSet: expectedToken.length > 0,
			},
			'Demo captcha bypass attempt diagnostics',
		)
		if (expectedToken.length > 0 && provided.length > 0) {
			const expectedBuf = Buffer.from(expectedToken, 'utf8')
			const providedBuf = Buffer.from(provided, 'utf8')
			if (
				expectedBuf.length === providedBuf.length &&
				crypto.timingSafeEqual(expectedBuf, providedBuf)
			) {
				logger.info(
					{ event: 'demo.captcha.bypass_token', path: c.req.path },
					'Demo captcha bypass via X-Bypass-Token (E2E/SWS canon Round 7 v3)',
				)
				await next()
				return
			}
		}

		// Parse body — Hono c.req.json() is idempotent (parsed body cached).
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json(
				{
					error: 'invalid_payload',
					message: 'Request body must be valid JSON',
				},
				400,
			)
		}

		const parsed = captchaBodySchema.safeParse(body)
		if (!parsed.success || parsed.data.captchaToken === undefined) {
			logger.info(
				{
					event: 'demo.captcha.missing_token',
					path: c.req.path,
					ip: extractClientIpFromContext(c, TRUSTED_PROXY_CIDRS),
				},
				'Demo captcha token missing — booking rejected',
			)
			return c.json(
				{
					error: 'captcha_required',
					message: 'SmartCaptcha token required для demo booking',
				},
				422,
			)
		}

		// Validate token против Yandex SmartCaptcha API.
		const clientIp = extractClientIpFromContext(c, TRUSTED_PROXY_CIDRS)
		const result = await validateCaptcha(serverKey, parsed.data.captchaToken, clientIp)

		if (!result.ok) {
			logger.warn(
				{
					event: 'demo.captcha.failed',
					path: c.req.path,
					reason: result.reason,
					ip: clientIp,
				},
				'Demo captcha validation failed — booking rejected',
			)
			return c.json(
				{
					error: 'captcha_failed',
					reason: result.reason,
					message: 'SmartCaptcha validation failed',
				},
				422,
			)
		}

		// Token valid — pass к route handler.
		await next()
	})
}
