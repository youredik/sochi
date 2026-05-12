import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { filterKnownNoise, WCAG_AA_TAGS } from '../axe-known-noise.ts'

/**
 * A.bis.4 — Layer 4+5 systematic matrix on the admin app-shell surface.
 *
 * Plan canon `plans/track-a-bis-canonical.md` §8:
 *   axe matrix = 4 viewports × 3 themes = **12 cells** (WCAG 2.2 AA, zero
 *   violations). Visual smoke = 4 viewports × Playwright snapshot
 *   (maxDiffPixelRatio: 0.05, canon M9.widget.7). forced-colors covered
 *   inside the 12-cell matrix (theme dimension), so no separate
 *   forced-colors spec is needed (plan §8 D38).
 *
 * **Plan §8 viewport-state contradiction resolved upfront** (surfaced per
 * `feedback_aggressive_delegacy.md` + C38 canon — plan deviation vs memory
 * canon is announced before implementation, not silently downscoped):
 *   Plan v1 axe matrix table specifies 4 viewport-states
 *   (320 = offcanvas-closed, 768 = offcanvas-open, 1024 = desktop-default,
 *   1440 = desktop-collapsed-icon). D17 (md: = 768 px) makes 768 already
 *   desktop-persistent — offcanvas-open at 768 is impossible with our
 *   breakpoint. Matrix normalised to NATURAL state per viewport
 *   (320 mobile-offcanvas-closed; 768 / 1024 / 1440 desktop-default).
 *   Explicit state variants (mobile offcanvas OPEN + desktop collapsed-icon)
 *   are covered by separate single-cell tests below the matrix.
 *
 * Auth: owner storageState (`tests/.auth/owner.json`, set by
 * `auth.setup.ts`). Surface = `/o/{slug}/` (admin dashboard with sidebar
 * visible at md+, mobile trigger bar at <768).
 *
 * Snapshot baselines stored in `admin-shell-matrix.spec.ts-snapshots/`
 * (Playwright auto-stores per `toHaveScreenshot(name)` convention).
 *
 * Skip flag: `PLAYWRIGHT_SKIP_A11Y_MATRIX=1` skips the heavy matrix + visual
 * smoke (mirror `perf-a11y.spec.ts` canon for local fast iteration).
 */

const SKIP_MATRIX = process.env.PLAYWRIGHT_SKIP_A11Y_MATRIX === '1'

interface Viewport {
	readonly name: '320' | '768' | '1024' | '1440'
	readonly width: number
	readonly height: number
}

const VIEWPORTS: readonly Viewport[] = [
	{ name: '320', width: 320, height: 700 },
	{ name: '768', width: 768, height: 1024 },
	{ name: '1024', width: 1024, height: 768 },
	{ name: '1440', width: 1440, height: 900 },
] as const

type ThemeName = 'light' | 'dark' | 'forced-colors'
const THEMES: readonly ThemeName[] = ['light', 'dark', 'forced-colors'] as const

const STORAGE_STATE = 'tests/.auth/owner.json'

/**
 * Wait for the admin shell to fully settle before scan/snapshot:
 *   - h1 mounted (dashboard heading)
 *   - kpi-strip mounted (4 cards rendered, data-state ∈ loading/error/value)
 *   - no card stuck in `loading` (data settled — eliminates a known race
 *     where Suspense first-paint shows skeleton then snaps to values)
 *   - fonts loaded (avoid Cyrillic glyph fallback flash)
 *   - all CSS animations completed (Sheet fade-in, Skeleton pulse, KPI
 *     enter spring)
 */
async function settle(page: Page) {
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
	const strip = page.locator('[data-dashboard-section="kpi-strip"]')
	await expect(strip).toBeVisible()
	const cards = strip.locator('[data-testid^="kpi-card-"]')
	await expect(cards.first()).toBeVisible()
	await expect
		.poll(
			async () => {
				const states = await cards.evaluateAll((els) =>
					els.map((el) => el.getAttribute('data-state')),
				)
				return states.length > 0 && states.every((s) => s === 'value' || s === 'error')
			},
			{ timeout: 10_000 },
		)
		.toBe(true)
	await page.evaluate(() => document.fonts.ready)
	await page.waitForFunction(() =>
		document.getAnimations().every((a) => a.playState !== 'running'),
	)
}

