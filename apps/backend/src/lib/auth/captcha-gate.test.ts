/**
 * Captcha gate — strict tests (per `feedback_strict_tests.md`).
 *
 *   ─── Activation gating ──────────────────────────────────────────
 *     [A1] serverKey unset → pass with reason 'disabled' (dev bypass)
 *     [A2] path not in CAPTCHA_PATHS → pass with reason 'not-applicable'
 *
 *   ─── Token presence ─────────────────────────────────────────────
 *     [T1] no captchaToken in body → fail with reason 'missing_token'
 *     [T2] empty-string captchaToken → fail with reason 'missing_token'
 *     [T3] non-object body (string) → fail with reason 'missing_token'
 *
 *   ─── Validation result passthrough ──────────────────────────────
 *     [V1] validate() returns ok → pass with reason 'validated'
 *     [V2] validate() returns invalid_token → fail with reason
 *          'invalid_token'
 *     [V3] validate() returns network_error → fail with reason
 *          'network_error'
 *     [V4] validate() returns timeout → fail with reason 'timeout'
 *     [V5] validate() returns bad_response → fail with reason
 *          'bad_response'
 *
 *   ─── Endpoint coverage (passwordless canon 2026-05-13 — only magic-link) ─
 *     [E1] CAPTCHA_PATHS contains exactly /sign-in/magic-link
 *     [E2] retired email/password endpoints (sign-up/email, sign-in/email,
 *          forget-password) → not-applicable when serverKey set (BA disables
 *          the handlers anyway; we keep the gate strict-narrow)
 *
 *   ─── Client IP extraction ───────────────────────────────────────
 *     [I1] X-Forwarded-For first IP wins (proxy chain)
 *     [I2] X-Real-IP fallback when XFF absent
 *     [I3] both absent → undefined
 *     [I4] XFF whitespace handling — trim each comma-segment
 *
 *   ─── IP propagation ─────────────────────────────────────────────
 *     [P1] clientIp passed through to validate()
 */
import { describe, expect, mock, test } from 'bun:test'
import { CAPTCHA_PATHS, evaluateCaptchaGate, extractClientIp } from './captcha-gate.ts'
import type { CaptchaValidationResult } from '../captcha/validate.ts'

type ValidateFn = (
	serverKey: string,
	token: string,
	clientIp?: string,
) => Promise<CaptchaValidationResult>

function mockValidate(result: CaptchaValidationResult): {
	fn: ValidateFn
	calls: Array<[string, string, string | undefined]>
} {
	const calls: Array<[string, string, string | undefined]> = []
	const fn: ValidateFn = async (sk, t, ip) => {
		calls.push([sk, t, ip])
		return result
	}
	return { fn, calls }
}

