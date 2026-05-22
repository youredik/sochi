import { z } from 'zod'
import { env } from '../../env.ts'
import { logger } from '../../logger.ts'
import { type CaptchaValidationResult, validateCaptcha } from '../captcha/validate.ts'
import { resolveClientIpSync } from '../net/client-ip.ts'

/**
 * Captcha gate for Better Auth endpoints — canonical 2026 pattern.
 *
 * Why a separate module: the gate is the security-critical seam and we want
 * it unit-testable without standing up a full Better Auth instance. The hook
 * in `auth.ts` is a thin one-liner that delegates here; this file owns the
 * branching logic + parsing.
 *
 * Endpoint protected (the sole auth entrypoint after passwordless canon
 * shift per `[[auth-passwordless-canon]]` 2026-05-13):
 *   - POST /sign-in/magic-link   (BA magic-link plugin — JIT signup + sign-in)
 *
 * Activation canon — ONE short-circuit (dev), captcha enforced иначе:
 *   1. `nodeEnv !== 'production'` → captcha is ALWAYS skipped on localhost /
 *      CI / test. Hard rule per `[[no_half_measures]]` — even if an engineer
 *      pastes a real server key into local `.env`, dev requests still bypass.
 *      No surprise friction; pairs symmetrically с frontend widget which only
 *      renders when `VITE_YANDEX_CAPTCHA_SITE_KEY` is baked into the build.
 *
 * **2026-05-22 demoDeployment bypass УБРАН** — раньше демо deployment
 * пропускал captcha (canonical «убрать friction для prospects»), но эмпирически
 * боты могут flood'ить DemoInbox (MAX_TOTAL_RECIPIENTS=500), ломая demo для
 * других prospects. Captcha enforced даже в demo если `SMARTCAPTCHA_SERVER_
 * KEY` set. Если key пустой → fallback `'disabled'` (config-drift safety
 * net, но startup guard в `index.ts` refuses to boot prod without key).
 * Frontend canon `[[captcha_localhost_canon]]` updated same date.
 *
 * Token transport: body field `captchaToken`. Following stankoff pattern
 * which uses arbitrary body field; Better Auth forwards unknown fields
 * into `ctx.body` untouched. Header transport (`x-captcha-response`,
 * used by BA built-in plugin) avoided because the BA plugin doesn't ship
 * Yandex SmartCaptcha support — we have to do this manually.
 */

export const CAPTCHA_PATHS = new Set<string>(['/sign-in/magic-link'])

const captchaBodySchema = z.object({
	captchaToken: z.string().min(1).optional(),
})

/** Result of the gate decision. */
export type CaptchaGateResult =
	| {
			pass: true
			reason: 'non-production' | 'disabled' | 'not-applicable' | 'validated'
	  }
	| { pass: false; reason: 'missing_token' | CaptchaValidationResult['reason'] }

export interface CaptchaGateContext {
	path: string
	body: unknown
	/** Best-effort source IP — leftmost X-Forwarded-For else X-Real-IP. */
	clientIp?: string
}

export interface CaptchaGateDeps {
	serverKey?: string
	/**
	 * Node runtime mode. Anything except `'production'` short-circuits the
	 * gate before any other check — localhost / CI / test never pay captcha
	 * friction. Defaults to `'production'` so callers that forget to wire
	 * env get the strict path, not the bypass.
	 */
	nodeEnv?: 'development' | 'production' | 'test'
	validate?: typeof validateCaptcha
}

/**
 * Evaluate whether an auth request should be allowed past the captcha gate.
 *
 * Returns a structured decision; the BA hook caller is responsible for
 * throwing the appropriate `APIError`. Keeps this function pure / testable.
 */
export async function evaluateCaptchaGate(
	ctx: CaptchaGateContext,
	deps: CaptchaGateDeps,
): Promise<CaptchaGateResult> {
	const nodeEnv = deps.nodeEnv ?? 'production'
	if (nodeEnv !== 'production') {
		return { pass: true, reason: 'non-production' }
	}
	const serverKey = deps.serverKey
	if (!serverKey) {
		return { pass: true, reason: 'disabled' }
	}
	if (!CAPTCHA_PATHS.has(ctx.path)) {
		return { pass: true, reason: 'not-applicable' }
	}

	const parsed = captchaBodySchema.safeParse(ctx.body)
	const token = parsed.success ? parsed.data.captchaToken : undefined
	if (!token) {
		logger.warn({ path: ctx.path }, 'Captcha rejected: missing token')
		return { pass: false, reason: 'missing_token' }
	}

	const validateFn = deps.validate ?? validateCaptcha
	const result = await validateFn(serverKey, token, ctx.clientIp)
	if (result.ok) {
		return { pass: true, reason: 'validated' }
	}
	return { pass: false, reason: result.reason }
}

/**
 * Pick the best-effort client IP from request headers for SmartCaptcha
 * fidelity. Yandex's bot scoring uses this signal — when absent the widget
 * still works but accuracy drops.
 *
 * B11 (2026-05-19): unified с right-most-trusted-proxy canon — supersedes
 * the legacy leftmost-wins helper. Even though SmartCaptcha API treats
 * `clientIp` as informational signal (signature is the real authenticator),
 * keeping a separate leftmost reader contradicts repo-wide canon + invites
 * dev confusion. Same `resolveClientIpSync` underlies widget-rate-limit /
 * demo-inbox-rate-limit / RUM / consent log.
 */
export function extractClientIp(headers: Headers): string | undefined {
	const ip = resolveClientIpSync(headers, env.TRUSTED_PROXY_CIDRS)
	return ip === 'anonymous' ? undefined : ip
}
