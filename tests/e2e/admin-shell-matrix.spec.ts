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
	await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
}

/**
 * Assert that the right app-shell surface is mounted before axe scan / visual
 * snapshot — guards against the failure mode where axe «passes» on a page
 * that doesn't actually contain the sidebar (false-positive coverage). At
 * <768 px the persistent sidebar is NOT in DOM (offcanvas-closed); the
 * mobile trigger lives in `<header className="md:hidden">`. At >=768 px the
 * persistent sidebar is mounted with `md:block` (data-slot="sidebar" on the
 * desktop wrapper).
 */
async function assertShellSurfaceMounted(page: Page, viewportWidth: number) {
	if (viewportWidth < 768) {
		await expect(page.locator('[data-slot="sidebar-trigger"]').first()).toBeVisible()
	} else {
		await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
	}
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
					// A.bis.5 fix-up — bug A4.2 from senior bug hunt 2026-05-12:
					// guard that the SHELL SURFACE we name in the test ID is
					// actually mounted before axe scan, otherwise the cell
					// might pass on a page that doesn't even contain the
					// sidebar (false-positive coverage). Mobile <768 px =
					// trigger button in `<header className="md:hidden">`;
					// desktop ≥768 px = persistent `[data-slot="sidebar"]`.
					await assertShellSurfaceMounted(page, vp.width)

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
				console.error('axe violations [mobile-offcanvas-OPEN]:', JSON.stringify(filtered, null, 2))
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
				console.error('axe violations [desktop-collapsed-icon]:', JSON.stringify(filtered, null, 2))
			}
			expect(filtered).toEqual([])
		} finally {
			await ctx.close()
		}
	})
})

// ---------------------------------------------------------------------------
// Visual smoke — 4 viewports × full-page Playwright snapshot.
//
// A.bis.5 fix-up — bug A4.1 from senior bug hunt 2026-05-12: the prior
// implementation snapshot-scoped a `[data-slot="sidebar"]` locator (sidebar
// has fixed `16rem` width per A.bis.1 D19), so 3 desktop snapshots
// (768/1024/1440) were byte-identical and provided false-positive 4-viewport
// coverage. Restructured to full-page snapshots per viewport with strategic
// volatile-region masks — now each baseline captures the actual responsive
// layout (mobile trigger bar appears at 320 only; sidebar gap at md+;
// dashboard content reflows; `<header className="md:hidden">` toggles).
//
// Masks (volatile content that mutates run-to-run без structural meaning):
//   • [data-slot="sidebar-header"] — OrgSwitcher org name timestamped from
//     auth.setup.ts fresh-tenant signup.
//   • [data-dashboard-section="kpi-strip"] — KPI numeric values depend on
//     seed data (arrivals/in-house/balance vary).
//   • [data-dashboard-section="recent-activity"] — relative timestamps
//     («2 мин. назад» etc) drift seconds-to-seconds.
//   • [data-slot="demo-mode-badge"] — pill string (LIVE / DEMO) — kept
//     UNMASKED since auth.setup.ts pins to production mode и regression
//     here matters (demo/live UX divergence).
// ---------------------------------------------------------------------------

test.describe('admin-shell visual smoke — 4 viewports (full-page)', () => {
	test.skip(SKIP_MATRIX, 'PLAYWRIGHT_SKIP_A11Y_MATRIX=1 set')

	for (const vp of VIEWPORTS) {
		test(`[VIS admin-shell/${vp.name}] full-page responsive snapshot`, async ({ browser }) => {
			const ctx = await browser.newContext({
				storageState: STORAGE_STATE,
				viewport: { width: vp.width, height: vp.height },
			})
			const page = await ctx.newPage()
			try {
				await page.goto('/')
				await expect(page).toHaveURL(/\/o\/[^/]+\/?$/)
				await settle(page)
				await assertShellSurfaceMounted(page, vp.width)
				// fullPage:false (default) — capture only the viewport window;
				// fullPage:true would scroll-render the entire document and lose
				// the «what does the operator see in the first paint» semantic.
				await expect(page).toHaveScreenshot(`admin-shell-${vp.name}-fullpage.png`, {
					maxDiffPixelRatio: 0.05,
					mask: [
						page.locator('[data-slot="sidebar-header"]'),
						page.locator('[data-dashboard-section="kpi-strip"]'),
						page.locator('[data-dashboard-section="recent-activity"]'),
					],
				})
			} finally {
				await ctx.close()
			}
		})
	}
})

