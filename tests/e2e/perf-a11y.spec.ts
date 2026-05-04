/**
 * Comprehensive a11y matrix — M9.widget.7 / A5.3.
 *
 * Per `plans/m9_widget_7_canonical.md` §4 + §5:
 *   matrix = surfaces × themes × viewports
 *          = 4 × 3 × 4 = 48 axe scans + 4 visual snapshots (D14 Cyrillic) + 0 blanket-disable.
 *
 * **Surfaces (4):**
 *   1. `/widget/demo-sirius` — Screen 1 (search & pick)
 *   2. `/widget/demo-sirius/demo-prop-sirius-main` — Screen 2 (property details)
 *   3. `/widget/demo-sirius/demo-prop-sirius-main/extras?checkIn=...` — Extras
 *   4. iframe HTML wrapper (`{API}/api/embed/v1/iframe/demo-sirius/demo-prop-sirius-main.html`)
 *
 * **Themes (3):**
 *   - `light` — default (no init)
 *   - `dark` — `.dark` class on `<html>` + localStorage `horeca-theme=dark`
 *   - `forced-colors` — `page.emulateMedia({ forcedColors: 'active' })` (D14)
 *
 * **Viewports (4):**
 *   - 320 (small mobile, smallest supported)
 *   - 768 (tablet)
 *   - 1024 (small desktop)
 *   - 1440 (desktop)
 *
 * **D16 tuple-allowlist (no blanket disable):**
 *   - `tests/axe-known-noise.ts` — empty baseline; entries require code review.
 *   - `disableRules: []` BANNED in this spec.
 *
 * **D14 forced-colors visual smoke (Cyrillic glyph-drop):**
 *   - `toHaveScreenshot('forced-colors-{viewport}.png', { maxDiffPixelRatio: 0.05 })`
 *   - Catches Segoe UI Variable Cyrillic ligature drop on Windows forced-colors.
 *
 * **Pragmatics:**
 *   - 48 cells × ~5s each ≈ 4 min serially. Heavy — runs post-push only.
 *   - Skipped if `PLAYWRIGHT_SKIP_A11Y_MATRIX=1` (local fast iteration).
 */

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { filterKnownNoise, WCAG_AA_TAGS } from '../axe-known-noise.ts'

const SKIP_MATRIX = process.env.PLAYWRIGHT_SKIP_A11Y_MATRIX === '1'
const API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8787'

