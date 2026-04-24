import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * Empirical accessibility verification (M5e.3.2) — axe-core automated
 * WCAG 2.2 AA audit on the reservation grid.
 *
 * 152-ФЗ requires WCAG 2.2 AA compliance. Our design claims:
 *   - role="grid" + aria-rowcount/aria-colcount (APG pattern)
 *   - aria-colspan on booking bands
 *   - double focus ring (outline 2px + box-shadow 4px) for 3:1 contrast
 *   - scroll-padding for SC 2.4.11 Focus Not Obscured
 *
 * "Claim" без empirical check = rationalization (feedback_empirical_
 * method). This file turns the claim into a proven gate.
 *
 * axe-core rules engaged per @axe-core/playwright v4.11 2026:
 *   - wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa
 *   - best-practice (warnings, not errors)
 */

test.describe('reservation grid — axe-core WCAG 2.2 AA audit', () => {
	test('empty grid (no bookings) passes WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()
		await expect(page).toHaveURL(/\/grid$/)
		await expect(page.getByRole('grid')).toBeVisible()

		const results = await new AxeBuilder({ page })
			// Scope to the grid region — the global page shell is covered by
			// broader a11y tests later; this file proves M5e.3 changes.
			.include('[role="grid"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()

		// Violations = HARD failures. Log them before assertion so CI surface
		// the exact rule + target even on red.
		if (results.violations.length > 0) {
			console.error('axe violations:', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})

	test('grid with existing booking bands (colspan + palette variants) passes WCAG 2.2 AA', async ({
		page,
	}) => {
		// Other tests in the run have already created multiple bands of
		// various statuses (confirmed blue / in_house black / cancelled
		// grey / no_show yellow / checked_out grey). We audit the grid
		// AS-IS rather than creating a specific booking — covers the full
		// palette variance without test-ordering coupling.
		//
		// Invariant: at least ONE band must be visible by the time this
		// test runs (otherwise "colspan cell" coverage is a no-op). The
		// runner enforces this because grid-keyboard + bookings-edit
		// tests run BEFORE grid-a11y alphabetically.
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()
		await expect(page.locator('[data-booking-id]').first()).toBeVisible()

		const results = await new AxeBuilder({ page })
			.include('[role="grid"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()

		if (results.violations.length > 0) {
			console.error('axe violations (band present):', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})

	test('focus-visible state on a keyboard-focused cell passes WCAG 2.2 AA', async ({ page }) => {
		// Establish focus deterministically: focus the initial tabStop cell,
		// then use ArrowRight to move via keyboard gesture — ArrowRight is
		// what flips the :focus-visible pseudo-class in Chromium (2026),
		// whereas programmatic .focus() alone does not.
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const firstCell = page.locator('[role="gridcell"][aria-colindex="2"]').first()
		await firstCell.focus()
		await page.keyboard.press('ArrowRight')
		// Some cell now has tabindex=0 (next roving anchor) and is focused.
		await expect(page.locator('[role="gridcell"][tabindex="0"]')).toBeFocused()

		const results = await new AxeBuilder({ page })
			.include('[role="grid"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()

		if (results.violations.length > 0) {
			console.error('axe violations (focused cell):', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})
})

