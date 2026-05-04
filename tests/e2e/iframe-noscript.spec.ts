/**
 * iframe `<noscript>` fallback — M9.widget.7 / A5.4 / D13.
 *
 * Per `plans/m9_widget_7_canonical.md` §2 D13 + R2 §9:
 *   «<noscript> block с tel: + tenant phone; Playwright test с
 *    javaScriptEnabled: false. RU gov sites strict CSP без unsafe-inline
 *    not eligible для the JS path → noscript MUST render usable surface».
 *
 * The iframe HTML wrapper (`/api/embed/v1/iframe/{slug}/{prop}.html`) emits a
 * `<noscript>` block carrying the tenant's phone (`tel:` link) + tenant name +
 * brief explainer. With JS disabled, the booking flow is unavailable but
 * users see actionable contact info instead of a blank `<custom-element>` gap.
 *
 * Test approach:
 *   - Playwright browser context с `javaScriptEnabled: false`.
 *   - Navigate iframe URL → expect `<noscript>` content visible.
 *   - axe-pass на noscript-rendered surface (separate accessibility class
 *     because no Web Component, no Lit, only flat HTML).
 */

import { expect, test } from '@playwright/test'

const API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8787'
const IFRAME_URL = `${API_URL}/api/embed/v1/iframe/demo-sirius/demo-prop-sirius-main.html`

test.describe('iframe noscript fallback (D13)', () => {
	test.use({ javaScriptEnabled: false })

	test('[IFNS1] noscript section renders contact info + booking link', async ({ page }) => {
		const response = await page.goto(IFRAME_URL)
		expect(response?.status()).toBe(200)
		expect(response?.headers()['content-type']).toContain('text/html')

		// JS disabled — Web Component cannot register, host element is empty.
		// noscript content is visible directly in the DOM tree.
		const html = await page.content()
		// noscript MUST exist + carry the booking-link fallback. Phone column
		// not yet on schema (carry-forward к M11+ admin UI) — booking link
		// is the actionable signal until then.
		expect(html).toContain('<noscript>')
		expect(html).toContain('data-testid="iframe-noscript"')
		expect(html).toContain('https://demo-sirius.sochi.app/widget/demo-sirius')
	})

	test('[IFNS2] noscript link is keyboard-reachable (focusable, has accessible name)', async ({
		page,
	}) => {
		// axe-pass на full noscript surface не достижим — `@axe-core/playwright`
		// инжектится через `frame.evaluate()`, который требует JS. Вместо этого
		// верифицируем критичные WCAG-инварианты через прямые DOM-asserts:
		// link visible + has descriptive text + has href.
		await page.goto(IFRAME_URL)
		const noscriptRegion = page.locator('[data-testid="iframe-noscript"]')
		await expect(noscriptRegion).toBeVisible()
		const link = noscriptRegion.locator('a[href]')
		await expect(link).toBeVisible()
		await expect(link).toHaveAccessibleName(/.+/) // non-empty accessible name
		const href = await link.getAttribute('href')
		expect(href).toBe('https://demo-sirius.sochi.app/widget/demo-sirius')
	})
})
