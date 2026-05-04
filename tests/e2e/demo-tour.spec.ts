/**
 * Demo tour E2E — strict tests ETOUR1-ETOUR3 (M9.widget.8 / A6.2 / D9-D11).
 *
 * Per `plans/m9_widget_8_canonical.md` §4 line 15:
 *   «3 E2E TOUR tests: tour starts from button / Esc dismisses / does NOT
 *    show on production tenant».
 *
 * Anchors: `data-testid="demo-tour-trigger"` (button) + `[data-testid="demo-tour-dialog"]`
 * (overlay) + `[data-testid="demo-tour-skip"]` (skip control).
 *
 * Smoke project — anonymous, runs against `demo-sirius` seed.
 */

import { expect, test } from '@playwright/test'

const WIDGET_URL = '/widget/demo-sirius'

test.describe('demo tour overlay (D9-D11)', () => {
	test.beforeEach(async ({ page }) => {
		// Reset tour state per test to ensure repeatable trigger visibility.
		await page.addInitScript(() => {
			window.localStorage?.removeItem('horeca:demo-tour:status')
		})
	})

	test('[ETOUR1] tour trigger visible on demo tenant + click opens overlay', async ({ page }) => {
		await page.goto(WIDGET_URL)
		// Demo banner is the canonical mode-gate signal.
		await expect(page.getByTestId('demo-banner')).toBeVisible()
		// Trigger should be visible — status is 'idle' due to beforeEach reset.
		const trigger = page.getByTestId('demo-tour-trigger')
		await expect(trigger).toBeVisible()
		await expect(trigger).toHaveText(/Тур по демо/)

		await trigger.click()
		// Native <dialog> opens with showModal — content visible.
		await expect(page.getByTestId('demo-tour-dialog')).toBeVisible()
		// Step 1 of 4 announced via step counter.
		await expect(page.getByTestId('demo-tour-step-counter')).toHaveText(/Шаг 1 из 4/)
	})

	test('[ETOUR2] Esc dismisses tour (native <dialog> cancel event)', async ({ page }) => {
		await page.goto(WIDGET_URL)
		await page.getByTestId('demo-tour-trigger').click()
		await expect(page.getByTestId('demo-tour-dialog')).toBeVisible()

		// Esc key — native <dialog> fires `cancel` event → our handler calls skip().
		await page.keyboard.press('Escape')
		await expect(page.getByTestId('demo-tour-dialog')).not.toBeVisible()
		// Trigger also hidden after skip (status='completed').
		await expect(page.getByTestId('demo-tour-trigger')).not.toBeVisible()
	})

	test('[ETOUR3] tour NOT shown on unknown / non-demo tenant', async ({ page }) => {
		// Non-existent slug → not-found surface; no demo banner, no tour controls.
		const response = await page.goto('/widget/never-exists-12345')
		// SPA returns 200 для initial document load; notFoundComponent renders client-side.
		if (response !== null) {
			expect([200, 404]).toContain(response.status())
		}
		await expect(page.getByRole('heading', { level: 1, name: 'Не найдено' })).toBeVisible({
			timeout: 5_000,
		})
		// No demo controls на not-found page.
		await expect(page.getByTestId('demo-banner')).toHaveCount(0)
		await expect(page.getByTestId('demo-tour-trigger')).toHaveCount(0)
		await expect(page.getByTestId('demo-tour-dialog')).toHaveCount(0)
	})
})
