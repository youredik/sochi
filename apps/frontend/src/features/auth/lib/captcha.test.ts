/**
 * `captchaEnforced` env-gating — strict tests.
 *
 * Pre-done audit:
 *   [R1] both env unset → captchaEnforced = false (dev / CI default)
 *   [R2] site key set, demo-deployment unset → captchaEnforced = true (prod canon)
 *   [R3] site key set, demo-deployment='true' → captchaEnforced = false (demo skip)
 *   [R4] site key unset, demo-deployment='true' → captchaEnforced = false (demo+no-key)
 *   [R5] site key set, demo-deployment='false' literal string → captchaEnforced = true
 *        (string-match canon: only literal `'true'` counts as demo)
 *   [R6] site key empty string (CI misconfig) → captchaEnforced = false
 *   [R7] demo-deployment with arbitrary non-'true' value → ignored (production
 *        behaviour preserved)
 *
 * Why fresh-import-per-test: `captcha.ts` reads `import.meta.env` ONCE at
 * module init и exports a const. To exercise different env permutations the
 * module cache must be cleared между cases — bun's `mock.module` re-runs the
 * factory on every `await import` after a module mock declaration.
 */
import { afterEach, describe, expect, it } from 'bun:test'

const ORIGINAL_SITE_KEY = import.meta.env.VITE_YANDEX_CAPTCHA_SITE_KEY
const ORIGINAL_DEMO = (import.meta.env as Record<string, unknown>).VITE_DEMO_DEPLOYMENT

function setEnv(siteKey: string | undefined, demoDeployment: string | undefined): void {
	;(import.meta.env as Record<string, unknown>).VITE_YANDEX_CAPTCHA_SITE_KEY = siteKey
	;(import.meta.env as Record<string, unknown>).VITE_DEMO_DEPLOYMENT = demoDeployment
}

async function loadCaptchaEnforced(): Promise<boolean> {
	// Bun's `import` re-runs the module statics на каждом call when the
	// underlying file hasn't changed — но static const evaluation is cached
	// при first import. To force re-evaluation we add a cache-busting query
	// suffix; bun's loader treats different specifiers as distinct modules.
	const mod = (await import(`./captcha.ts?v=${Math.random()}`)) as { captchaEnforced: boolean }
	return mod.captchaEnforced
}

afterEach(() => {
	setEnv(
		typeof ORIGINAL_SITE_KEY === 'string' ? ORIGINAL_SITE_KEY : undefined,
		typeof ORIGINAL_DEMO === 'string' ? ORIGINAL_DEMO : undefined,
	)
})

describe('captchaEnforced — env-gating canon', () => {
	it('[R1] both env unset → false (dev/CI default)', async () => {
		setEnv(undefined, undefined)
		expect(await loadCaptchaEnforced()).toBe(false)
	})

	it('[R2] site key set, demo-deployment unset → true (production canon)', async () => {
		setEnv('ymsk_test_site_key_42', undefined)
		expect(await loadCaptchaEnforced()).toBe(true)
	})

	it('[R3] site key set, demo-deployment=true → TRUE (2026-05-22 decouple — captcha enforced даже в demo)', async () => {
		// Раньше: bypass'или captcha в demo (canon «no friction для prospects»).
		// 2026-05-22: канон обновлён — captcha enforced если key set, иначе боты
		// flood'ят DemoInbox. Только VITE_YANDEX_CAPTCHA_SITE_KEY presence
		// determine enforcement.
		setEnv('ymsk_test_site_key_42', 'true')
		expect(await loadCaptchaEnforced()).toBe(true)
	})

	it('[R4] site key unset, demo-deployment=true → false (demo + no key)', async () => {
		setEnv(undefined, 'true')
		expect(await loadCaptchaEnforced()).toBe(false)
	})

	it('[R5] site key set, demo-deployment=false literal → true (string-match canon)', async () => {
		setEnv('ymsk_test_site_key_42', 'false')
		expect(await loadCaptchaEnforced()).toBe(true)
	})

	it('[R6] site key empty string (CI misconfig) → false', async () => {
		setEnv('', undefined)
		expect(await loadCaptchaEnforced()).toBe(false)
	})

	it('[R7] demo-deployment с arbitrary non-true value → ignored, prod gate intact', async () => {
		setEnv('ymsk_test_site_key_42', '1')
		expect(await loadCaptchaEnforced()).toBe(true)
		setEnv('ymsk_test_site_key_42', 'yes')
		expect(await loadCaptchaEnforced()).toBe(true)
		setEnv('ymsk_test_site_key_42', 'TRUE') // case-sensitive match per canon
		expect(await loadCaptchaEnforced()).toBe(true)
	})
})
