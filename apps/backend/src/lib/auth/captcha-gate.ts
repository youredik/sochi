import { z } from 'zod'
import { logger } from '../../logger.ts'
import { type CaptchaValidationResult, validateCaptcha } from '../captcha/validate.ts'

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
 * Activation: env-gated. Unset `SMARTCAPTCHA_SERVER_KEY` (dev / CI / e2e)
 * bypasses validation entirely — frontend widget is not rendered either
 * (mirrored gate в `apps/frontend/src/features/auth/lib/captcha.ts`).
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
	| { pass: true; reason: 'disabled' | 'not-applicable' | 'validated' }
	| { pass: false; reason: 'missing_token' | CaptchaValidationResult['reason'] }

export interface CaptchaGateContext {
	path: string
	body: unknown
	/** Best-effort source IP — leftmost X-Forwarded-For else X-Real-IP. */
	clientIp?: string
}

export interface CaptchaGateDeps {
	serverKey?: string
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
 * fidelity. Yandex's bot scoring uses this signal — when absent the
 * widget still works but accuracy drops.
 */
export function extractClientIp(headers: Headers): string | undefined {
	const xff = headers.get('x-forwarded-for') ?? ''
	const leftmost = xff.split(',')[0]?.trim()
	if (leftmost) return leftmost
	const xri = headers.get('x-real-ip')
	return xri ?? undefined
}