// Future-proof check-in: 30 days out → never falls before today as the suite ages.
function plus30Days(): { checkIn: string; checkOut: string } {
	const now = new Date()
	now.setUTCHours(0, 0, 0, 0)
	const ci = new Date(now)
	ci.setUTCDate(ci.getUTCDate() + 30)
	const co = new Date(ci)
	co.setUTCDate(co.getUTCDate() + 2)
	const fmt = (d: Date) =>
		`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
	return { checkIn: fmt(ci), checkOut: fmt(co) }
}

const { checkIn, checkOut } = plus30Days()

interface Surface {
	readonly name: string
	readonly url: string
	/** True if URL is fully-qualified (skip baseURL). Used for backend iframe. */
	readonly fullUrl?: boolean
	/**
	 * Locator that confirms surface has rendered before axe scan.
	 * Selector strings — Playwright `page.locator(selector)`.
	 */
	readonly readyLocator: string
}

const SURFACES: readonly Surface[] = [
	{
		name: 'widget-search',
		url: '/widget/demo-sirius',
		readyLocator: 'h1',
	},
	{
		name: 'widget-property',
		url: '/widget/demo-sirius/demo-prop-sirius-main',
		readyLocator: 'h1',
	},
	{
		name: 'widget-extras',
		url: `/widget/demo-sirius/demo-prop-sirius-main/extras?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`,
		readyLocator: 'h1',
	},
	{
		name: 'embed-iframe',
		url: `${API_URL}/api/embed/v1/iframe/demo-sirius/demo-prop-sirius-main.html`,
		fullUrl: true,
		readyLocator: '[data-testid="widget-cta"]',
	},
] as const

interface Viewport {
	readonly name: '320' | '768' | '1024' | '1440'
	readonly width: number
	readonly height: number
}

const VIEWPORTS: readonly Viewport[] = [
	{ name: '320', width: 320, height: 568 },
	{ name: '768', width: 768, height: 1024 },
	{ name: '1024', width: 1024, height: 768 },
	{ name: '1440', width: 1440, height: 900 },
] as const

type ThemeName = 'light' | 'dark' | 'forced-colors'
const THEMES: readonly ThemeName[] = ['light', 'dark', 'forced-colors'] as const

test.describe('a11y matrix — surfaces × themes × viewports (D16 tuple-allowlist)', () => {
	test.skip(SKIP_MATRIX, 'PLAYWRIGHT_SKIP_A11Y_MATRIX=1 set')

	for (const surface of SURFACES) {
		for (const theme of THEMES) {
			for (const vp of VIEWPORTS) {
				test(`[A11Y ${surface.name}/${theme}/${vp.name}] axe-pass`, async ({ browser }) => {
					// Fresh context per cell — theme + forcedColors must NOT leak across cells.
					const ctx = await browser.newContext({
						viewport: { width: vp.width, height: vp.height },
						colorScheme: theme === 'dark' ? 'dark' : 'light',
						forcedColors: theme === 'forced-colors' ? 'active' : 'none',
					})
					const page = await ctx.newPage()

					if (theme === 'dark') {
						await page.addInitScript(() => {
							document.documentElement.classList.add('dark')
							localStorage.setItem('horeca-theme', 'dark')
						})
					}

					try {
						const response = await page.goto(surface.url)
						// 200 (HTML) for SPA routes; 200 for iframe wrapper.
						expect(response?.status() ?? 0, `${surface.url} should return 2xx`).toBeLessThan(400)

						// For iframe wrapper, wait for Web Component to register before scan.
						if (surface.name === 'embed-iframe') {
							await page.waitForFunction(
								() => Boolean(customElements.get('sochi-booking-widget-v1')),
								null,
								{ timeout: 15_000 },
							)
						}

						await expect(page.locator(surface.readyLocator)).toBeVisible({ timeout: 10_000 })

						const results = await new AxeBuilder({ page })
							.withTags([...WCAG_AA_TAGS])
							.analyze()
						const filtered = filterKnownNoise(results.violations)
						if (filtered.length > 0) {
							// eslint-disable-next-line no-console
							console.error(
								`axe violations [${surface.name}/${theme}/${vp.name}]:`,
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
	}
})

// ---------------------------------------------------------------------------
// D14 — forced-colors visual smoke (Cyrillic glyph-drop catch).
// ---------------------------------------------------------------------------

test.describe('forced-colors visual smoke (D14 Cyrillic)', () => {
	test.skip(SKIP_MATRIX, 'PLAYWRIGHT_SKIP_A11Y_MATRIX=1 set')

	// Visual smoke на 1 surface (Screen 1) × 4 viewports под forced-colors.
	// Catches Segoe UI Variable Cyrillic ligature drop on Windows forced-colors
	// mode — axe color-contrast rule SKIPS forced-colors by design (per axe-core
	// 4.11 spec) → only visual diff catches glyph-drop regressions.
	for (const vp of VIEWPORTS) {
		test(`[VIS-FC ${vp.name}] forced-colors visual snapshot @ /widget/demo-sirius`, async ({
			browser,
		}) => {
			const ctx = await browser.newContext({
				viewport: { width: vp.width, height: vp.height },
				forcedColors: 'active',
			})
			const page = await ctx.newPage()
			try {
				await page.goto('/widget/demo-sirius')
				await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 })
				await expect(page).toHaveScreenshot(`forced-colors-${vp.name}.png`, {
					maxDiffPixelRatio: 0.05,
				})
			} finally {
				await ctx.close()
			}
		})
	}
})
