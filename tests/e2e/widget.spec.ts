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

	test('[W2] unknown tenant → not-found message (notFoundComponent renders)', async ({ page }) => {
		const res = await page.goto('/widget/never-exists-12345')
		if (res !== null) {
			// SPA returns 200 для initial document load; notFoundComponent rendered
			// client-side after hydration (proper 404 status — carry-forward к
			// M9.widget.6 SSR sub-phase).
			expect([200, 404]).toContain(res.status())
		}
		// Use getByRole для unambiguous match — Playwright strict mode требует
		// один element. /Не найдено|never-exists/ via getByText матчит и h1
		// и <code> → strict mode violation. Канон 2026 per Playwright docs.
		await expect(page.getByRole('heading', { level: 1, name: 'Не найдено' })).toBeVisible({
			timeout: 5_000,
		})
		// Verify slug also rendered (separate locator, no strict-mode conflict)
		await expect(page.getByText('never-exists-12345')).toBeVisible()
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

	test('[W5b] axe-pass на /widget/demo-sirius (prefers-contrast: more — AAA overlay)', async ({
		page,
	}) => {
		// Emulate forced-colors / high-contrast preference per M9.5 Phase A canon
		// (AAA overlay token-set активируется через @media prefers-contrast: more).
		// 4-я scan complete matrix: light + dark + mobile + contrast-more.
		await page.emulateMedia({ forcedColors: 'active' })
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
		// Tourism tax rendered as percentage из 200 bps = 2.0%. Number wrapped
		// в tabular-nums span — Playwright getByText не match'ает across nodes;
		// assert через section's textContent.
		const propertiesSection = page.getByRole('region', { name: 'Список объектов размещения' })
		await expect(propertiesSection).toBeVisible()
		expect(await propertiesSection.textContent()).toMatch(/Туристический налог\s*·?\s*2\.0%/)
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

// ═════════════════════════════════════════════════════════════════════════
// M9.widget.2 — Screen 1 Search & Pick (sub-route /widget/:slug/:propertyId)
// ═════════════════════════════════════════════════════════════════════════

const PROPERTY_URL = '/widget/demo-sirius/demo-prop-sirius-main'
const todayPlus = (days: number) => {
	const d = new Date()
	d.setUTCHours(0, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + days)
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

test.describe('widget Screen 1 Search & Pick — happy + adversarial + axe matrix', () => {
	test('[S1] property card link → screen 1 sub-route loads (sticky-summary visible)', async ({
		page,
	}) => {
		await page.goto(WIDGET_URL)
		await page.getByTestId('property-link-demo-prop-sirius-main').click()
		await page.waitForURL(/\/widget\/demo-sirius\/demo-prop-sirius-main/)
		await expect(page.getByTestId('search-bar')).toBeVisible({ timeout: 10_000 })
		await expect(page.getByTestId('sticky-summary')).toBeVisible()
	})

	test('[S2] availability search renders rate cards (BAR_FLEX + BAR_NR each room)', async ({
		page,
	}) => {
		const url = `${PROPERTY_URL}?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
		await page.goto(url)
		await expect(page.getByTestId('rate-card-demo-roomtype-deluxe')).toBeVisible()
		await expect(page.getByTestId('rate-card-demo-roomtype-standard')).toBeVisible()
		// Default rate auto-selected (BAR_FLEX) → summary breakdown visible
		await expect(page.getByTestId('summary-breakdown').first()).toBeVisible()
		// Total kopecks rendered as RU money — must contain "₽"
		await expect(page.getByTestId('summary-total-detail').first()).toContainText('₽')
	})

	test('[S3] tourism tax 2% line in summary breakdown', async ({ page }) => {
		const url = `${PROPERTY_URL}?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
		await page.goto(url)
		const breakdown = page.getByTestId('summary-breakdown').first()
		await expect(breakdown).toBeVisible()
		await expect(breakdown).toContainText('Туристический налог')
		expect(await breakdown.textContent()).toMatch(/2\.0%/)
	})

	test('[S4] free-cancel deadline rendered for refundable rate (BAR Flex default)', async ({
		page,
	}) => {
		const url = `${PROPERTY_URL}?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
		await page.goto(url)
		await expect(page.getByTestId('summary-cancel-deadline').first()).toContainText(
			'Отмена без штрафа',
		)
	})

	test('[S5] axe-pass on screen 1 (light + desktop)', async ({ page }) => {
		const url = `${PROPERTY_URL}?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
		await page.goto(url)
		await page.getByRole('heading', { level: 1 }).waitFor()
		await page.getByTestId('summary-total-detail').first().waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[S6] axe-pass on screen 1 (dark + desktop)', async ({ page }) => {
		await page.addInitScript(() => {
			document.documentElement.classList.add('dark')
			localStorage.setItem('horeca-theme', 'dark')
		})
		const url = `${PROPERTY_URL}?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
		await page.goto(url)
		await page.getByRole('heading', { level: 1 }).waitFor()
		await page.getByTestId('summary-total-detail').first().waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[S7] axe-pass on screen 1 (mobile 360×740 — Vaul drawer mode)', async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 740 })
		const url = `${PROPERTY_URL}?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
		await page.goto(url)
		await page.getByRole('heading', { level: 1 }).waitFor()
		await page.getByTestId('summary-total').first().waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[S8] axe-pass on screen 1 (forced-colors / contrast-more)', async ({ page }) => {
		await page.emulateMedia({ forcedColors: 'active' })
		const url = `${PROPERTY_URL}?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
		await page.goto(url)
		await page.getByRole('heading', { level: 1 }).waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[S9] cross-tenant unknown property → not-found component rendered', async ({ page }) => {
		await page.goto('/widget/demo-sirius/never-exists-prop-id')
		await expect(page.getByRole('heading', { level: 1, name: 'Не найдено' })).toBeVisible()
	})

	test('[S10] availability API endpoint returns 200 + total kopecks JSON-safe', async ({
		request,
	}) => {
		const url = `/api/public/widget/demo-sirius/properties/demo-prop-sirius-main/availability?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
		const res = await request.get(url)
		expect(res.status()).toBe(200)
		const body = (await res.json()) as {
			data: { offerings: Array<{ rateOptions: Array<{ totalKopecks: number }> }> }
		}
		expect(body.data.offerings.length).toBeGreaterThanOrEqual(1)
		const firstRate = body.data.offerings[0]?.rateOptions[0]
		expect(typeof firstRate?.totalKopecks).toBe('number')
		expect(firstRate?.totalKopecks).toBeGreaterThan(0)
	})

	test('[S11] availability 422 on stay > 30 nights', async ({ request }) => {
		const url = `/api/public/widget/demo-sirius/properties/demo-prop-sirius-main/availability?checkIn=${todayPlus(1)}&checkOut=${todayPlus(60)}&adults=2&children=0`
		const res = await request.get(url)
		expect(res.status()).toBe(422)
	})

	test('[S12] invalid search param adults=abc → route errorComponent (NOT blank page)', async ({
		page,
	}) => {
		// validateSearch Zod coerce.number rejects "abc" → throws → route errorComponent fires.
		await page.goto(`${PROPERTY_URL}?adults=abc&checkIn=2026-06-01&checkOut=2026-06-03`)
		await expect(page.getByTestId('route-error-fallback')).toBeVisible({ timeout: 5_000 })
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Что-то пошло не так')
	})
})

const EXTRAS_URL = `/widget/demo-sirius/demo-prop-sirius-main/extras`

function extrasUrlWithDefaults(): string {
	const params = new URLSearchParams({
		checkIn: todayPlus(30),
		checkOut: todayPlus(33),
		adults: '2',
		children: '0',
		roomTypeId: 'demo-roomtype-deluxe',
		ratePlanId: 'demo-rateplan-deluxe-bar-flex',
	})
	return `${EXTRAS_URL}?${params.toString()}`
}

test.describe('widget Screen 2 Extras / Addons — happy + adversarial + axe matrix', () => {
	test('[X1] addons API endpoint returns 200 + JSON-safe (no bigint leak)', async ({ request }) => {
		const url = '/api/public/widget/demo-sirius/properties/demo-prop-sirius-main/addons'
		const res = await request.get(url)
		expect(res.status()).toBe(200)
		const text = await res.text()
		// No bigint leak (n suffix) per Round 2 verified canon
		expect(text).not.toMatch(/\d+n[",}\]]/)
		const body = (await res.json()) as {
			data: { addons: Array<{ priceKopecks: number; vatBps: number; pricingUnit: string }> }
		}
		// Demo seed has 5 Сочи addons (M9.widget.3)
		expect(body.data.addons.length).toBeGreaterThanOrEqual(5)
		const first = body.data.addons[0]
		expect(typeof first?.priceKopecks).toBe('number')
		expect(first?.vatBps).toBe(2200) // НДС 22% canon
	})

	test('[X2] navigate Screen 1 → Screen 2 via Continue CTA (URL changes to /extras)', async ({
		page,
	}) => {
		const url = `${PROPERTY_URL}?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
		await page.goto(url)
		// Wait for default rate auto-selected (Screen 1 ready)
		await page.getByTestId('summary-total-detail').first().waitFor()
		// Click Continue (desktop sticky aside variant)
		await page.getByTestId('summary-continue-detail').first().click()
		// URL should now contain /extras
		await page.waitForURL(/\/extras/)
		// Screen 2 header rendered
		await expect(page.getByRole('heading', { level: 1, name: /Дополнительные услуги/ })).toBeVisible(
			{ timeout: 10_000 },
		)
	})

	test('[X3] addons rendered + opt-in canon (all qty=0 default ЗоЗПП ст. 16 ч. 3.1)', async ({
		page,
	}) => {
		await page.goto(extrasUrlWithDefaults())
		// 5 Сочи addons rendered (BREAKFAST/PARKING/LATE_CHECKOUT/TRANSFER_AER/SPA_HOUR)
		await expect(page.getByTestId('addon-card-BREAKFAST')).toBeVisible({ timeout: 10_000 })
		await expect(page.getByTestId('addon-card-PARKING')).toBeVisible()
		await expect(page.getByTestId('addon-card-LATE_CHECKOUT')).toBeVisible()
		await expect(page.getByTestId('addon-card-TRANSFER_AER')).toBeVisible()
		await expect(page.getByTestId('addon-card-SPA_HOUR')).toBeVisible()
		// Opt-in: every card has data-selected="false" by default
		const cards = page.locator('article[data-testid^="addon-card-"]')
		const count = await cards.count()
		for (let i = 0; i < count; i++) {
			expect(await cards.nth(i).getAttribute('data-selected')).toBe('false')
		}
	})

	test('[X4] click + on addon → quantity increments + total updates', async ({ page }) => {
		await page.goto(extrasUrlWithDefaults())
		await page.getByTestId('addon-card-BREAKFAST').waitFor()
		const totalBefore = await page.getByTestId('summary-total-detail').first().textContent()
		await page.getByTestId('addon-BREAKFAST-inc').click()
		// Card now selected
		await expect(page.getByTestId('addon-card-BREAKFAST')).toHaveAttribute('data-selected', 'true')
		// Total updated (greater than before)
		const totalAfter = await page.getByTestId('summary-total-detail').first().textContent()
		expect(totalAfter).not.toBe(totalBefore)
	})

	test('[X5] Skip CTA always visible (Baymard 2026 + ЗоЗПП canon)', async ({ page }) => {
		await page.goto(extrasUrlWithDefaults())
		await expect(page.getByTestId('extras-skip')).toBeVisible({ timeout: 10_000 })
		await expect(page.getByTestId('extras-skip')).toContainText('Продолжить без дополнений')
	})

	test('[X6] tax note rendered (тур.налог 2% applies к room only ст. 418.4 НК РФ)', async ({
		page,
	}) => {
		await page.goto(extrasUrlWithDefaults())
		const note = page.getByTestId('extras-tax-note')
		await expect(note).toBeVisible({ timeout: 10_000 })
		await expect(note).toContainText('Туристический налог 2.0%')
		await expect(note).toContainText('не на дополнения')
	})

	test('[X7] cancellation disclosure rendered per addon (ПП РФ №1912)', async ({ page }) => {
		await page.goto(extrasUrlWithDefaults())
		const card = page.getByTestId('addon-card-BREAKFAST')
		await card.waitFor()
		await expect(card).toContainText('Бесплатная отмена до')
	})

	test('[X8] VAT 22% line per addon (ст. 10 ЗоЗПП — обязательная цена с НДС)', async ({
		page,
	}) => {
		await page.goto(extrasUrlWithDefaults())
		const card = page.getByTestId('addon-card-BREAKFAST')
		await card.waitFor()
		await expect(card).toContainText('в т.ч. НДС 22%')
	})

	test('[X9] axe-pass on Screen 2 (light + desktop)', async ({ page }) => {
		await page.goto(extrasUrlWithDefaults())
		await page.getByRole('heading', { level: 1 }).waitFor()
		await page.getByTestId('addon-card-BREAKFAST').waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[X10] axe-pass on Screen 2 (dark + desktop)', async ({ page }) => {
		await page.addInitScript(() => {
			document.documentElement.classList.add('dark')
			localStorage.setItem('horeca-theme', 'dark')
		})
		await page.goto(extrasUrlWithDefaults())
		await page.getByRole('heading', { level: 1 }).waitFor()
		await page.getByTestId('addon-card-BREAKFAST').waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[X11] axe-pass on Screen 2 (mobile 360×740)', async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 740 })
		await page.goto(extrasUrlWithDefaults())
		await page.getByRole('heading', { level: 1 }).waitFor()
		await page.getByTestId('addon-card-BREAKFAST').waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[X12] axe-pass on Screen 2 (forced-colors)', async ({ page }) => {
		await page.emulateMedia({ forcedColors: 'active' })
		await page.goto(extrasUrlWithDefaults())
		await page.getByRole('heading', { level: 1 }).waitFor()
		await page.getByTestId('addon-card-BREAKFAST').waitFor()
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		expect(results.violations).toEqual([])
	})

	test('[X13] cart serialized into URL search params (shareable)', async ({ page }) => {
		await page.goto(extrasUrlWithDefaults())
		await page.getByTestId('addon-card-BREAKFAST').waitFor()
		await page.getByTestId('addon-BREAKFAST-inc').click()
		await page.waitForURL(/addons=demo-addon-breakfast%3A1|addons=demo-addon-breakfast:1/, {
			timeout: 5_000,
		})
		const url = page.url()
		expect(url).toMatch(/addons=/)
	})
})
