/**
 * Production startup guards (B1, 2026-05-19).
 *
 * Pre-`serve()` invariant checks. Each guard implements one canon:
 *   - `assertNoDemoInProduction`: prevent foot-shot launch с DEMO_DEPLOYMENT=true
 *     under APP_MODE=production unless explicit `APP_MODE_PERMITTED_DEMO_OVERRIDE`.
 *   - `assertProductionCaptchaConfigured`: SmartCaptcha must be configured for
 *     production unless demo deployment (which is publicly friction-free by canon).
 *
 * Both throw на violation; caller (`index.ts main()`) lets error propagate
 * к process exit code 1 (production launch fail-closed).
 *
 * Why `APP_MODE` + `DEMO_DEPLOYMENT` confusion is a real risk:
 *   V1 architecture is single-deployment multi-mode (Track A in plan). One
 *   deployment may serve demo AND production tenants. But CURRENT V1 wiring
 *   has demo-only adapters (DemoInbox email/SMS, captcha bypass) that flip
 *   wholesale via `DEMO_DEPLOYMENT=true`. Mixing flags accidentally → demo
 *   features visible в production = data leak, fraud surface, RBL risk.
 *
 * Future: per-tenant mode (`tenant.mode='demo'|'production'`) replaces global
 * flag. At that point this guard removed and per-tenant adapter resolution
 * lands. For V1 — fail-closed на the combination.
 */

import type { env as envType } from '../env.ts'

type EnvShape = typeof envType

/**
 * Fail-closed на foot-shot combination `APP_MODE=production` +
 * `DEMO_DEPLOYMENT=true`. Allow via `APP_MODE_PERMITTED_DEMO_OVERRIDE=true`
 * (operator must consciously opt-in — caught by audit).
 *
 * Why explicit override > silent allow: Linear/Stripe/Apaleo canon Q2 2026
 * = «production flags require operator-consciousness», not «cleverly inferred
 * from other flags».
 */
export function assertNoDemoInProduction(env: EnvShape): void {
	if (env.APP_MODE !== 'production') return
	if (!env.DEMO_DEPLOYMENT) return
	if (env.APP_MODE_PERMITTED_DEMO_OVERRIDE) {
		// Explicit operator opt-in — log warning but allow.
		// eslint-disable-next-line no-console
		console.warn(
			'⚠ APP_MODE=production with DEMO_DEPLOYMENT=true permitted via ' +
				'APP_MODE_PERMITTED_DEMO_OVERRIDE=true. Demo features visible in production — ' +
				'verify per-tenant mode is correctly partitioning users.',
		)
		return
	}
	throw new Error(
		'Refusing to start: APP_MODE=production with DEMO_DEPLOYMENT=true. ' +
			'Demo deployment features (DemoInbox email/SMS, captcha bypass) would be exposed ' +
			'к production users. Set DEMO_DEPLOYMENT=false для production builds OR (only for ' +
			'multi-mode V2 architecture) APP_MODE_PERMITTED_DEMO_OVERRIDE=true to acknowledge.',
	)
}

/**
 * Symmetric к `[N1]` localhost canon в `captcha-gate.ts`: production MUST have
 * captcha actually configured. Without this guard a missed env var would
 * silently disable email-enumeration protection on the public surface — the
 * gate falls through к `reason: 'disabled'` и every magic-link request goes
 * ungated. Demo deployments (`DEMO_DEPLOYMENT=true`) are exempt — they're
 * publicly friction-free by design per `[[demo_strategy]]`.
 */
export function assertProductionCaptchaConfigured(env: EnvShape): void {
	// Guard is self-contained — sandbox skip (consistent с assertNoDemoInProduction).
	// Caller can call regardless of APP_MODE; function no-ops outside production.
	if (env.APP_MODE !== 'production') return
	if (env.DEMO_DEPLOYMENT) return
	if (env.SMARTCAPTCHA_SERVER_KEY && env.SMARTCAPTCHA_SERVER_KEY.length > 0) return
	throw new Error(
		'Refusing to start in APP_MODE=production: SMARTCAPTCHA_SERVER_KEY is unset and ' +
			'DEMO_DEPLOYMENT=false. Either configure SmartCaptcha (see env.ts ' +
			'SMARTCAPTCHA_SERVER_KEY) or flip DEMO_DEPLOYMENT=true для public demo builds.',
	)
}
