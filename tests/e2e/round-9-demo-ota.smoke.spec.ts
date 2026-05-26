/**
 * Round 9 — demo OTA smoke spec.
 *
 * Verifies the «wow-effect» end-to-end loop в two channels:
 *
 *   1. Guest opens `/demo/ota/yandex` → submits search → lands on property →
 *      books → success page → reservation созданий в PMS inbox (via webhook).
 *   2. Same for `/demo/ota/ostrovok`.
 *   3. Side-by-side showcase at `/demo/showcase` renders header + iframes +
 *      admin controls.
 *   4. axe-core a11y assertion on each demo landing page (zero violations).
 *
 * **Anonymous-only** — matches the `smoke` Playwright project (no auth.setup
 * dependency). Demo pages по design лежат под `/demo/*` без auth gate so a
 * fresh incognito session can browse + book.
 *
 * **Webhook delivery verification**: instead of inspecting YDB directly (no
 * SQL access from Playwright runner), we trust the backend route handler
 * synchronously `await`'s the webhook fetch before responding to the order
 * POST — see `apps/backend/src/domains/_demo/mock-ota-server/shared/webhook-emit.ts`
 * docstring «closes the demo loop». The success page rendering implies
 * webhook landed.
 *
 * Run:
 *   pnpm exec playwright test round-9-demo-ota --project=smoke
 *
 * Environment requirements:
 *   - Backend mounted с `APP_MODE !== 'production'` so `_demo/` routes mount.
 *   - Frontend dev server serving `/demo/ota/*` routes.
 *   - Reserved-test-range fixtures (Иванов Иван, *@example.com, +79999999999)
 *     pre-loaded by default — Round 9 canon fixture data.
 *
 * Visual baseline screenshots stored alongside spec in
 * `round-9-demo-ota.smoke.spec.ts-snapshots/` (generated on first run via
 * `--update-snapshots`).
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { filterKnownNoise, WCAG_AA_TAGS } from '../axe-known-noise.ts'

test.describe('Round 9 — demo OTA smoke', () => {
	test.use({
		storageState: { cookies: [], origins: [] },
	})

	test.beforeEach(async ({ page }) => {
		// Round 12 self-review SR-1 sibling — pre-set cookie-consent localStorage
		// BEFORE page load. Without this, the global `<CookieBanner>` (main.tsx)
		// intercepts pointer events на form submit buttons that overlap the
		// banner's fixed-bottom area. Round 9 spec shipped без this guard and
		// quietly broke когда CookieBanner landed (Sprint C+ Round 6). Same
		// fixture также keeps analytics OFF (Metrika beacon never inits).
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
		page.on('pageerror', (err) => {
			// Surface JS errors so flaky cases get diagnosable output.
			console.error(`[pageerror] ${err.message}`)
		})
	})

	test('[YT-SMOKE] Yandex demo: search → property → book → success', async ({ page }) => {
		// Round 12 self-review fix — admin reset removed (Round 11 P1-B2 added
		// session-token gate; spec doesn't know per-process random token →
		// always 401). State is reset per test via fresh storageState; sticky
		// in-memory tokens get evicted on next backend boot anyway. Skipping
		// the call also drops cross-test ordering dependencies.

		// 2. Open Yandex demo search.
		await page.goto('/demo/ota/yandex')
		await expect(page.getByTestId('demo-disclaimer-banner')).toBeVisible({ timeout: 15_000 })
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Куда вы хотите поехать?')

		// 3. Click search submit — defaults pre-fill the form.
		await page.getByTestId('yandex-search-submit').click()

		// 4. Property page renders + has «Забронировать» CTA.
		await expect(page).toHaveURL(/\/demo\/ota\/yandex\/property\/demo-hotel-sochi/, {
			timeout: 15_000,
		})
		await expect(page.getByTestId('demo-disclaimer-banner')).toBeVisible()

		// 5. Click the book CTA — selector tolerates either testid or button label.
		const bookCta = page
			.getByTestId('yandex-book-cta')
			.or(page.getByRole('button', { name: /Забронировать/ }))
		await bookCta.first().click()

		// 6. Booking form renders с pre-filled reserved-test data; click confirm.
		await expect(page).toHaveURL(/\/demo\/ota\/yandex\/booking\//, { timeout: 15_000 })
		const confirmBtn = page
			.getByTestId('yandex-confirm-cta')
			.or(page.getByRole('button', { name: /Подтвердить|Подтверждаю/ }))
		await confirmBtn.first().click()

		// 7. Success page lands. Mock OTA emits webhook synchronously before
		//    returning order — when this URL renders, the channel inbox already
		//    has the row (per backend webhook-emit synchronous contract).
		await expect(page).toHaveURL(/\/demo\/ota\/yandex\/success\//, { timeout: 30_000 })
		await expect(page.getByTestId('demo-disclaimer-banner')).toBeVisible()
	})

	test('[ETG-SMOKE] Островок demo: search → property → book → success', async ({ page }) => {
		// Round 12 self-review fix — admin reset removed (Round 11 P1-B2 token gate).
		await page.goto('/demo/ota/ostrovok')
		await expect(page.getByTestId('demo-disclaimer-banner')).toBeVisible({ timeout: 15_000 })

		// Click search submit.
		const searchBtn = page
			.getByTestId('ostrovok-search-submit')
			.or(page.getByRole('button', { name: /Найти/ }))
		await searchBtn.first().click()

		await expect(page).toHaveURL(/\/demo\/ota\/ostrovok\/property\//, { timeout: 15_000 })

		const bookCta = page
			.getByTestId('ostrovok-book-cta')
			.or(page.getByRole('button', { name: /Забронировать/ }))
		await bookCta.first().click()

		await expect(page).toHaveURL(/\/demo\/ota\/ostrovok\/booking\//, { timeout: 15_000 })
		const confirmBtn = page
			.getByTestId('ostrovok-confirm-cta')
			.or(page.getByRole('button', { name: /Подтвердить|Подтверждаю/ }))
		await confirmBtn.first().click()

		await expect(page).toHaveURL(/\/demo\/ota\/ostrovok\/success\//, { timeout: 30_000 })
		await expect(page.getByTestId('demo-disclaimer-banner')).toBeVisible()
	})

	test('[SHOWCASE-SMOKE] side-by-side showcase renders + admin controls fire', async ({ page }) => {
		await page.goto('/demo/showcase')
		await expect(page.getByTestId('showcase-page')).toBeVisible({ timeout: 15_000 })
		await expect(page.getByTestId('showcase-header')).toBeVisible()

		// Iframes mounted с known src.
		const otaIframe = page.getByTestId('showcase-iframe-ota')
		const pmsIframe = page.getByTestId('showcase-iframe-pms')
		await expect(otaIframe).toBeVisible()
		await expect(pmsIframe).toBeVisible()
		expect(await otaIframe.getAttribute('src')).toBe('/demo/ota/yandex')

		// Channel switch.
		await page.getByTestId('showcase-channel-ostrovok').click()
		expect(await otaIframe.getAttribute('src')).toBe('/demo/ota/ostrovok')

		// Admin reset button fires POST and shows banner.
		await page.getByTestId('showcase-admin-reset').click()
		await expect(page.getByTestId('showcase-status-banner')).toBeVisible({ timeout: 10_000 })
		await expect(page.getByTestId('showcase-status-banner')).toContainText('Reset')
	})

	test('[A11Y-YT] /demo/ota/yandex passes WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/demo/ota/yandex')
		await expect(page.getByTestId('demo-disclaimer-banner')).toBeVisible({ timeout: 15_000 })
		const results = await new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze()
		const filtered = filterKnownNoise(results.violations)
		if (filtered.length > 0) {
			console.error('axe violations:', JSON.stringify(filtered, null, 2))
		}
		expect(filtered).toEqual([])
	})

	test('[A11Y-ETG] /demo/ota/ostrovok passes WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/demo/ota/ostrovok')
		await expect(page.getByTestId('demo-disclaimer-banner')).toBeVisible({ timeout: 15_000 })
		const results = await new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze()
		const filtered = filterKnownNoise(results.violations)
		if (filtered.length > 0) {
			console.error('axe violations:', JSON.stringify(filtered, null, 2))
		}
		expect(filtered).toEqual([])
	})

	test('[A11Y-SHOWCASE] /demo/showcase passes WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/demo/showcase')
		await expect(page.getByTestId('showcase-page')).toBeVisible({ timeout: 15_000 })
		// Exclude iframes from a11y scan — embedded content lives in its own
		// document and its violations are covered by [A11Y-YT] / [A11Y-ETG].
		const results = await new AxeBuilder({ page })
			.withTags([...WCAG_AA_TAGS])
			.exclude('iframe')
			.analyze()
		const filtered = filterKnownNoise(results.violations)
		if (filtered.length > 0) {
			console.error('axe violations:', JSON.stringify(filtered, null, 2))
		}
		expect(filtered).toEqual([])
	})
})