describe('evaluateCaptchaGate', () => {
	/*  ─── Activation gating (Round 6 hardening — serverKey ONLY) ─────── */

	test('[A1] serverKey unset → disabled (local dev / CI no-key path)', async () => {
		// Round 6 2026-05-24: previously `nodeEnv !== 'production'` blanket
		// bypass. Removed — security red team identified that NODE_ENV can
		// leak `development` even в production-mode containers, silently
		// disabling captcha entirely. Now единственный bypass = serverKey
		// missing/blank (local dev, CI without secret).
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'x' } },
			{},
		)
		expect(res).toEqual({ pass: true, reason: 'disabled' })
	})

	test('[A1.blank] serverKey whitespace-only → disabled (trim defence)', async () => {
		// Secret manager misconfig sometimes substitutes blank as "   " (CI
		// YAML heredoc trim issue). Symmetric с production-guards trim canon.
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'x' } },
			{ serverKey: '   ' },
		)
		expect(res).toEqual({ pass: true, reason: 'disabled' })
	})

	test('[A2] serverKey set + missing token → missing_token (no nodeEnv escape hatch)', async () => {
		// Critical regression guard: previously nodeEnv=development would
		// silently pass даже с serverKey set. Round 6 hardening — serverKey
		// presence alone gates validation. Engineer тестирующий captcha
		// локально с реальным key получает full enforcement.
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: {} },
			{ serverKey: 'ysc2_real_key' },
		)
		expect(res).toEqual({ pass: false, reason: 'missing_token' })
	})

	test('[D1] 2026-05-22 — captcha enforced even в demo (decouple от DEMO_DEPLOYMENT)', async () => {
		// Раньше demoDeployment=true bypass'ил captcha-gate. 2026-05-22 — убрано.
		// Канон: если SMARTCAPTCHA_SERVER_KEY set, captcha enforced всегда
		// (production-mode). Демо-окно для flood-атак на DemoInbox закрыто.
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: '' } },
			{ serverKey: 'ysc2_x' },
		)
		expect(res).toEqual({ pass: false, reason: 'missing_token' })
	})

	test('[A2] path not in CAPTCHA_PATHS → not-applicable', async () => {
		const res = await evaluateCaptchaGate(
			{ path: '/list-sessions', body: {} },
			{ serverKey: 'ysc2_x' },
		)
		expect(res).toEqual({ pass: true, reason: 'not-applicable' })
	})

	test('[T1] missing captchaToken → missing_token', async () => {
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { email: 'a@b.c' } },
			{ serverKey: 'ysc2_x' },
		)
		expect(res).toEqual({ pass: false, reason: 'missing_token' })
	})

	test('[T2] empty-string captchaToken → missing_token', async () => {
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: '' } },
			{ serverKey: 'ysc2_x' },
		)
		expect(res).toEqual({ pass: false, reason: 'missing_token' })
	})

	test('[T3] non-object body → missing_token', async () => {
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: 'not-an-object' },
			{ serverKey: 'ysc2_x' },
		)
		expect(res).toEqual({ pass: false, reason: 'missing_token' })
	})

	test('[V1] validate ok → validated', async () => {
		const { fn } = mockValidate({ ok: true })
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'tok' } },
			{ serverKey: 'ysc2_x', validate: fn },
		)
		expect(res).toEqual({ pass: true, reason: 'validated' })
	})

	test('[V2] validate invalid_token → invalid_token', async () => {
		const { fn } = mockValidate({ ok: false, reason: 'invalid_token' })
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'tok' } },
			{ serverKey: 'ysc2_x', validate: fn },
		)
		expect(res).toEqual({ pass: false, reason: 'invalid_token' })
	})

	test('[V3] validate network_error → network_error', async () => {
		const { fn } = mockValidate({ ok: false, reason: 'network_error' })
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'tok' } },
			{ serverKey: 'ysc2_x', validate: fn },
		)
		expect(res).toEqual({ pass: false, reason: 'network_error' })
	})

	test('[V4] validate timeout → timeout', async () => {
		const { fn } = mockValidate({ ok: false, reason: 'timeout' })
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'tok' } },
			{ serverKey: 'ysc2_x', validate: fn },
		)
		expect(res).toEqual({ pass: false, reason: 'timeout' })
	})

	test('[V5] validate bad_response → bad_response', async () => {
		const { fn } = mockValidate({ ok: false, reason: 'bad_response' })
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'tok' } },
			{ serverKey: 'ysc2_x', validate: fn },
		)
		expect(res).toEqual({ pass: false, reason: 'bad_response' })
	})

	test('[E1] CAPTCHA_PATHS contains exactly /sign-in/magic-link (passwordless canon)', () => {
		expect(CAPTCHA_PATHS.has('/sign-in/magic-link')).toBe(true)
		expect(CAPTCHA_PATHS.size).toBe(1)
	})

	test('[E2] retired email/password endpoints are no longer in CAPTCHA_PATHS', () => {
		// Belt-and-braces guard: ensures the password endpoints don't sneak
		// back into the set if BA's emailAndPassword block is reintroduced
		// without re-confirming the canon shift.
		expect(CAPTCHA_PATHS.has('/sign-up/email')).toBe(false)
		expect(CAPTCHA_PATHS.has('/sign-in/email')).toBe(false)
		expect(CAPTCHA_PATHS.has('/forget-password')).toBe(false)
	})

	test('[P1] clientIp propagated through to validate()', async () => {
		const { fn, calls } = mockValidate({ ok: true })
		await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'tok' }, clientIp: '198.51.100.7' },
			{ serverKey: 'ysc2_x', validate: fn },
		)
		expect(calls).toEqual([['ysc2_x', 'tok', '198.51.100.7']])
	})

	// ─── Round 7 v3 2026-05-25: Yandex SWS bypass token (app-layer) ─────
	// SUPERSEDES Round 7 v2 SA-JWT canon. Two-layer защита: edge SWS allow-rule
	// (sws.tf) + this app-layer timing-safe compare. Same 32-byte token из
	// Lockbox `sepshn-sws-bypass-token` feeds оба слоя.
	const SWS_TOKEN = 'a'.repeat(64) // 64-char hex placeholder (32 bytes entropy)
	const SWS_WRONG = 'b'.repeat(64)

	test('[B1] valid SWS_BYPASS_TOKEN match → pass with reason sws-bypass (no validate)', async () => {
		const { fn, calls } = mockValidate({ ok: true })
		const r = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: {}, swsBypassToken: SWS_TOKEN },
			{ serverKey: 'ysc2_x', swsBypassToken: SWS_TOKEN, validate: fn },
		)
		expect(r).toEqual({ pass: true, reason: 'sws-bypass' })
		expect(calls).toHaveLength(0)
	})

	test('[B2] mismatched token → fall through к captcha (missing_token)', async () => {
		const r = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: {}, swsBypassToken: SWS_WRONG },
			{ serverKey: 'ysc2_x', swsBypassToken: SWS_TOKEN },
		)
		expect(r).toEqual({ pass: false, reason: 'missing_token' })
	})

	test('[B3] backend env unset → bypass disabled even с valid header', async () => {
		const r = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: {}, swsBypassToken: SWS_TOKEN },
			{ serverKey: 'ysc2_x' },
		)
		expect(r).toEqual({ pass: false, reason: 'missing_token' })
	})

	test('[B4] header absent + env set → falls through (real user без token)', async () => {
		const r = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: {} },
			{ serverKey: 'ysc2_x', swsBypassToken: SWS_TOKEN },
		)
		expect(r).toEqual({ pass: false, reason: 'missing_token' })
	})

	test('[B5] length-mismatched tokens → timing-safe compare returns false, не throws', async () => {
		// timingSafeEqual throws on length mismatch — gate must pre-check length.
		// Provided token length differs от env → fall-through, не uncaught exception.
		const r = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: {}, swsBypassToken: 'too-short' },
			{ serverKey: 'ysc2_x', swsBypassToken: SWS_TOKEN },
		)
		expect(r).toEqual({ pass: false, reason: 'missing_token' })
	})
})

