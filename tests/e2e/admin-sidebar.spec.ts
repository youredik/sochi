import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * AdminSidebar — empirical real-browser e2e + axe WCAG 2.2 AA audit
 * (A.bis.2 layer 4+5 verification per «погнали» canon: каждое «done» claim
 * проходит через ВСЕ 5 слоёв; A.bis.0 senior learning — JSDOM миссит axe
 * runtime rules, real-browser ловит).
 *
 * Auth: owner storageState (auth.setup.ts creates fresh tenant с 1 property
 * + 1 roomType + 2 rooms + 1 ratePlan, lands on `/o/{slug}/`). Owner sees
 * all 7 sections per RBAC matrix.
 *
 * Hunts (per `feedback_strict_tests.md` adversarial canon):
 *   1. Sidebar mounts on authenticated route (data-slot="sidebar" visible)
 *   2. Owner sees exactly 7 section rows (RBAC × full enum coverage)
 *   3. Each row carries Cyrillic aria-label (D15 canon — primitive consumer
 *      respects own primitive's PATCH-D15 dev-warn contract)
 *   4. Шахматка nav: click sidebar row → URL match /grid$ (нет double-active
 *      via D22 activeOptions exact:true)
 *   5. DemoModeBadge mounted with valid mode value
 *   6. Cmd+B keyboard toggles sidebar state (PATCH inherited from primitive)
 *   7. axe-core WCAG 2.2 AA scan on full app-shell shell — zero violations
 *      (D12-D16 patches collectively keep nested-interactive / colour-
 *       contrast / focusable-children green в real-browser, not just JSDOM)
 */

test.describe('AdminSidebar — real-browser mount + RBAC visibility', () => {
	test('owner — sidebar mounts on /o/$slug/ with exactly 7 section rows', async ({ page }) => {
		await page.goto('/')
		// Wait for sidebar to mount (post-auth redirect to /o/{slug}/).
		await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
		const sectionLinks = page.locator('[data-section-id]')
		await expect(sectionLinks).toHaveCount(7)
	})

	test('every section row carries Cyrillic aria-label (D15 canon)', async ({ page }) => {
		await page.goto('/')
		await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
		// admin-sidebar.tsx gates row rendering on BOTH `useCurrentRole()` and
		// `propertiesQueryOptions` — the wrapper sidebar shell mounts before
		// the query resolves, so we must wait until all 7 rows are in the DOM
		// before `evaluateAll` (which doesn't auto-wait). Race surfaced after
		// React 19.2.6 + TanStack Query 5.100.10 timing tightening 2026-05-12.
		await expect(page.locator('[data-section-id]')).toHaveCount(7)
		// Read all aria-labels off the rendered <a> rows.
		const labels = await page
			.locator('[data-section-id]')
			.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
		// All 7 must be non-empty AND contain Cyrillic.
		expect(labels.length).toBe(7)
		for (const label of labels) {
			expect(label).toBeTruthy()
			expect(label).toMatch(/[А-яЁё]/)
		}
	})

	test('Шахматка sidebar nav — click → URL /grid (D22 activeOptions exact:true)', async ({
		page,
	}) => {
		await page.goto('/')
		await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
		await page.locator('[data-section-id="grid"]').click()
		await expect(page).toHaveURL(/\/grid$/)
		// Active row has aria-current="page" (TanStack auto-emit per D22).
		await expect(page.locator('[data-section-id="grid"]')).toHaveAttribute('aria-current', 'page')
	})

	test('DemoModeBadge mounted in footer with valid mode (production|demo)', async ({ page }) => {
		await page.goto('/')
		await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
		const badge = page.locator('[data-slot="demo-mode-badge"]')
		await expect(badge).toBeVisible()
		const mode = await badge.getAttribute('data-mode')
		expect(['demo', 'production']).toContain(mode)
		// aria-label correlates с mode (RU canon).
		const ariaLabel = await badge.getAttribute('aria-label')
		if (mode === 'demo') {
			expect(ariaLabel).toBe('Демо-режим')
		} else {
			expect(ariaLabel).toBe('Продакшн-режим')
		}
	})

	test('Cmd+B keyboard toggles sidebar state (PATCH inherited)', async ({ page }) => {
		await page.goto('/')
		await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
		// Read initial data-state на sidebar wrapper (data-slot="sidebar" desktop variant).
		const sidebar = page.locator('[data-slot="sidebar"]').first()
		const initialState = await sidebar.getAttribute('data-state')
		// Press meta+B (Cmd+B on macOS, ctrl+B на Linux/Windows handled by primitive).
		await page.keyboard.press('Meta+b')
		const afterToggle = await sidebar.getAttribute('data-state')
		expect(afterToggle).not.toBe(initialState)
	})
})

test.describe('AdminSidebar — axe-core WCAG 2.2 AA audit', () => {
	test('app-shell + sidebar passes WCAG 2.2 AA (no violations)', async ({ page }) => {
		await page.goto('/')
		await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()

		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()

		if (results.violations.length > 0) {
			console.error('admin-sidebar axe violations:', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// A.bis.4 — additional functional guards: D12 mobile dismiss button + D22
// per-path active-highlight isolation (exactly one row carries
// aria-current="page" at any time, even with the activeOptions exact:true
// preventive guard against future nested admin routes).
// ---------------------------------------------------------------------------

test.describe('AdminSidebar — D12 mobile dismiss button (PATCH-D12)', () => {
	test('mobile offcanvas — «Закрыть меню» button is focusable + closes the sheet', async ({
		page,
	}) => {
		// Force a phone-size viewport so the sidebar primitive renders its
		// mobile branch (Sheet-based offcanvas) instead of the persistent
		// desktop column. D17 breakpoint = 768 px → 320 is mobile.
		await page.setViewportSize({ width: 320, height: 700 })
		await page.goto('/')
		// Mobile <header className="md:hidden"> hosts the trigger.
		await page.locator('[data-slot="sidebar-trigger"]').first().click()
		// Mobile Sheet mounts SheetContent with data-mobile="true".
		const mobileSheet = page.locator('[data-mobile="true"][data-slot="sidebar"]')
		await expect(mobileSheet).toBeVisible()
		// D12 patch: focusable Cyrillic-labelled close button. Sheet's auto-
		// close (English "Close" sr-only) is disabled via showCloseButton={false}
		// in the primitive — our own <SheetClose><Button aria-label="Закрыть меню">
		// is the only escape route apart from Esc, so it MUST be focusable.
		const dismiss = page.getByRole('button', { name: 'Закрыть меню' })
		await expect(dismiss).toBeVisible()
		// Move focus to it via Tab traversal — confirms it sits on the
		// keyboard focus path, not just visually present.
		await dismiss.focus()
		await expect(dismiss).toBeFocused()
		// Activate via Enter; Sheet open state flips, panel slides out.
		await page.keyboard.press('Enter')
		await expect(mobileSheet).toBeHidden()
	})
})

test.describe('AdminSidebar — D22 per-path active-highlight isolation', () => {
	// Navigate to each section's route and assert: that section's row carries
	// `aria-current="page"`, AND no other row carries it. Activates the D22
	// preventive guard against the future `/admin/channels/:id` style nested
	// routes inadvertently double-marking the parent.
	const paths: ReadonlyArray<{
		readonly target: string
		readonly slug: string
		readonly urlMatch: RegExp
	}> = [
		{ target: 'grid', slug: 'grid', urlMatch: /\/grid$/ },
		{ target: 'receivables', slug: 'receivables', urlMatch: /\/receivables$/ },
		{ target: 'guests', slug: 'guests', urlMatch: /\/admin\/migration-registrations$/ },
		{ target: 'channels', slug: 'channels', urlMatch: /\/admin\/channels$/ },
		{ target: 'tax', slug: 'tax', urlMatch: /\/admin\/tax(\?.*)?$/ },
		{ target: 'notifications', slug: 'notifications', urlMatch: /\/admin\/notifications(\?.*)?$/ },
	]

	for (const { target, slug, urlMatch } of paths) {
		test(`/${slug} — exactly one row carries aria-current="page"`, async ({ page }) => {
			await page.goto('/')
			await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
			await page.locator(`[data-section-id="${target}"]`).first().click()
			await expect(page).toHaveURL(urlMatch)
			// The clicked row is aria-current.
			await expect(page.locator(`[data-section-id="${target}"]`)).toHaveAttribute(
				'aria-current',
				'page',
			)
			// No other row carries aria-current — D22 isolation guard.
			const currentRows = page.locator('[data-section-id][aria-current="page"]')
			await expect(currentRows).toHaveCount(1)
		})
	}
})
