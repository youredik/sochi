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
		// Read all aria-labels off the rendered <a> rows.
		const labels = await page.locator('[data-section-id]').evaluateAll((els) =>
			els.map((el) => el.getAttribute('aria-label')),
		)
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
		await expect(page.locator('[data-section-id="grid"]')).toHaveAttribute(
			'aria-current',
			'page',
		)
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
			console.error(
				'admin-sidebar axe violations:',
				JSON.stringify(results.violations, null, 2),
			)
		}
		expect(results.violations).toEqual([])
	})
})
