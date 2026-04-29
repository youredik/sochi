/**
 * Widget public route E2E — anonymous access + axe-pass per plan §M9.widget.1
 * DoD checklist: «axe-pass на новой public route (light + dark + mobile +
 * contrast-more = 4 scans)».
 *
 * Pre-requirement: backend running + demo tenant seeded (auto-seeded в startup).
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const WIDGET_URL = '/widget/demo-sirius'

test.describe('widget public route — anonymous + axe', () => {
	test('[W1] anonymous user can load /widget/demo-sirius (no 401)', async ({ page }) => {
		await page.goto(WIDGET_URL)
		// h1 = tenant name (per widget.$tenantSlug.tsx component)
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		// demo banner because seeded tenant.mode='demo'
		await expect(page.getByText(/Демо-режим/)).toBeVisible()
	})

	test('[W2] unknown tenant → not-found message (404 propagates)', async ({ page }) => {
		const res = await page.goto('/widget/never-exists-12345')
		// notFound() throws router NotFoundError → component renders not-found
		// branch (h1 "Не найдено"). Playwright .goto returns null on
		// non-2xx in some configs — accept either path.
		if (res !== null) {
			expect([200, 404]).toContain(res.status())
		}
		await expect(page.getByText(/Не найдено|never-exists/)).toBeVisible({ timeout: 5_000 })
	})

	test('[W3] axe-pass на /widget/demo-sirius (light theme, desktop)', async ({ page }) => {
		await page.goto(WIDGET_URL)
		await page.getByRole('heading', { level: 1 }).waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[W4] axe-pass на /widget/demo-sirius (dark theme, desktop)', async ({ page }) => {
		// Set dark mode via class on root before navigating
		await page.addInitScript(() => {
			document.documentElement.classList.add('dark')
			localStorage.setItem('horeca-theme', 'dark')
		})
		await page.goto(WIDGET_URL)
		await page.getByRole('heading', { level: 1 }).waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[W5] axe-pass на /widget/demo-sirius (mobile viewport 360×740)', async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 740 })
		await page.goto(WIDGET_URL)
		await page.getByRole('heading', { level: 1 }).waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[W6] tenant property visible в DOM (Сочи tourism tax 2% rendered)', async ({ page }) => {
		await page.goto(WIDGET_URL)
		await page.getByRole('heading', { level: 1 }).waitFor()
		// Demo tenant seeded property = "Гостиница Сириус — Морская резиденция"
		await expect(page.getByText(/Морская резиденция/)).toBeVisible()
		// Tourism tax rendered as percentage из 200 bps = 2.0%
		await expect(page.getByText(/Туристический налог 2\.0%/)).toBeVisible()
	})

	test('[W7] CSP headers present on widget API endpoint', async ({ request }) => {
		const res = await request.get('/api/public/widget/demo-sirius/properties')
		expect(res.status()).toBe(200)
		const csp = res.headers()['content-security-policy']
		expect(csp).toBeTruthy()
		expect(csp).toContain("default-src 'self'")
		expect(csp).toContain('https://yookassa.ru')
		expect(res.headers()['x-content-type-options']).toBe('nosniff')
		expect(res.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin')
	})
})