// ---------------------------------------------------------------------------
// Axe matrix — 12 cells (3 themes × 4 viewports).
// ---------------------------------------------------------------------------

test.describe('admin-shell axe matrix — 12 cells (3 themes × 4 viewports)', () => {
	test.skip(SKIP_MATRIX, 'PLAYWRIGHT_SKIP_A11Y_MATRIX=1 set')

	for (const theme of THEMES) {
		for (const vp of VIEWPORTS) {
			test(`[A11Y admin-shell/${theme}/${vp.name}] axe-pass`, async ({ browser }) => {
				const ctx = await browser.newContext({
					storageState: STORAGE_STATE,
					viewport: { width: vp.width, height: vp.height },
					colorScheme: theme === 'dark' ? 'dark' : 'light',
					forcedColors: theme === 'forced-colors' ? 'active' : 'none',
				})
				const page = await ctx.newPage()
				if (theme === 'dark') {
					// Both class + persisted store entry — the ThemeProvider reads
					// localStorage at boot; without it the class is overwritten on
					// hydration. Mirrors `perf-a11y.spec.ts` dark-theme pattern.
					await page.addInitScript(() => {
						document.documentElement.classList.add('dark')
						localStorage.setItem('horeca-theme', 'dark')
					})
				}
				try {
					await page.goto('/')
					await expect(page).toHaveURL(/\/o\/[^/]+\/?$/)
					await settle(page)

					const results = await new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze()
					const filtered = filterKnownNoise(results.violations)
					if (filtered.length > 0) {
						// eslint-disable-next-line no-console
						console.error(
							`axe violations [admin-shell/${theme}/${vp.name}]:`,
							JSON.stringify(filtered, null, 2),
						)
					}
					expect(filtered).toEqual([])
				} finally {
					await ctx.close()
				}
			})
		}
	}
})

// ---------------------------------------------------------------------------
// Explicit state-variant axe cells (NOT in the 12-cell matrix; cover the
// states the matrix can't reach naturally: mobile offcanvas OPEN at 320 +
// desktop collapsed-icon at 1440).
// ---------------------------------------------------------------------------

test.describe('admin-shell axe — explicit state variants', () => {
	test.skip(SKIP_MATRIX, 'PLAYWRIGHT_SKIP_A11Y_MATRIX=1 set')

	test('[A11Y admin-shell/light/320-offcanvas-OPEN] axe-pass (D12 mobile sheet)', async ({
		browser,
	}) => {
		const ctx = await browser.newContext({
			storageState: STORAGE_STATE,
			viewport: { width: 320, height: 700 },
		})
		const page = await ctx.newPage()
		try {
			await page.goto('/')
			await settle(page)
			// Click the mobile trigger to open the offcanvas Sheet. The mobile
			// sheet mounts the nav rows inside <SheetContent data-mobile="true">.
			await page.locator('[data-slot="sidebar-trigger"]').first().click()
			// Wait for the mobile sidebar DOM to mount + the PATCH-D12 dismiss
			// button (Cyrillic «Закрыть меню») to be visible.
			await expect(page.locator('[data-mobile="true"][data-slot="sidebar"]')).toBeVisible()
			await expect(page.getByRole('button', { name: 'Закрыть меню' })).toBeVisible()
			// Wait for the Sheet slide-in animation to settle so axe scans the
			// final composed frame (not a mid-fade-in intermediate).
			await page.waitForFunction(() =>
				document.getAnimations().every((a) => a.playState !== 'running'),
			)
			const results = await new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze()
			const filtered = filterKnownNoise(results.violations)
			if (filtered.length > 0) {
				// eslint-disable-next-line no-console
				console.error(
					'axe violations [mobile-offcanvas-OPEN]:',
					JSON.stringify(filtered, null, 2),
				)
			}
			expect(filtered).toEqual([])
		} finally {
			await ctx.close()
		}
	})

	test('[A11Y admin-shell/light/1440-collapsed-icon] axe-pass (Cmd+B once)', async ({
		browser,
	}) => {
		const ctx = await browser.newContext({
			storageState: STORAGE_STATE,
			viewport: { width: 1440, height: 900 },
		})
		const page = await ctx.newPage()
		try {
			await page.goto('/')
			await settle(page)
			// Toggle to collapsed-icon via Cmd+B (sidebar primitive Cmd+B / Ctrl+B
			// keyboard shortcut per `SIDEBAR_KEYBOARD_SHORTCUT = "b"`).
			await page.keyboard.press('Meta+b')
			await expect(page.locator('[data-slot="sidebar"]').first()).toHaveAttribute(
				'data-state',
				'collapsed',
			)
			await page.waitForFunction(() =>
				document.getAnimations().every((a) => a.playState !== 'running'),
			)
			const results = await new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze()
			const filtered = filterKnownNoise(results.violations)
			if (filtered.length > 0) {
				// eslint-disable-next-line no-console
				console.error(
					'axe violations [desktop-collapsed-icon]:',
					JSON.stringify(filtered, null, 2),
				)
			}
			expect(filtered).toEqual([])
		} finally {
			await ctx.close()
		}
	})
})