describe('extractClientIp — right-most-trusted-proxy canon (B11)', () => {
	// Default test env TRUSTED_PROXY_CIDRS includes 10.0.0.0/8 + 127.0.0.0/8 +
	// RFC1918 ranges (see env.ts default). Tests below exercise canon under
	// that default — attacker-spoofed leftmost entries get discarded в favor
	// of the rightmost-untrusted hop visible from our trusted ALB.

	test('[I1] real ALB pattern (client → trusted ALB) returns client IP', () => {
		// XFF: «203.0.113.1 (client), 10.0.0.5 (ALB)»
		// Right-walk: 10.0.0.5 trusted, skip → 203.0.113.1 not trusted, return.
		const h = new Headers({
			'x-forwarded-for': '203.0.113.1, 10.0.0.5',
			'x-real-ip': '10.0.0.99',
		})
		expect(extractClientIp(h)).toBe('203.0.113.1')
	})

	test('[I1.spoof] attacker-prepended fake IPs discarded — rightmost-untrusted wins', () => {
		// Attacker forges leftmost; trusted ALB appends real client just before us.
		// Chain (in arrival order): «forged, real_client, alb»
		// Right-walk: alb trusted (10.0.0.1), skip → real_client (192.0.2.50)
		// returned. Forged 203.0.113.1 ignored entirely.
		const h = new Headers({
			'x-forwarded-for': '203.0.113.1, 192.0.2.50, 10.0.0.1',
			'x-real-ip': '10.0.0.99',
		})
		expect(extractClientIp(h)).toBe('192.0.2.50')
	})

	test('[I2] X-Real-IP fallback when XFF absent', () => {
		const h = new Headers({ 'x-real-ip': '203.0.113.2' })
		expect(extractClientIp(h)).toBe('203.0.113.2')
	})

	test('[I3] both absent → undefined (anonymous coerced)', () => {
		const h = new Headers()
		expect(extractClientIp(h)).toBeUndefined()
	})

	test('[I4] XFF whitespace trimmed per segment + right-walk applied', () => {
		const h = new Headers({ 'x-forwarded-for': '   203.0.113.3   , 10.0.0.1' })
		// 10.0.0.1 trusted → skip → 203.0.113.3 returned.
		expect(extractClientIp(h)).toBe('203.0.113.3')
	})

	test('[I5] empty XFF → fallback to X-Real-IP', () => {
		const h = new Headers({ 'x-forwarded-for': '', 'x-real-ip': '203.0.113.4' })
		expect(extractClientIp(h)).toBe('203.0.113.4')
	})

	test('[I6] noop mock not called', () => {
		const m = mock(() => undefined)
		expect(m.mock.calls.length).toBe(0)
	})
})
