import { expect, type Page, test } from '@playwright/test'

/**
 * M9.5 Phase A — visual smoke. Captures full-page screenshots of every page
 * touched by the visual-foundation pass:
 *   - tenant dashboard
 *   - chessboard (EmptyState applies when zero roomTypes)
 *   - receivables (zero invoices = EmptyState; error renders ErrorState)
 *   - admin/notifications, admin/migration-registrations, admin/tax (each
 *     swapped destructive Alert → ErrorState)
 *
 * Each route is also re-shot in dark theme to verify Sochi-blue dark variant
 * + tonal elevation overlays render. The spec runs in the `chromium`
 * project so it gets the storageState from auth.setup.ts (fresh tenant +
 * wizard already complete).
 *
 * Outputs to `.artifacts/m9_5_phase_a/`. Console errors fail the run.
 */

const OUT = '.artifacts/m9_5_phase_a'

/**
 * Wait for any in-flight cross-document View Transition to complete before
 * snapshotting — without this, `defaultViewTransition: true` (M9.5 Phase A)
 * captures a half-faded composite of old + new DOM, which reads as washed-out
 * tones in screenshots and is indistinguishable from a real contrast bug.
 */
async function settle(page: Page) {
	await page.waitForLoadState('networkidle')
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() =>
					requestAnimationFrame(() => setTimeout(() => resolve(), 400)),
				)
			}),
	)
}

/**
 * Toggle .dark class and wait long enough for the cross-fade view-transition
 * snapshot pseudo-elements to clear — without this, screenshots after class
 * toggle composite the OLD light frame with the NEW dark frame, producing
 * washed-out cards (false-positive looks like a contrast bug). 800 ms covers
 * Chromium default 250 ms transition plus jitter.
 */
async function forceDark(page: Page) {
	await page.evaluate(() => {
		document.documentElement.classList.add('dark')
	})
	await page.waitForTimeout(800)
}

test('M9.5 Phase A visual smoke — every touched route, light + dark', async ({ page }) => {
	const consoleErrors: string[] = []
	page.on('console', (msg) => {
		if (msg.type() === 'error') consoleErrors.push(msg.text())
	})
	page.on('pageerror', (err) => {
		consoleErrors.push(`pageerror: ${err.message}`)
	})

	// --- Land on tenant dashboard via redirect from `/` ---
	await page.goto('/')
	await page.waitForURL(/\/o\/[a-z0-9-]+\/?$/)
	const slugMatch = page.url().match(/\/o\/([a-z0-9-]+)/)
	if (!slugMatch) throw new Error(`could not extract slug from ${page.url()}`)
	const slug = slugMatch[1]

	await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
	await settle(page)
	await page.screenshot({ path: `${OUT}/01-dashboard-light.png`, fullPage: true })

	await page.goto(`/o/${slug}/grid`)
	await expect(page.getByRole('grid')).toBeVisible()
	await settle(page)
	await page.screenshot({ path: `${OUT}/02-chessboard-light.png`, fullPage: true })

	await page.goto(`/o/${slug}/receivables`)
	await settle(page)
	await page.screenshot({ path: `${OUT}/03-receivables-light.png`, fullPage: true })

	await page.goto(`/o/${slug}/admin/notifications`)
	await settle(page)
	await page.screenshot({ path: `${OUT}/04-notifications-light.png`, fullPage: true })

	await page.goto(`/o/${slug}/admin/migration-registrations`)
	await settle(page)
	await page.screenshot({ path: `${OUT}/05-migration-registrations-light.png`, fullPage: true })

	await page.goto(`/o/${slug}/admin/tax`)
	await settle(page)
	await page.screenshot({ path: `${OUT}/06-admin-tax-light.png`, fullPage: true })

	// --- Dark theme cross-check (re-apply class after each goto: navigation
	// remounts the document, so dark must be re-asserted) ---
	await page.goto(`/o/${slug}/`)
	await settle(page)
	await forceDark(page)
	await page.screenshot({ path: `${OUT}/07-dashboard-dark.png`, fullPage: true })

	await page.goto(`/o/${slug}/receivables`)
	await settle(page)
	await forceDark(page)
	await page.screenshot({ path: `${OUT}/08-receivables-dark.png`, fullPage: true })

	await page.goto(`/o/${slug}/admin/tax`)
	await settle(page)
	await forceDark(page)
	await page.screenshot({ path: `${OUT}/09-admin-tax-dark.png`, fullPage: true })

	// --- Open ModeToggle DropdownMenu — verifies @starting-style enter animation
	// + radix Popper portal renders against light theme baseline. Screenshot
	// captures rendered dropdown с 3 theme options live. ---
	await page.evaluate(() => document.documentElement.classList.remove('dark'))
	await page.goto(`/o/${slug}/`)
	await settle(page)
	await page.getByRole('button', { name: /Тема оформления/ }).click()
	await page.waitForTimeout(300)
	await page.screenshot({ path: `${OUT}/10-mode-toggle-open.png`, fullPage: true })

	expect(consoleErrors, `unexpected console errors: ${consoleErrors.join('\n')}`).toEqual([])
})
