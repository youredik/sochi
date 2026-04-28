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

	test('grid with a booking band (colspan + palette) passes WCAG 2.2 AA', async ({ page }) => {
		// Ensure AT LEAST ONE band is visible before scanning. Avoids
		// test-ordering dependency by creating one IF absent — and picks
		// the empty date deterministically from the CURRENT DOM (not a
		// fixed offset that might collide with prior tests).
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()
		// Wait for grid to finish loading (either bands OR empty cells are
		// present, never neither).
		await expect(page.locator('button[data-cell-date], [data-booking-id]').first()).toBeVisible()

		const hasBand = (await page.locator('[data-booking-id]').count()) > 0
		if (!hasBand) {
			// First-run (no prior test bands): create one on whatever empty
			// cell is first in DOM — no date assumption.
			const emptyCell = page.locator('button[data-cell-date]').first()
			await expect(emptyCell).toBeVisible()
			await emptyCell.click()
			const dialog = page.getByRole('dialog')
			await expect(dialog).toBeVisible()
			await dialog.getByLabel('Фамилия').fill('A11y')
			await dialog.getByLabel('Имя').fill('Scan')
			await dialog.getByLabel('Номер документа').fill('4510888000')
			await dialog.getByRole('button', { name: /Создать бронирование/ }).click()
			await expect(page.getByText('Бронирование создано')).toBeVisible()
		}
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

	test('booking-CREATE dialog passes WCAG 2.2 AA (labels, focus, contrast)', async ({ page }) => {
		// Dialog a11y: distinct from grid — tests DialogContent structure,
		// form-field label associations, submit button name, close button
		// (aria-label="Закрыть" on X icon), focus trap. Scope the scan to
		// the role=dialog surface so other page chrome doesn't mask findings.
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		// Click any empty cell — test-order-independent (the first data-cell-
		// date in DOM is always the first empty cell in row 0).
		await page.locator('button[data-cell-date]').first().click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole('heading', { name: /Новое бронирование/ })).toBeVisible()
		// Wait for ratePlan query to settle — until then, submit button is
		// disabled (opacity-50), which axe flags as contrast violation from
		// the blended computed color. Empirically: "тариф Базовый тариф"
		// text in the description appears ONLY after ratePlan loaded.
		await expect(dialog.getByText(/тариф Базовый тариф/)).toBeVisible()
		await expect(dialog.getByRole('button', { name: /Создать бронирование/ })).toBeEnabled()
		// Wait for Sheet/Dialog enter-animation (fade-in-0 + slide-from-*-10)
		// to fully settle — без этого axe captures composite frame с button at
		// ~84% opacity blended с bg-popover, surfacing primary button at
		// ~4.37:1 vs 4.5:1 AA. Same canon как payments.spec.ts senior-pass.
		await page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== 'running'),
		)

		const results = await new AxeBuilder({ page })
			.include('[role="dialog"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()

		if (results.violations.length > 0) {
			console.error('axe violations (create dialog):', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})

	test('booking-EDIT dialog passes WCAG 2.2 AA (action buttons + state-machine labels)', async ({
		page,
	}) => {
		// Edit dialog a11y — opens on an existing band. Prior tests leave
		// bands in various statuses (confirmed / in_house / cancelled / …).
		// Pick the FIRST band in DOM and open its edit dialog.
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const firstBand = page.locator('[data-booking-id]').first()
		await expect(firstBand).toBeVisible()
		await firstBand.click()

		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		// Either TerminalView ("Бронь завершена") or ActionView ("Бронь:") —
		// both pass through the same Dialog primitive so scan either.
		await expect(dialog.getByRole('heading')).toBeVisible()
		// Wait for animations to settle — same canon как booking-CREATE.
		await page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== 'running'),
		)

		const results = await new AxeBuilder({ page })
			.include('[role="dialog"]')
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()

		if (results.violations.length > 0) {
			console.error('axe violations (edit dialog):', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})
})

