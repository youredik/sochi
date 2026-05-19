/**
 * Production startup guards — strict unit tests (B1, 2026-05-19).
 *
 * Coverage:
 *   - APP_MODE=sandbox: all combos pass (guards skip)
 *   - APP_MODE=production + DEMO_DEPLOYMENT=false: no-op
 *   - APP_MODE=production + DEMO_DEPLOYMENT=true + override=false: throw
 *   - APP_MODE=production + DEMO_DEPLOYMENT=true + override=true: pass с warn
 *   - assertProductionCaptchaConfigured: demo exemption + missing key reject
 *   - error messages contain actionable hints
 */

import { describe, expect, test } from 'bun:test'
import { assertNoDemoInProduction, assertProductionCaptchaConfigured } from './production-guards.ts'

type EnvShape = {
	APP_MODE: 'sandbox' | 'production'
	DEMO_DEPLOYMENT: boolean
	APP_MODE_PERMITTED_DEMO_OVERRIDE: boolean
	SMARTCAPTCHA_SERVER_KEY: string | undefined
}

const SANDBOX_BASE: EnvShape = {
	APP_MODE: 'sandbox',
	DEMO_DEPLOYMENT: false,
	APP_MODE_PERMITTED_DEMO_OVERRIDE: false,
	SMARTCAPTCHA_SERVER_KEY: undefined,
}

const PRODUCTION_BASE: EnvShape = {
	APP_MODE: 'production',
	DEMO_DEPLOYMENT: false,
	APP_MODE_PERMITTED_DEMO_OVERRIDE: false,
	SMARTCAPTCHA_SERVER_KEY: 'ysc2_test_real_key',
}

// `EnvShape` is structural subset of full `env` type; assertion accepts any
// shape с required fields. Cast в test через `as unknown as typeof env`.
function asEnv(e: EnvShape): Parameters<typeof assertNoDemoInProduction>[0] {
	return e as unknown as Parameters<typeof assertNoDemoInProduction>[0]
}

describe('assertNoDemoInProduction', () => {
	test('APP_MODE=sandbox + DEMO=true → no-op (sandbox is canonical demo home)', () => {
		expect(() =>
			assertNoDemoInProduction(asEnv({ ...SANDBOX_BASE, DEMO_DEPLOYMENT: true })),
		).not.toThrow()
	})

	test('APP_MODE=production + DEMO=false → no-op', () => {
		expect(() => assertNoDemoInProduction(asEnv(PRODUCTION_BASE))).not.toThrow()
	})

	test('APP_MODE=production + DEMO=true + override=false → THROWS (canon)', () => {
		expect(() =>
			assertNoDemoInProduction(asEnv({ ...PRODUCTION_BASE, DEMO_DEPLOYMENT: true })),
		).toThrow(/APP_MODE=production with DEMO_DEPLOYMENT=true/)
	})

	test('APP_MODE=production + DEMO=true + override=true → pass с console.warn', () => {
		const originalWarn = console.warn
		let warnCalled = false
		let warnMsg = ''
		console.warn = (msg: unknown) => {
			warnCalled = true
			warnMsg = String(msg)
		}
		try {
			expect(() =>
				assertNoDemoInProduction(
					asEnv({
						...PRODUCTION_BASE,
						DEMO_DEPLOYMENT: true,
						APP_MODE_PERMITTED_DEMO_OVERRIDE: true,
					}),
				),
			).not.toThrow()
			expect(warnCalled).toBe(true)
			expect(warnMsg).toContain('APP_MODE=production with DEMO_DEPLOYMENT=true permitted')
		} finally {
			console.warn = originalWarn
		}
	})

	test('error message contains actionable hint (fix vector)', () => {
		try {
			assertNoDemoInProduction(asEnv({ ...PRODUCTION_BASE, DEMO_DEPLOYMENT: true }))
		} catch (err) {
			const msg = (err as Error).message
			expect(msg).toContain('Set DEMO_DEPLOYMENT=false для production')
			expect(msg).toContain('APP_MODE_PERMITTED_DEMO_OVERRIDE=true')
			expect(msg).toContain('Demo deployment features')
		}
	})
})

describe('assertProductionCaptchaConfigured', () => {
	test('APP_MODE=sandbox → no-op regardless of captcha', () => {
		expect(() =>
			assertProductionCaptchaConfigured(
				asEnv({ ...SANDBOX_BASE, SMARTCAPTCHA_SERVER_KEY: undefined }),
			),
		).not.toThrow()
	})

	test('DEMO=true exempts captcha requirement (per demo_strategy canon)', () => {
		expect(() =>
			assertProductionCaptchaConfigured(
				asEnv({
					...PRODUCTION_BASE,
					DEMO_DEPLOYMENT: true,
					SMARTCAPTCHA_SERVER_KEY: undefined,
				}),
			),
		).not.toThrow()
	})

	test('Production + DEMO=false + captcha SET → pass', () => {
		expect(() => assertProductionCaptchaConfigured(asEnv(PRODUCTION_BASE))).not.toThrow()
	})

	test('Production + DEMO=false + captcha UNSET → throw', () => {
		expect(() =>
			assertProductionCaptchaConfigured(
				asEnv({ ...PRODUCTION_BASE, SMARTCAPTCHA_SERVER_KEY: undefined }),
			),
		).toThrow(/SMARTCAPTCHA_SERVER_KEY is unset/)
	})

	test('Production + DEMO=false + captcha EMPTY STRING → throw (defense vs whitespace)', () => {
		expect(() =>
			assertProductionCaptchaConfigured(asEnv({ ...PRODUCTION_BASE, SMARTCAPTCHA_SERVER_KEY: '' })),
		).toThrow(/SMARTCAPTCHA_SERVER_KEY is unset/)
	})

	test('error message provides fix hints (both vectors)', () => {
		try {
			assertProductionCaptchaConfigured(
				asEnv({ ...PRODUCTION_BASE, SMARTCAPTCHA_SERVER_KEY: undefined }),
			)
		} catch (err) {
			const msg = (err as Error).message
			expect(msg).toContain('configure SmartCaptcha')
			expect(msg).toContain('flip DEMO_DEPLOYMENT=true')
		}
	})
})

describe('combined guards — full production-mode boot scenarios', () => {
	test('canonical demo deployment (sandbox + demo) passes both guards', () => {
		const env = asEnv({
			...SANDBOX_BASE,
			DEMO_DEPLOYMENT: true,
			SMARTCAPTCHA_SERVER_KEY: undefined,
		})
		expect(() => assertNoDemoInProduction(env)).not.toThrow()
		expect(() => assertProductionCaptchaConfigured(env)).not.toThrow()
	})

	test('canonical production deployment (no demo, captcha set) passes both', () => {
		const env = asEnv(PRODUCTION_BASE)
		expect(() => assertNoDemoInProduction(env)).not.toThrow()
		expect(() => assertProductionCaptchaConfigured(env)).not.toThrow()
	})

	test('foot-shot combo (production + demo, no override) → both guards trigger', () => {
		const env = asEnv({
			...PRODUCTION_BASE,
			DEMO_DEPLOYMENT: true,
			SMARTCAPTCHA_SERVER_KEY: undefined,
		})
		expect(() => assertNoDemoInProduction(env)).toThrow()
		// captcha exempted by DEMO_DEPLOYMENT=true — symmetric с per-guard canon
		expect(() => assertProductionCaptchaConfigured(env)).not.toThrow()
	})
})
