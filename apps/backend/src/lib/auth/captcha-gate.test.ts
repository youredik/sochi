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
	/*  ─── nodeEnv short-circuit — localhost / CI / test always bypass ──── */

	test('[N1] nodeEnv=development → non-production (bypass)', async () => {
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: {} },
			{ nodeEnv: 'development', serverKey: 'ysc2_real_key' },
		)
		expect(res).toEqual({ pass: true, reason: 'non-production' })
	})

	test('[N2] nodeEnv=test → non-production (bypass)', async () => {
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: {} },
			{ nodeEnv: 'test', serverKey: 'ysc2_real_key' },
		)
		expect(res).toEqual({ pass: true, reason: 'non-production' })
	})

	test('[N3] nodeEnv=development wins over demoDeployment + serverKey', async () => {
		// Hard rule per `[[no_half_measures]]`: localhost never pays captcha
		// friction, even if engineer accidentally configures BOTH a real
		// server key AND demo flag in their local .env.
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'ignored' } },
			{ nodeEnv: 'development', serverKey: 'ysc2_real_key', demoDeployment: true },
		)
		expect(res).toEqual({ pass: true, reason: 'non-production' })
	})

	test('[N4] nodeEnv omitted defaults to production (strict path)', async () => {
		// Safety canon: missing nodeEnv must NOT silently bypass. Default
		// to strict so an integrator who forgets to wire env hits the
		// captcha rather than skipping it.
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: '' } },
			{ serverKey: 'ysc2_real_key' },
		)
		expect(res).toEqual({ pass: false, reason: 'missing_token' })
	})

	test('[N5] nodeEnv=production + no serverKey → disabled (existing safety net)', async () => {
		// Distinct from N1: in production, missing serverKey still passes as
		// 'disabled' (config-drift safety net). The hard prod guard lives
		// at startup in index.ts (assertProductionCaptchaConfigured),
		// not here.
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'x' } },
			{ nodeEnv: 'production' },
		)
		expect(res).toEqual({ pass: true, reason: 'disabled' })
	})

	test('[A1] serverKey unset → disabled', async () => {
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: 'x' } },
			{},
		)
		expect(res).toEqual({ pass: true, reason: 'disabled' })
	})

	test('[D1] demoDeployment=true bypasses gate EVEN when serverKey set', async () => {
		// Per `[[demo_strategy]]`: publicly-hosted demo runs friction-free.
		// demoDeployment short-circuits BEFORE serverKey check — captcha-less
		// signup is the explicit canon for prospect acquisition.
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: '' } },
			{ serverKey: 'ysc2_x', demoDeployment: true },
		)
		expect(res).toEqual({ pass: true, reason: 'demo-deployment' })
	})

	test('[D2] demoDeployment=true bypasses gate EVEN for missing-token path', async () => {
		// Same canon: demo prospect never sees a captcha widget, so the form
		// won't supply a token. Gate must accept the empty-body case.
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: {} },
			{ serverKey: 'ysc2_x', demoDeployment: true },
		)
		expect(res).toEqual({ pass: true, reason: 'demo-deployment' })
	})

	test('[D3] demoDeployment=false (explicit) preserves serverKey gate semantics', async () => {
		const res = await evaluateCaptchaGate(
			{ path: '/sign-in/magic-link', body: { captchaToken: '' } },
			{ serverKey: 'ysc2_x', demoDeployment: false },
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
})

describe('extractClientIp', () => {
	test('[I1] leftmost X-Forwarded-For wins over X-Real-IP', () => {
		const h = new Headers({
			'x-forwarded-for': '203.0.113.1, 192.0.2.50, 10.0.0.1',
			'x-real-ip': '10.0.0.99',
		})
		expect(extractClientIp(h)).toBe('203.0.113.1')
	})

	test('[I2] X-Real-IP fallback when XFF absent', () => {
		const h = new Headers({ 'x-real-ip': '203.0.113.2' })
		expect(extractClientIp(h)).toBe('203.0.113.2')
	})

	test('[I3] both absent → undefined', () => {
		const h = new Headers()
		expect(extractClientIp(h)).toBeUndefined()
	})

	test('[I4] XFF whitespace trimmed per segment', () => {
		const h = new Headers({ 'x-forwarded-for': '   203.0.113.3   , 10.0.0.1' })
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
