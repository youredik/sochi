import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

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
		// Click the dashboard tile linking to receivables.
		await page.getByRole('link', { name: /Дебиторка/ }).click()
		await expect(page).toHaveURL(/\/receivables$/)
		// Heading + KPI region must be visible.
		await expect(page.getByRole('heading', { name: /Дебиторская задолженность/ })).toBeVisible()
		await expect(page.getByRole('region', { name: 'Ключевые показатели' })).toBeVisible()
		await runAxe(page, 'receivables-dashboard')
	})

	test('/o/{slug}/setup wizard (in progress) passes WCAG 2.2 AA', async ({ page, context }) => {
		// Fresh tenant so we can land on /setup. Sign up a brand-new user
		// in THIS test's context (can't reuse owner.json which has a fully-
		// configured tenant).
		await context.clearCookies()
		await page.goto('/signup')
		const ts = Date.now()
		await page.getByLabel('Ваше имя').fill('A11y Wizard')
		await page.getByLabel('Email').fill(`a11y-wizard-${ts}@sochi.local`)
		await page.getByLabel('Пароль').fill('playwright-e2e-01')
		await page.getByLabel('Название гостиницы').fill(`A11y Wizard ${ts}`)
		await page.getByLabel(/согласие/).check()
		await page.getByRole('button', { name: 'Создать аккаунт' }).click()
		await expect(page).toHaveURL(/\/setup$/)
		await expect(page.getByLabel('Название гостиницы')).toBeVisible()
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
})
