import { z } from 'zod'
import { env } from '../../env.ts'
import { logger } from '../../logger.ts'
import { type CaptchaValidationResult, validateCaptcha } from '../captcha/validate.ts'
import { resolveClientIpSync } from '../net/client-ip.ts'
import { verifyServiceAccountJwt } from './sa-jwt-verify.ts'

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
 * Activation canon (2026-05-24 hardened — security red team Round 6):
 *   Single signal — `serverKey` presence.
 *     - serverKey unset/blank → `'disabled'` (covers local dev + CI/test
 *       where engineers don't set the key)
 *     - serverKey set → captcha enforced full validation
 *
 *   PREVIOUS canon (refuted): `nodeEnv !== 'production'` blanket short-
 *   circuit. Red team identified: YC Serverless Container can boot с
 *   `NODE_ENV=development` even в demo/production builds (typical
 *   misconfig per [[feedback_demo_inbox_panel_ci_canon_2026_05_21]]).
 *   That short-circuit silently disabled captcha entirely → email
 *   enumeration + DemoInbox flood + Vision cost-burn vector.
 *
 *   Local DX impact: engineers без real key пишут в `.env` blank →
 *   `'disabled'` bypass. Engineer тестирующий captcha-flow локально
 *   с реальным key получает full validation (canonical desired flow).
 *
 * **2026-05-22 demoDeployment bypass УБРАН** — раньше демо deployment
 * пропускал captcha (canonical «убрать friction для prospects»), но эмпирически
 * боты могут flood'ить DemoInbox (MAX_TOTAL_RECIPIENTS=500), ломая demo для
 * других prospects. Captcha enforced даже в demo если `SMARTCAPTCHA_SERVER_
 * KEY` set. Если key пустой → fallback `'disabled'` (config-drift safety
 * net, но startup guard в `index.ts` refuses to boot prod без key).
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
			reason: 'disabled' | 'not-applicable' | 'validated' | 'sa-jwt'
	  }
	| { pass: false; reason: 'missing_token' | CaptchaValidationResult['reason'] }

export interface CaptchaGateContext {
	path: string
	body: unknown
	/** Best-effort source IP — leftmost X-Forwarded-For else X-Real-IP. */
	clientIp?: string
	/**
	 * Round 7 v2 2026-05-24 — canonical Yandex SA JWT from
	 * `Authorization: Bearer <jwt>` header. PS256-signed by SA private key,
	 * verified offline against public key. Replaces v1 shared static
	 * `smokeBypassToken` canon — cloud-native canonical 2026.
	 *
	 * Backend auth.ts extracts header value; gate verifies via
	 * `verifyServiceAccountJwt`. On pass → reason 'sa-jwt' + audit log.
	 */
	saJwt?: string
}

export interface CaptchaGateDeps {
	serverKey?: string
	validate?: typeof validateCaptcha
	/**
	 * Round 7 v2 2026-05-24 — SA JWT verification config from env.
	 * All 3 fields must be present for bypass; missing any → bypass disabled.
	 * - publicKeyPem: SA's RSA public key (from Lockbox)
	 * - serviceAccountId: trusted SA's `aje...` ID
	 * - audience: expected JWT `aud` claim (binds token к deployment)
	 */
	saJwtConfig?: {
		publicKeyPem: string
		serviceAccountId: string
		audience: string
	}
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
	const serverKey = deps.serverKey?.trim()
	if (!serverKey) {
		return { pass: true, reason: 'disabled' }
	}
	if (!CAPTCHA_PATHS.has(ctx.path)) {
		return { pass: true, reason: 'not-applicable' }
	}

	// Round 7 v2 2026-05-24 — canonical Yandex SA JWT bypass.
	// SUPERSEDES Round 7 v1 shared-token canon (insecure: rotation burden,
	// timing-attack surface). v2 uses PS256-signed JWT verified offline
	// against SA public key — cryptographic, audience-bound, short-lived.
	if (deps.saJwtConfig && ctx.saJwt) {
		const result = await verifyServiceAccountJwt(ctx.saJwt, {
			publicKeyPem: deps.saJwtConfig.publicKeyPem,
			expectedServiceAccountId: deps.saJwtConfig.serviceAccountId,
			expectedAudience: deps.saJwtConfig.audience,
		})
		if (result.ok) {
			logger.warn(
				{
					path: ctx.path,
					event: 'captcha.sa_jwt_bypass',
					serviceAccountId: result.serviceAccountId,
					expiresAt: result.expiresAt.toISOString(),
				},
				'Captcha gate bypassed via Yandex SA JWT — audit',
			)
			return { pass: true, reason: 'sa-jwt' }
		}
		// JWT presented but verification failed — log + fall through к captcha.
		// Don't 401: legitimate clients should fall back к real captcha if their
		// token is malformed/expired (e.g. during key rotation grace window).
		logger.warn(
			{
				path: ctx.path,
				event: 'captcha.sa_jwt_invalid',
				reason: result.reason,
			},
			'SA JWT presented but invalid — falling through к captcha',
		)
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