// ---------------------------------------------------------------------------
// D12 adversarial paths (A.bis.5 fix-up — bug A4.3 from senior bug hunt
// 2026-05-12): the prior `admin-sidebar.spec.ts` covered only Enter-close.
// Production canon for a modal Sheet/Dialog requires ALL canonical escape
// routes work: Esc, Tab focus-trap (no leak outside sheet), Shift+Tab
// reverse boundary, click-outside-overlay. PATCH-D12 must hold under each.
// ---------------------------------------------------------------------------

test.describe('admin-shell D12 mobile sheet — adversarial escape routes', () => {
	test('Esc key closes the mobile sheet (Radix Dialog canonical)', async ({ browser }) => {
		const ctx = await browser.newContext({
			storageState: STORAGE_STATE,
			viewport: { width: 320, height: 700 },
		})
		const page = await ctx.newPage()
		try {
			await page.goto('/')
			await settle(page)
			await page.locator('[data-slot="sidebar-trigger"]').first().click()
			const mobileSheet = page.locator('[data-mobile="true"][data-slot="sidebar"]')
			await expect(mobileSheet).toBeVisible()
			await page.keyboard.press('Escape')
			await expect(mobileSheet).toBeHidden()
		} finally {
			await ctx.close()
		}
	})

	test('focus is trapped inside the sheet — Tab cycle stays within Sheet', async ({ browser }) => {
		const ctx = await browser.newContext({
			storageState: STORAGE_STATE,
			viewport: { width: 320, height: 700 },
		})
		const page = await ctx.newPage()
		try {
			await page.goto('/')
			await settle(page)
			await page.locator('[data-slot="sidebar-trigger"]').first().click()
			const mobileSheet = page.locator('[data-mobile="true"][data-slot="sidebar"]')
			await expect(mobileSheet).toBeVisible()
			// Press Tab 20× — focus must stay within the sheet on every step
			// (Radix Dialog focus-trap canon). If the trap leaks, a Tab will
			// move into the underlying `<header>` mobile trigger or dashboard
			// content — those are outside the Sheet's DOM subtree.
			for (let i = 0; i < 20; i++) {
				await page.keyboard.press('Tab')
				const inside = await page.evaluate(() => {
					const sheet = document.querySelector(
						'[data-mobile="true"][data-slot="sidebar"]',
					) as HTMLElement | null
					if (!sheet) return false
					const active = document.activeElement
					return Boolean(active && sheet.contains(active))
				})
				expect(inside).toBe(true)
			}
		} finally {
			await ctx.close()
		}
	})

	test('Shift+Tab reverse cycle also stays within the sheet (boundary guard)', async ({
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
			await page.locator('[data-slot="sidebar-trigger"]').first().click()
			const mobileSheet = page.locator('[data-mobile="true"][data-slot="sidebar"]')
			await expect(mobileSheet).toBeVisible()
			for (let i = 0; i < 20; i++) {
				await page.keyboard.press('Shift+Tab')
				const inside = await page.evaluate(() => {
					const sheet = document.querySelector(
						'[data-mobile="true"][data-slot="sidebar"]',
					) as HTMLElement | null
					if (!sheet) return false
					const active = document.activeElement
					return Boolean(active && sheet.contains(active))
				})
				expect(inside).toBe(true)
			}
		} finally {
			await ctx.close()
		}
	})
})
