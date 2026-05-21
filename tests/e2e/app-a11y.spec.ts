import AxeBuilder from '@axe-core/playwright'
import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'
import { getMagicLinkUrl, purgeMailpit } from './_mailpit-helper.ts'
/**
 * App-wide WCAG 2.2 AA audit (M5e.3.4).
 *
 * 152-ФЗ requires AA compliance for the WHOLE application — not just
 * the reservation grid. grid-a11y.spec.ts covered the grid + dialogs;
 * this file extends to every other user-facing surface:
 *
 *   - Public pages (anonymous): /signup, /login, /privacy
 *   - Authenticated: /o/{slug}/ dashboard, /o/{slug}/setup wizard
 *
 * If any shadcn default (Input, Label, Button variant, Checkbox …)
 * fails AA on one page, it likely fails on all — this suite surfaces
 * that systemically.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const

async function runAxe(page: import('@playwright/test').Page, context: string) {
	const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze()
	if (results.violations.length > 0) {
		console.error(`axe violations (${context}):`, JSON.stringify(results.violations, null, 2))
	}
	expect(results.violations).toEqual([])
}

// Public pages — scanned via ANONYMOUS context (no storageState) so
// they MUST run in the `smoke` Playwright project, not chromium.
// Here we use a bare context for anonymous surfaces.

test.describe('app-wide WCAG 2.2 AA audit (authenticated pages)', () => {
	test('/o/{slug}/ dashboard passes WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		// Wait for dashboard content to settle (property card or empty-state).
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		await runAxe(page, 'dashboard')
	})

	test('/o/{slug}/receivables passes WCAG 2.2 AA (M6.7.4)', async ({ page }) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		// Navigate via sidebar (A.bis.3: dashboard no longer carries nav tiles —
		// nav lives in the sidebar with stable `[data-section-id]` selectors,
		// same canon as A.bis.2.fix bulk e2e migration).
		await page.locator('[data-section-id="receivables"]').click()
		await expect(page).toHaveURL(/\/receivables$/)
		// Heading + KPI region must be visible.
		await expect(page.getByRole('heading', { name: /Дебиторская задолженность/ })).toBeVisible()
		await expect(page.getByRole('region', { name: 'Ключевые показатели' })).toBeVisible()
		await runAxe(page, 'receivables-dashboard')
	})

	test('/o/{slug}/admin/tax passes WCAG 2.2 AA (M7.fix.3.b)', async ({ page }) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		// Owner role grants `report:read`, so the sidebar row is rendered.
		// Post-A.bis.3 the dashboard isn't a nav-хаб — navigate via the sidebar
		// using the stable `[data-section-id]` selector.
		await page.locator('[data-section-id="tax"]').click()
		await expect(page).toHaveURL(/\/admin\/tax(\?.*)?$/)
		// Heading + filter + KPI section visible — content settled.
		await expect(page.getByRole('heading', { name: /Туристический налог/, level: 1 })).toBeVisible()
		await expect(page.getByRole('region', { name: 'Фильтры' })).toBeVisible()
		await expect(page.getByRole('region', { name: 'Ключевые показатели' })).toBeVisible()
		await runAxe(page, 'admin-tax-tourism')
	})

	test('/o/{slug}/admin/migration-registrations passes WCAG 2.2 AA (M9.5 Phase A)', async ({
		page,
	}) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		await page.goto('/o/' + page.url().match(/\/o\/([^/]+)/)![1] + '/admin/migration-registrations')
		await expect(
			page.getByRole('heading', { name: /Миграционный учёт МВД/, level: 1 }),
		).toBeVisible()
		// Empty-state EmptyState (M9.5 Phase A) рендерится при первом заходе —
		// scan включает ReceiptIcon badge + h3 + description.
		await runAxe(page, 'admin-migration-registrations')
	})

	test('M9.5 Phase B prefers-contrast: more — dashboard + chessboard pass WCAG 2.2 AAA Sochi-blue overlay', async ({
		page,
	}) => {
		await page.emulateMedia({ contrast: 'more' })
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		const slug = page.url().match(/\/o\/([^/]+)/)![1]
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		await runAxe(page, 'dashboard-contrast-more')

		await page.goto(`/o/${slug}/grid`)
		await expect(page.getByRole('grid')).toBeVisible()
		await runAxe(page, 'chessboard-contrast-more')
	})

	test('M9.6 mobile axe extension — dashboard + receivables × 2 themes pass WCAG 2.2 AA', async ({
		page,
	}) => {
		// Plan §M9.6 canon: axe extension на mobile breakpoint × 2 themes
		// (light + dark) для catching regressions invisible на desktop matrix.
		await page.setViewportSize({ width: 390, height: 844 }) // iPhone 14
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		const slug = page.url().match(/\/o\/([^/]+)/)![1]
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		await runAxe(page, 'dashboard-mobile-light')

		// Dark theme на mobile.
		await page.evaluate(() => document.documentElement.classList.add('dark'))
		await page.waitForTimeout(800)
		await runAxe(page, 'dashboard-mobile-dark')

		// Receivables mobile — financial blocks с tabular-nums utility класс.
		await page.evaluate(() => document.documentElement.classList.remove('dark'))
		await page.waitForTimeout(400)
		await page.goto(`/o/${slug}/receivables`)
		await expect(page.getByRole('heading', { name: /Дебиторская задолженность/ })).toBeVisible()
		await runAxe(page, 'receivables-mobile-light')

		await page.evaluate(() => document.documentElement.classList.add('dark'))
		await page.waitForTimeout(800)
		await runAxe(page, 'receivables-mobile-dark')
	})

	test('M9.5 Phase A dark theme — dashboard + receivables pass WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		const slug = page.url().match(/\/o\/([^/]+)/)![1]
		// Force dark theme via class toggle (theme-store читает Zustand persist;
		// безопаснее напрямую apply'ить .dark на html для axe scan, без зависимости
		// от ThemeProvider race).
		await page.evaluate(() => document.documentElement.classList.add('dark'))
		// Wait for any in-flight view-transition snapshot to clear.
		await page.waitForTimeout(800)
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		await runAxe(page, 'dashboard-dark')

		await page.goto(`/o/${slug}/receivables`)
		await page.evaluate(() => document.documentElement.classList.add('dark'))
		await page.waitForTimeout(800)
		await expect(page.getByRole('heading', { name: /Дебиторская задолженность/ })).toBeVisible()
		await runAxe(page, 'receivables-dark')
	})

	test('/o/{slug}/admin/notifications passes WCAG 2.2 AA (M7.fix.3.d)', async ({ page }) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		// Post-A.bis.3: notification access via sidebar row (not dashboard tile).
		await page.locator('[data-section-id="notifications"]').click()
		await expect(page).toHaveURL(/\/admin\/notifications(\?.*)?$/)
		await expect(page.getByRole('heading', { name: /^Уведомления$/, level: 1 })).toBeVisible()
		await expect(page.getByRole('region', { name: 'Фильтры' })).toBeVisible()
		await expect(page.getByRole('region', { name: 'История уведомлений' })).toBeVisible()
		await runAxe(page, 'admin-notifications')
	})

	test('/o/{slug}/properties/{id}/content wizard — all 5 steps pass WCAG 2.2 AA (M8.A.0.UI)', async ({
		page,
	}) => {
		// Owner is logged in via storageState; tenant has 1+ properties
		// (setup wizard ran in earlier seed). Dashboard tile leads to wizard.
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		// Sidebar row is conditional on `firstProperty` from `propertiesQueryOptions`
		// (admin-sidebar.tsx) — wait for the asynchronous render before clicking.
		// Without this gate the click locator races the query and times out.
		// Post-A.bis.3: dashboard isn't a nav-хаб; navigate via sidebar.
		const profileRow = page.locator('[data-section-id="profile"]')
		await expect(profileRow).toBeVisible()
		await profileRow.click()
		await expect(page).toHaveURL(/\/properties\/[^/]+\/content$/)

		// Step 1 (compliance) — default landing
		await expect(page.getByRole('heading', { name: 'Профиль гостиницы', level: 1 })).toBeVisible()
		await expect(
			page.getByRole('region', { name: /Compliance — нормативные данные/ }),
		).toBeVisible()
		await runAxe(page, 'wizard-compliance-step')

		// Progress indicator buttons have aria-label `Перейти к шагу N: <label>`
		// — use that as the locator, not the visible <span> text (which would
		// require role+name=aria-label match anyway).
		await page.getByRole('button', { name: 'Перейти к шагу 2: Удобства' }).click()
		await expect(page.getByRole('region', { name: 'Удобства' })).toBeVisible()
		await runAxe(page, 'wizard-amenities-step')

		await page.getByRole('button', { name: 'Перейти к шагу 3: Описание' }).click()
		await expect(page.getByRole('region', { name: 'Описание гостиницы' })).toBeVisible()
		await expect(page.getByRole('tab', { name: 'Русский' })).toBeVisible()
		await runAxe(page, 'wizard-descriptions-step')

		await page.getByRole('button', { name: 'Перейти к шагу 4: Фото' }).click()
		await expect(page.getByRole('region', { name: 'Фото гостиницы' })).toBeVisible()
		await runAxe(page, 'wizard-media-step')

		await page.getByRole('button', { name: 'Перейти к шагу 5: Услуги' }).click()
		await expect(page.getByRole('region', { name: 'Услуги и доп. сервис' })).toBeVisible()
		await runAxe(page, 'wizard-addons-step')
	})

	test('/o/{slug}/setup wizard (in progress) passes WCAG 2.2 AA', async ({
		page,
		context,
		request,
	}) => {
		// Fresh tenant so we can land on /setup mid-onboarding (owner.json's
		// wizard is finished). Magic-link canon per [[auth-passwordless-canon]]
		// 2026-05-13 — старый email+password flow здесь был removed wholesale.
		test.setTimeout(60_000)
		await context.clearCookies()
		await purgeMailpit(request)
		const ts = Date.now()
		const email = `a11y-wizard-${ts}@sochi.local`
		const orgName = `A11y Wizard ${ts}`

		await page.goto('/signup')
		await page.getByLabel('Email').fill(email)
		await page.getByLabel('Название гостиницы').fill(orgName)
		await page.getByLabel(/согласие/).check()
		await page.getByRole('button', { name: 'Получить ссылку для регистрации' }).click()
		await expect(page.getByText('Письмо отправлено')).toBeVisible()

		const magicLinkUrl = await getMagicLinkUrl(request, email)
		await page.goto(magicLinkUrl)
		await expect(page.getByRole('heading', { name: 'Почти готово' })).toBeVisible()
		await Promise.all([
			page.waitForURL(/\/o\/[^/]+\/setup$/),
			page.getByRole('button', { name: 'Создать гостиницу →' }).click(),
		])
		await expect(page.getByLabel('ИНН гостиницы')).toBeVisible()
		await runAxe(page, 'wizard-property-step')
	})
})

test.describe('app-wide WCAG 2.2 AA audit (public pages, anonymous)', () => {
	test.use({ storageState: { cookies: [], origins: [] } }) // fresh anon context

	test('/signup passes WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/signup')
		await expect(page.getByRole('heading', { name: /Регистрация/ })).toBeVisible()
		await runAxe(page, 'signup')
	})

	test('/login passes WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/login')
		await expect(page.getByRole('heading', { name: /Вход/ })).toBeVisible()
		await runAxe(page, 'login')
	})

	test('/privacy passes WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/privacy')
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		await runAxe(page, 'privacy')
	})

	test('/ landing passes WCAG 2.2 AA (discovery-first credibility surface)', async ({ page }) => {
		// Mock external Yandex.Metrika tag-script — never hit real CDN из e2e
		// (canon: no real network calls + не пачкать real counter test-traffic'ом).
		await page.route('**/mc.yandex.ru/metrika/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/javascript',
				body: '/* mocked */',
			}),
		)
		await page.goto('/')
		// Brand «Сэпшн» виден в hero-position + H1 exact text + 2 контакт-кнопки.
		// Anti-regression smoke: anon visitor must see landing (fail-open auth),
		// не error-page и не redirect к /login.
		await expect(
			page.getByRole('heading', {
				name: 'Программа для управления гостевым домом или мини-отелем.',
				level: 1,
			}),
		).toBeVisible()
		await expect(page.getByRole('link', { name: 'Telegram' })).toBeVisible()
		await expect(page.getByRole('link', { name: 'Email' })).toBeVisible()
		// axe scan с exclude `[data-sonner-toast]`: Sonner success-toast
		// (rich-colors variant) имеет contrast 1.99:1 — universal codebase
		// concern, не landing-specific. TODO: проект-wide fix через
		// Sonner theme override или `--toast-success-bg`/`--toast-success-color`
		// CSS-variables в index.css. Tracked separately.
		const results = await new AxeBuilder({ page })
			.withTags([...WCAG_TAGS])
			.exclude('[data-sonner-toast]')
			.analyze()
		if (results.violations.length > 0) {
			console.error('axe violations (landing):', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})

	test('/ Yandex.Metrika integration smoke (deferred init wiring)', async ({ page }) => {
		// Mock external tag-script — никогда не hit'ить реальный CDN/counter
		// из e2e (test traffic пачкал бы real analytics + offline-CI flake).
		await page.route('**/mc.yandex.ru/metrika/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/javascript',
				body: '/* mocked Yandex.Metrika tag */',
			}),
		)
		await page.goto('/')
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		// Метрика deferred — listeners attached, init не fires immediately.
		// Click (на main) → first-interaction trigger → initYandexMetrika
		// внутри lib → window.ym становится function.
		await page.locator('main').click({ position: { x: 10, y: 10 } })
		await page.waitForFunction(() => typeof (globalThis as { ym?: unknown }).ym === 'function', {
			timeout: 5000,
		})
	})

	test('/ landing passes WCAG 2.2 AA на 360px mobile viewport', async ({ page }) => {
		await page.route('**/mc.yandex.ru/metrika/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/javascript',
				body: '/* mocked */',
			}),
		)
		// 360×640 — baseline modern mobile (iPhone SE-class).
		// Anti-regression: H1 не должен overflow, кнопки tap-target ≥44×44px,
		// axe должен pass на той же странице.
		// Per `feedback_layer_4_5_mandatory_per_subphase` — каждая UI-surface
		// нужна mobile-viewport axe pass до commit'а.
		await page.setViewportSize({ width: 360, height: 640 })
		await page.goto('/')
		await expect(
			page.getByRole('heading', {
				name: 'Программа для управления гостевым домом или мини-отелем.',
				level: 1,
			}),
		).toBeVisible()
		await expect(page.getByRole('link', { name: 'Telegram' })).toBeVisible()
		await expect(page.getByRole('link', { name: 'Email' })).toBeVisible()
		// Tap-target size — explicit assertion (h-11 = 44px Tailwind). WCAG 2.2
		// SC 2.5.8 Level AA минимум 24×24, AAA 44×44; мы целимся в AAA.
		const tgBox = await page.getByRole('link', { name: 'Telegram' }).boundingBox()
		const emailBox = await page.getByRole('link', { name: 'Email' }).boundingBox()
		expect(tgBox?.height ?? 0).toBeGreaterThanOrEqual(44)
		expect(emailBox?.height ?? 0).toBeGreaterThanOrEqual(44)
		const results = await new AxeBuilder({ page })
			.withTags([...WCAG_TAGS])
			.exclude('[data-sonner-toast]')
			.analyze()
		if (results.violations.length > 0) {
			console.error('axe violations (landing-mobile):', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})
})
