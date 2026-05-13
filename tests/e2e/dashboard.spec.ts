import AxeBuilder from '@axe-core/playwright'
import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'
/**
 * Dashboard — empirical real-browser e2e + axe WCAG 2.2 AA audit
 * (A.bis.3 Layer 4+5 mandatory per C37 canon — `feedback_layer_4_5_mandatory_per_subphase.md`).
 *
 * Auth: owner storageState (auth.setup.ts creates fresh tenant с 1 property
 * + 1 roomType + 2 rooms + 1 ratePlan, lands on `/o/{slug}/`). Owner sees
 * all 4 KPI cards + Recent activity + Alerts.
 *
 * Hunts (per `feedback_strict_tests.md` adversarial + `feedback_no_halfway.md`):
 *   1. Dashboard route resolves to <main> (NOT the old nav-tile layout)
 *   2. KPI strip mounts with exactly 4 cards (owner role × full RBAC)
 *   3. Each KPI card has data-state ∈ {loading, error, value}
 *   4. Recent activity section mounts (live /activity/recent endpoint)
 *   5. Alerts section mounts (live /admin/notifications?status=failed)
 *   6. No legacy nav tiles to /grid, /receivables, /admin/tax, /admin/notifications
 *      remain в page body — those moved to sidebar at A.bis.2
 *   7. axe-core WCAG 2.2 AA — zero violations on dashboard (C37 + axe gate canon)
 */

test.describe('Dashboard — composition + content', () => {
	test('owner — dashboard route renders <main> with KPI strip (4 cards) + activity + alerts', async ({
		page,
	}) => {
		await page.goto('/')
		// Page lands on /o/{slug}/ (the tenant dashboard).
		await expect(page).toHaveURL(/\/o\/[^/]+\/?$/)
		// h1 = organization name (rendered by DashboardPage header).
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
		// KPI strip section mounts.
		const kpiStrip = page.locator('[data-dashboard-section="kpi-strip"]')
		await expect(kpiStrip).toBeVisible()
		// 4 cards for owner: arrivals-today / in-house / open-balance / failed-notifications.
		const cards = kpiStrip.locator('[data-testid^="kpi-card-"]')
		await expect(cards).toHaveCount(4)
	})

	test('every KPI card resolves to data-state ∈ {loading, error, value} (no missing state)', async ({
		page,
	}) => {
		await page.goto('/')
		// Wait for the strip mount so count() doesn't race the React-Query initial
		// render — Playwright `count()` returns immediately, doesn't auto-await.
		const strip = page.locator('[data-dashboard-section="kpi-strip"]')
		await expect(strip).toBeVisible()
		const cards = strip.locator('[data-testid^="kpi-card-"]')
		await expect(cards).toHaveCount(4)
		const count = await cards.count()
		for (let i = 0; i < count; i++) {
			const state = await cards.nth(i).getAttribute('data-state')
			expect(['loading', 'error', 'value']).toContain(state)
		}
	})

	test('Recent activity section mounts with heading «Недавние события»', async ({ page }) => {
		await page.goto('/')
		const recent = page.locator('[data-dashboard-section="recent-activity"]')
		await expect(recent).toBeVisible()
		await expect(recent.getByRole('heading', { level: 2, name: 'Недавние события' })).toBeVisible()
	})

	test('Alerts section mounts with heading «Требует внимания» (owner has notification:read)', async ({
		page,
	}) => {
		await page.goto('/')
		const alerts = page.locator('[data-dashboard-section="alerts"]')
		await expect(alerts).toBeVisible()
		await expect(alerts.getByRole('heading', { level: 2, name: 'Требует внимания' })).toBeVisible()
	})

	test('NO legacy nav-tile links to /grid, /receivables, /admin/tax remain in <main>', async ({
		page,
	}) => {
		await page.goto('/')
		const main = page.locator('main')
		await expect(main).toBeVisible()
		// Legacy nav tiles would have rendered <a> with `href="/o/<slug>/grid"`
		// directly inside <main>. After A.bis.3 they live in the sidebar (a
		// different DOM subtree), so <main> must not contain them anymore.
		// Mutation gate: if route refactor regressed to the old layout, these
		// links would re-appear.
		const url = page.url()
		const slugMatch = url.match(/\/o\/([^/]+)/)
		expect(slugMatch?.[1]).toBeTruthy()
		const slug = slugMatch![1]
		const navHrefs = [`/o/${slug}/grid`, `/o/${slug}/receivables`, `/o/${slug}/admin/tax`]
		for (const href of navHrefs) {
			await expect(main.locator(`a[href="${href}"]`)).toHaveCount(0)
		}
	})
})

test.describe('Dashboard — axe-core WCAG 2.2 AA audit', () => {
	test('dashboard <main> passes WCAG 2.2 AA (zero violations)', async ({ page }) => {
		await page.goto('/')
		await expect(page.locator('main')).toBeVisible()
		// Wait for KPI strip mount so axe scans the real composition (not the
		// pre-mount blank state which has nothing to evaluate).
		await expect(page.locator('[data-dashboard-section="kpi-strip"]')).toBeVisible()
		await expect(page.locator('[data-dashboard-section="recent-activity"]')).toBeVisible()

		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()

		if (results.violations.length > 0) {
			console.error('dashboard axe violations:', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})
})
