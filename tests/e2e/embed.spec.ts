/**
 * Embed widget E2E — A4 closure axe AA + visual smoke.
 *
 * Targets the iframe HTML wrapper at
 *   `/api/embed/v1/iframe/{tenantSlug}/{propertyId}.html`
 * (М9.widget.6 / А4.4) with the seeded `demo-sirius` tenant + its
 * `demo-prop-sirius-main` property. Wrapper response carries:
 *   - per-tenant CSP `frame-ancestors` from `publicEmbedDomains`
 *   - COOP `same-origin-allow-popups` (D34)
 *   - minimal-trust Permissions-Policy
 *   - `<sochi-booking-widget-v1>` Web Component bootstrap
 *
 * Per `plans/m9_widget_6_canonical.md` §11 закрытие checklist:
 *   - axe AA pass на embed widget (4 viewports)
 *   - Visual smoke на 4 widths (320 / 768 / 1024 / 1440)
 *
 * Spec uses `smoke` project (anonymous, no storageState dep).
 */

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8787'
const IFRAME_URL = `${API_URL}/api/embed/v1/iframe/demo-sirius/demo-prop-sirius-main.html`

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const

test.describe('embed iframe wrapper — axe AA + visual smoke', () => {
	test.describe.configure({ mode: 'serial' })

	test('[EMB1] iframe wrapper renders (200 + Content-Type + сtg-button visible)', async ({
		page,
	}) => {
		const response = await page.goto(IFRAME_URL)
		expect(response?.status()).toBe(200)
		expect(response?.headers()['content-type']).toContain('text/html')
		// Custom element registers on bundle eval; CTA button is the canonical
		// rendered surface для idle state.
		await page.waitForFunction(() =>
			Boolean(customElements.get('sochi-booking-widget-v1')),
		)
		await expect(page.getByTestId('widget-cta')).toBeVisible({ timeout: 10_000 })
		await expect(page.getByTestId('widget-cta')).toHaveText('Забронировать')
	})

	test('[EMB2] axe-pass desktop 1440', async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 })
		await page.goto(IFRAME_URL)
		await page.waitForFunction(() =>
			Boolean(customElements.get('sochi-booking-widget-v1')),
		)
		await expect(page.getByTestId('widget-cta')).toBeVisible()
		const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze()
		if (results.violations.length > 0) {
			console.error('axe violations (desktop 1440):', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})

	test('[EMB3] axe-pass mobile 360×740', async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 740 })
		await page.goto(IFRAME_URL)
		await page.waitForFunction(() =>
			Boolean(customElements.get('sochi-booking-widget-v1')),
		)
		await expect(page.getByTestId('widget-cta')).toBeVisible()
		const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze()
		expect(results.violations).toEqual([])
	})

	test('[EMB4] axe-pass forced-colors (high-contrast)', async ({ page }) => {
		await page.emulateMedia({ forcedColors: 'active' })
		await page.goto(IFRAME_URL)
		await page.waitForFunction(() =>
			Boolean(customElements.get('sochi-booking-widget-v1')),
		)
		await expect(page.getByTestId('widget-cta')).toBeVisible()
		const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze()
		expect(results.violations).toEqual([])
	})

	test('[EMB5] visual smoke @ 320 (small mobile)', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 })
		await page.goto(IFRAME_URL)
		await page.waitForFunction(() =>
			Boolean(customElements.get('sochi-booking-widget-v1')),
		)
		await expect(page.getByTestId('widget-cta')).toBeVisible()
		// Snapshot (Playwright generates baseline on first run; CI compares).
		await expect(page).toHaveScreenshot('embed-iframe-320.png', { maxDiffPixelRatio: 0.05 })
	})

	test('[EMB6] visual smoke @ 768 (tablet)', async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 1024 })
		await page.goto(IFRAME_URL)
		await page.waitForFunction(() =>
			Boolean(customElements.get('sochi-booking-widget-v1')),
		)
		await expect(page.getByTestId('widget-cta')).toBeVisible()
		await expect(page).toHaveScreenshot('embed-iframe-768.png', { maxDiffPixelRatio: 0.05 })
	})

	test('[EMB7] visual smoke @ 1024 (small desktop)', async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(IFRAME_URL)
		await page.waitForFunction(() =>
			Boolean(customElements.get('sochi-booking-widget-v1')),
		)
		await expect(page.getByTestId('widget-cta')).toBeVisible()
		await expect(page).toHaveScreenshot('embed-iframe-1024.png', { maxDiffPixelRatio: 0.05 })
	})

	test('[EMB8] visual smoke @ 1440 (desktop)', async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 })
		await page.goto(IFRAME_URL)
		await page.waitForFunction(() =>
			Boolean(customElements.get('sochi-booking-widget-v1')),
		)
		await expect(page.getByTestId('widget-cta')).toBeVisible()
		await expect(page).toHaveScreenshot('embed-iframe-1440.png', { maxDiffPixelRatio: 0.05 })
	})
})
