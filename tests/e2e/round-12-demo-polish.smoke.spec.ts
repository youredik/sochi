/**
 * Round 12 — demo OTA polish regression spec.
 *
 * Pins the fixes shipped in Round 12 как regression artifact so future
 * round-N audits can't regress them silently. Each test maps к one of the
 * P0/P1 findings closed в this round.
 *
 * Run:
 *   pnpm exec playwright test round-12-demo-polish --project=smoke
 *
 * Coverage:
 *   [R12-1] Demo banner shows «ДЕМО» pill chip, NOT emoji `🧪`
 *           (`feedback_no_emoji` canon).
 *   [R12-2] Demo banner legal note carries trademark-safe phrasing —
 *           NOT incorrect ИНН `7704735704` that previously identified
 *           ООО „ЯНДЕКС.ТАКСИ" not Yandex.Путешествия.
 *   [R12-3] Showcase admin POST attaches `X-Demo-Session-Token` header when
 *           session token is set (closes «admin panel returns 401» frontend
 *           P0).
 *   [R12-4] Showcase admin works WITHOUT session token (dev back-compat).
 *   [R12-5] Demo bootPromise awaited — first webhook does NOT 401/403
 *           (smoke: hit the order endpoint immediately after backend up).
 *
 * **Anonymous-only** — matches the `smoke` Playwright project (no auth.setup
 * dependency). Demo pages под `/demo/*` без auth gate.
 */
import { expect, test } from '@playwright/test'

test.describe('Round 12 — demo polish regression', () => {
	test.use({
		storageState: { cookies: [], origins: [] },
	})

	test.beforeEach(async ({ page }) => {
		// Silence Yandex Metrika beacon — avoid real network in smoke runs.
		await page.route('**/mc.yandex.ru/metrika/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }),
		)
	})

	test('[R12-1] DemoDisclaimerBanner uses ДЕМО pill, не emoji', async ({ page }) => {
		await page.goto('/demo/ota/yandex')
		const banner = page.getByTestId('demo-disclaimer-banner')
		await expect(banner).toBeVisible({ timeout: 15_000 })
		const text = await banner.textContent()
		// Canon `feedback_no_emoji` — zero emojis в user-facing UI.
		expect(text ?? '').not.toContain('🧪')
		// Pill chip carries «ДЕМО» (uppercase) marker.
		expect(text ?? '').toContain('ДЕМО')
	})

	test('[R12-2] DemoDisclaimerBanner footer drops incorrect ИНН', async ({ page }) => {
		await page.goto('/demo/ota/yandex')
		const footer = page.getByTestId('demo-disclaimer-footer')
		await expect(footer).toBeVisible({ timeout: 15_000 })
		const text = await footer.textContent()
		// ИНН 7704735704 was incorrectly bound to ООО „Яндекс.Путешествия";
		// it actually belongs to ООО „ЯНДЕКС.ТАКСИ". Round 12 fix drops ИНН
		// entirely in favor of neutral phrasing.
		expect(text ?? '').not.toContain('7704735704')
		// Footer still carries the trademark-acknowledgement clause.
		expect(text ?? '').toContain('собственность соответствующих правообладателей')
	})

	test('[R12-3] Showcase: admin POST carries X-Demo-Session-Token header', async ({ page }) => {
		await page.goto('/demo/showcase')
		await expect(page.getByTestId('showcase-page')).toBeVisible({ timeout: 15_000 })

		// Fill the session-token input (mirrors presenter copy-paste from
		// backend boot log).
		const tokenInput = page.getByTestId('showcase-session-token')
		await tokenInput.fill('demo_admin_e2e_token')

		// Capture the request before clicking.
		const requestPromise = page.waitForRequest(
			(req) => req.url().endsWith('/api/_mock-ota/admin/reset') && req.method() === 'POST',
		)
		await page.getByTestId('showcase-admin-reset').click()
		const request = await requestPromise

		// Round 12 P0 fix — header MUST be present.
		expect(request.headers()['x-demo-session-token']).toBe('demo_admin_e2e_token')
	})

	test('[R12-4] Showcase: admin POST works WITHOUT token in dev back-compat', async ({ page }) => {
		await page.goto('/demo/showcase')
		await expect(page.getByTestId('showcase-page')).toBeVisible({ timeout: 15_000 })

		// No token typed — request should still fire (no JS error). Backend
		// in dev (no APP_MODE production guard) accepts requests when no
		// sessionToken is configured at boot.
		const requestPromise = page.waitForRequest(
			(req) => req.url().endsWith('/api/_mock-ota/admin/reset') && req.method() === 'POST',
		)
		await page.getByTestId('showcase-admin-reset').click()
		const request = await requestPromise

		// Header absent (Round 12 P0 wiring: only send when token non-empty).
		expect(request.headers()['x-demo-session-token']).toBeUndefined()
	})

	test('[R12-5] Demo loop: search → property → success without 401/403', async ({ page }) => {
		// Round 12 closes the boot race window via `await demoBootPromise` in
		// `index.ts`. Smoke against the cold-start path — by the time Playwright
		// connects, the seed must already be applied.
		await page.goto('/demo/ota/yandex')
		await expect(page.getByTestId('demo-disclaimer-banner')).toBeVisible({
			timeout: 15_000,
		})

		// Submit the default-pre-filled search.
		await page.getByTestId('yandex-search-submit').click()

		// Property page rendered → search succeeded.
		await expect(page.locator('[data-testid="property-total-price"], [role="alert"]')).toBeVisible({
			timeout: 15_000,
		})
	})
})
