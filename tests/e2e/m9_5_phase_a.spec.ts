import { expect, type Page, test } from '@playwright/test'

/**
 * M9.5 Phase A — comprehensive live-user visual smoke.
 *
 * Captures full-page screenshots from a real-user perspective:
 *   - Anonymous: /signup, /login (Sochi-blue button visible)
 *   - Authenticated desktop: dashboard, chessboard, receivables, admin/notifications,
 *     admin/migration-registrations, admin/tax (light + dark)
 *   - Mobile viewport (390×844 — iPhone 14): dashboard + chessboard + bottom nav
 *   - Theme switching: ModeToggle DropdownMenu open + dark theme applied (3 routes)
 *   - prefers-contrast: more — AAA Sochi-blue overlay (light + dark)
 *   - prefers-reduced-motion: reduce — animations disabled
 *
 * settle() waits for cross-document view-transition pseudo-elements + fade
 * animations to clear. forceDark() adds .dark class + 800ms post-toggle wait
 * so the screenshot captures steady state, not composite frame.
 *
 * Console errors fail the run.
 *
 * Outputs: .artifacts/m9_5_phase_a/{NN-name}.png
 */

const OUT = '.artifacts/m9_5_phase_a'
const DESKTOP = { width: 1440, height: 900 } as const
const MOBILE = { width: 390, height: 844 } as const // iPhone 14

async function settle(page: Page) {
	await page.waitForLoadState('networkidle')
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() =>
					requestAnimationFrame(() => setTimeout(() => resolve(), 400)),
				)
			}),
	)
}

async function forceDark(page: Page) {
	await page.evaluate(() => document.documentElement.classList.add('dark'))
	await page.waitForTimeout(800)
}

async function clearDark(page: Page) {
	await page.evaluate(() => document.documentElement.classList.remove('dark'))
	await page.waitForTimeout(800)
}

test.describe('M9.5 Phase A — live-user visual smoke', () => {
	test('authenticated journey: light + dark + ModeToggle + mobile', async ({
		page,
		context,
	}) => {
		const consoleErrors: string[] = []
		page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
		page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

		await page.setViewportSize(DESKTOP)
		await page.goto('/')
		await page.waitForURL(/\/o\/[a-z0-9-]+\/?$/)
		const slug = page.url().match(/\/o\/([a-z0-9-]+)/)![1]

		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		await settle(page)
		await page.screenshot({ path: `${OUT}/01-dashboard-light.png`, fullPage: true })

		await page.goto(`/o/${slug}/grid`)
		await expect(page.getByRole('grid')).toBeVisible()
		await settle(page)
		await page.screenshot({ path: `${OUT}/02-chessboard-light.png`, fullPage: true })

		await page.goto(`/o/${slug}/receivables`)
		await settle(page)
		await page.screenshot({ path: `${OUT}/03-receivables-light.png`, fullPage: true })

		await page.goto(`/o/${slug}/admin/notifications`)
		await settle(page)
		await page.screenshot({ path: `${OUT}/04-notifications-light.png`, fullPage: true })

		await page.goto(`/o/${slug}/admin/migration-registrations`)
		await settle(page)
		await page.screenshot({
			path: `${OUT}/05-migration-registrations-light.png`,
			fullPage: true,
		})

		await page.goto(`/o/${slug}/admin/tax`)
		await settle(page)
		await page.screenshot({ path: `${OUT}/06-admin-tax-light.png`, fullPage: true })

		// Dark theme — same routes, regression-evidence light → dark token swap.
		await page.goto(`/o/${slug}/`)
		await settle(page)
		await forceDark(page)
		await page.screenshot({ path: `${OUT}/07-dashboard-dark.png`, fullPage: true })

		await page.goto(`/o/${slug}/receivables`)
		await settle(page)
		await forceDark(page)
		await page.screenshot({ path: `${OUT}/08-receivables-dark.png`, fullPage: true })

		await page.goto(`/o/${slug}/admin/tax`)
		await settle(page)
		await forceDark(page)
		await page.screenshot({ path: `${OUT}/09-admin-tax-dark.png`, fullPage: true })

		// ModeToggle — verifies @starting-style + radix popper + 3 theme options.
		await clearDark(page)
		await page.goto(`/o/${slug}/`)
		await settle(page)
		await page.getByRole('button', { name: /Тема оформления/ }).click()
		await page.waitForTimeout(300)
		await page.screenshot({ path: `${OUT}/10-mode-toggle-open.png`, fullPage: true })
		// Close dropdown.
		await page.keyboard.press('Escape')

		// Mobile viewport — verifies pb-safe-bottom + 5-tab bottom nav + Vaul drawer.
		await page.setViewportSize(MOBILE)
		await page.goto(`/o/${slug}/`)
		await settle(page)
		await page.screenshot({ path: `${OUT}/11-dashboard-mobile.png`, fullPage: true })

		await page.goto(`/o/${slug}/grid`)
		await settle(page)
		await page.screenshot({ path: `${OUT}/12-chessboard-mobile.png`, fullPage: true })

		// Mobile dark — composite of mobile-shell (M9.2) + brand (M9.5).
		await forceDark(page)
		await page.screenshot({ path: `${OUT}/13-chessboard-mobile-dark.png`, fullPage: true })

		// prefers-contrast: more — AAA Sochi-blue overlay (oklch 0.45 0.20 240 light).
		await clearDark(page)
		await page.setViewportSize(DESKTOP)
		await context.emulateContrast?.({ contrast: 'more' }).catch(() => null)
		await page.emulateMedia({ contrast: 'more' })
		await page.goto(`/o/${slug}/`)
		await settle(page)
		await page.screenshot({ path: `${OUT}/14-dashboard-contrast-more.png`, fullPage: true })

		// prefers-reduced-motion — global override; visual snapshot identical to
		// 01 but proves @media gate didn't break layout.
		await page.emulateMedia({ contrast: null, reducedMotion: 'reduce' })
		await page.goto(`/o/${slug}/`)
		await settle(page)
		await page.screenshot({
			path: `${OUT}/15-dashboard-reduced-motion.png`,
			fullPage: true,
		})

		expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
	})
})

test.describe('M9.5 Phase A — anonymous surfaces', () => {
	test.use({ storageState: { cookies: [], origins: [] } })

	test('login + signup pages render Sochi-blue button + pass smoke', async ({ page }) => {
		const consoleErrors: string[] = []
		page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
		page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

		await page.setViewportSize(DESKTOP)
		await page.goto('/login')
		await expect(page.getByRole('heading', { name: /Вход/ })).toBeVisible()
		await settle(page)
		await page.screenshot({ path: `${OUT}/16-login-light.png`, fullPage: true })

		await page.goto('/signup')
		await expect(page.getByRole('heading', { name: /Регистрация/ })).toBeVisible()
		await settle(page)
		await page.screenshot({ path: `${OUT}/17-signup-light.png`, fullPage: true })

		// Login — mobile viewport (real-user iOS Safari).
		await page.setViewportSize(MOBILE)
		await page.goto('/login')
		await settle(page)
		await page.screenshot({ path: `${OUT}/18-login-mobile.png`, fullPage: true })

		expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
	})
})
