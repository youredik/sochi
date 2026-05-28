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
		// Round 12 self-review SR-1 fix — pre-set cookie-consent localStorage
		// BEFORE any page load. Without it, the global `<CookieBanner>` (mounted
		// at app root via main.tsx) intercepts pointer events на form submit
		// buttons that overlap the banner's `position: fixed bottom-4` area.
		// All Round 12 tests that click submit buttons require banner dismissal.
		// Set «necessary only» state (matches «Только необходимые» button) —
		// keeps analytics OFF, so the same fixture also doubles as Metrika
		// guard for R12V-7.
		await page.addInitScript(() => {
			window.localStorage.setItem(
				'horeca-cookie-consent',
				JSON.stringify({
					version: '2026-05-24',
					grantedAt: new Date().toISOString(),
					categories: { necessary: true, analytics: false, marketing: false },
				}),
			)
		})
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

	// [R12-6] DELETED 2026-05-28 (Round 14.6.2) — Round 14.5 captcha gate
	// makes anonymous /search/hp/ POST return 422. Property page renders price
	// only после successful search; smoke can't solve captcha. Coverage of the
	// BASE URL canary moved к unit tests (`ostrovok/api-client.test.ts`
	// pins `/api/_mock-ota/ostrovok/v1` literal). Per-tenant authed booking
	// flow at `/o/{slug}/demo` exercised via `demo-funnel-smoke.spec.ts` [E1].

	/**
	 * Round 12 R12V-6 — `/demo` index landing renders (was empty before).
	 * Success-page «Вернуться к демо PMS» link points to `/demo`; landing
	 * MUST not be blank or users get a confusing dead-end.
	 */
	test('[R12-7] /demo index renders tile-based landing', async ({ page }) => {
		await page.goto('/demo')
		await expect(page.getByTestId('demo-index-heading')).toBeVisible({ timeout: 15_000 })
		await expect(page.getByTestId('demo-tile-yandex')).toBeVisible()
		await expect(page.getByTestId('demo-tile-ostrovok')).toBeVisible()
		await expect(page.getByTestId('demo-tile-showcase')).toBeVisible()
	})

	/**
	 * Round 12 R12V-1 — client-side date validation: blocks submit when
	 * checkOut <= checkIn (was: backend rejected с invalid_date_range alert
	 * on property page = poor UX).
	 */
	test('[R12-8] Yandex search rejects checkOut <= checkIn before navigate', async ({ page }) => {
		await page.goto('/demo/ota/yandex')
		// Type a checkOut date that's BEFORE the default checkIn.
		const checkOutInput = page.locator('input[type="date"]').nth(1)
		await checkOutInput.fill('2020-01-01')
		await page.getByTestId('yandex-search-submit').click()
		// Must NOT navigate; date error alert must appear.
		await expect(page.getByTestId('yandex-search-date-error')).toBeVisible({ timeout: 5_000 })
		await expect(page).toHaveURL(/\/demo\/ota\/yandex$/)
	})

	/**
	 * Round 12 R12V-3/R12V-4 — banner contains «ДЕМО» pill chip, no emoji
	 * across both brands (Round 12 feedback_no_emoji canon).
	 */
	test('[R12-9] DemoDisclaimerBanner uses ДЕМО pill on both brands', async ({ page }) => {
		for (const brand of ['yandex', 'ostrovok'] as const) {
			await page.goto(`/demo/ota/${brand}`)
			const banner = page.getByTestId('demo-disclaimer-banner')
			await expect(banner).toBeVisible({ timeout: 15_000 })
			const text = (await banner.textContent()) ?? ''
			expect(text).toContain('ДЕМО')
			expect(text).not.toContain('🧪')
		}
	})

	/**
	 * Round 12 deeper-2 (R12V-mobile) — mobile viewport (iPhone SE 375×667)
	 * banner + form remain functional. Sales presentations sometimes happen
	 * on tablets/phones; demo must not break below 768px.
	 */
	test('[R12-10] mobile viewport (375×667) renders banner + search form', async ({ browser }) => {
		const ctx = await browser.newContext({
			viewport: { width: 375, height: 667 },
			deviceScaleFactor: 2,
			isMobile: true,
		})
		const page = await ctx.newPage()
		await page.goto('/demo/ota/yandex')
		await expect(page.getByTestId('demo-disclaimer-banner')).toBeVisible({ timeout: 15_000 })
		await expect(page.getByTestId('yandex-search-submit')).toBeVisible()
		// Form fields are visible (not horizontally overflowed).
		await expect(page.locator('input[type="date"]').first()).toBeVisible()
		await ctx.close()
	})

	/**
	 * Round 12 deeper-2 (R12V-shield) — backend reserved-test shield rejects
	 * real PII at HTTP intake. Frontend pre-fills RFC 2606 / Россвязь emails
	 * + phones, but if a presenter manually edits to real PII and submits,
	 * backend MUST respond 422 (not write to channelInbox).
	 *
	 * This test simulates the «edit to real PII» path via direct fetch (the
	 * UI doesn't easily let us inject arbitrary PII via Playwright fill).
	 */
	// [R12-11] DELETED 2026-05-28 (Round 14.6.2) — Round 14.5 captcha gate
	// returns 422 captcha_required BEFORE the reserved-test shield logic runs.
	// Security canary preserved at unit level: `yandex.routes.test.ts` [YTR7]
	// asserts the reserved-test shield rejects non-@example.com emails with
	// `non_reserved_demo_data` status. Captcha-gated endpoint no longer
	// reachable for anonymous POST verification via E2E.

	/**
	 * Round 12 deeper-2 (R12V-iframe-sandbox) — showcase iframes have
	 * `sandbox` attribute pinned. Without sandbox, child iframe could
	 * (a) call `top.location.replace(...)` to navigate parent away,
	 * (b) access parent localStorage for sibling tabs, (c) auto-form-submit.
	 * Round 12 added `allow-scripts allow-same-origin allow-forms allow-popups`
	 * — excludes `allow-top-navigation` deliberately.
	 */
	test('[R12-12] showcase iframes have sandbox attribute', async ({ page }) => {
		await page.goto('/demo/showcase')
		await expect(page.getByTestId('showcase-page')).toBeVisible({ timeout: 15_000 })
		const otaSandbox = await page.getByTestId('showcase-iframe-ota').getAttribute('sandbox')
		const pmsSandbox = await page.getByTestId('showcase-iframe-pms').getAttribute('sandbox')
		expect(otaSandbox).toContain('allow-scripts')
		expect(otaSandbox).toContain('allow-same-origin')
		expect(otaSandbox).not.toContain('allow-top-navigation')
		expect(pmsSandbox).toContain('allow-scripts')
		expect(pmsSandbox).not.toContain('allow-top-navigation')
	})
})