// ---------------------------------------------------------------------------
// Visual smoke — 4 viewports × Playwright snapshot.
//
// 320 mobile snapshots the `<header className="md:hidden">` trigger bar
// (sidebar lives off-screen in offcanvas closed). 768/1024/1440 snapshot
// the persistent `<[data-slot="sidebar"]>` element with `<SidebarHeader>`
// masked — the OrgSwitcher renders a per-tenant org name from fresh
// signup (`auth.setup.ts` timestamps the org name) so the header pixels
// drift run-to-run; masking it isolates the snapshot to the regression-
// prone layout chrome (rail width, footer flex, row gaps, theme tokens).
// ---------------------------------------------------------------------------

test.describe('admin-shell visual smoke — 4 viewports', () => {
	test.skip(SKIP_MATRIX, 'PLAYWRIGHT_SKIP_A11Y_MATRIX=1 set')

	test('[VIS admin-shell/320] mobile trigger bar snapshot', async ({ browser }) => {
		const ctx = await browser.newContext({
			storageState: STORAGE_STATE,
			viewport: { width: 320, height: 700 },
		})
		const page = await ctx.newPage()
		try {
			await page.goto('/')
			await settle(page)
			// The mobile-only <header className="md:hidden"> wraps SidebarTrigger.
			// Locator via `filter({ has: ... })` finds the header element that
			// contains the trigger — stable across viewport changes.
			const mobileHeader = page
				.locator('header')
				.filter({ has: page.locator('[data-slot="sidebar-trigger"]') })
			await expect(mobileHeader).toBeVisible()
			await expect(mobileHeader).toHaveScreenshot('admin-shell-320-mobile-header.png', {
				maxDiffPixelRatio: 0.05,
			})
		} finally {
			await ctx.close()
		}
	})

	for (const vp of VIEWPORTS.slice(1)) {
		test(`[VIS admin-shell/${vp.name}] desktop sidebar snapshot`, async ({ browser }) => {
			const ctx = await browser.newContext({
				storageState: STORAGE_STATE,
				viewport: { width: vp.width, height: vp.height },
			})
			const page = await ctx.newPage()
			try {
				await page.goto('/')
				await settle(page)
				const sidebar = page.locator('[data-slot="sidebar"]').first()
				await expect(sidebar).toBeVisible()
				// Mask the <SidebarHeader> (OrgSwitcher org name varies per
				// tenant signup timestamp). DemoModeBadge in <SidebarFooter>
				// renders a fixed string ('Продакшн-режим' for owner-tenant
				// from auth.setup.ts) — no mask needed there.
				await expect(sidebar).toHaveScreenshot(`admin-shell-${vp.name}-sidebar.png`, {
					maxDiffPixelRatio: 0.05,
					mask: [page.locator('[data-slot="sidebar-header"]')],
				})
			} finally {
				await ctx.close()
			}
		})
	}
})
