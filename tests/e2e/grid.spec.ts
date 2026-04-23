import { expect, test } from '@playwright/test'

/**
 * Grid (M5d) adversarial e2e. Runs with `owner.json` storageState from
 * auth.setup.ts, so the tenant already has property + roomType + 2 rooms.
 *
 * Hunts:
 *   - grid route is reachable from dashboard via link (not just direct URL)
 *   - renders with a `role="grid"` container + aria-rowcount/colcount set
 *   - today column is visually marked (aria-current="date")
 *   - roomType row header shows the wizard-created "Стандарт" type
 *   - date-window navigation (Назад / Вперёд / Сегодня) actually changes
 *     the visible header dates
 *   - cross-tenant URL `/o/{other-slug}/grid` does NOT leak (parent
 *     `_app/o/$orgSlug` guard handles)
 */

test.describe('reservation grid', () => {
	test('dashboard link → grid renders with role=grid + aria metadata', async ({ page }) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/?$/)

		await page.getByRole('link', { name: /Шахматка/ }).click()
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/grid$/)

		// Grid container present with correct ARIA metadata.
		const grid = page.getByRole('grid')
		await expect(grid).toBeVisible()
		await expect(grid).toHaveAttribute('aria-rowcount', '2') // 1 header + 1 roomType
		await expect(grid).toHaveAttribute('aria-colcount', '16') // 1 rowheader + 15 date cols
	})

	test('roomType row shows "Стандарт" from setup wizard', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()
		await expect(page.getByRole('rowheader', { name: /Стандарт/ })).toBeVisible()
	})

	test('today column marked with aria-current="date"', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()
		const todayHeader = page.locator('[aria-current="date"]')
		await expect(todayHeader).toBeVisible()
	})

	test('date navigation: Вперёд shifts window forward by 15 days', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		// The 2nd column header (index 1) is the leftmost date cell.
		const firstDateHeader = page.locator('[role="columnheader"]').nth(1)
		const before = (await firstDateHeader.textContent())?.trim() ?? ''
		expect(before.length).toBeGreaterThan(0)

		await page.getByRole('button', { name: 'Следующие 15 дней' }).click()

		// After Вперёд, the leftmost date must be different.
		await expect(firstDateHeader).not.toHaveText(before, { useInnerText: true })
	})

	test('Сегодня button resets window to include today', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()
		await page.getByRole('button', { name: 'Следующие 15 дней' }).click()
		await expect(page.locator('[aria-current="date"]')).toHaveCount(0)

		await page.getByRole('button', { name: /Сегодня/ }).click()
		await expect(page.locator('[aria-current="date"]')).toHaveCount(1)
	})

	test('cross-tenant URL /o/not-your-slug/grid redirects away (no leak)', async ({ page }) => {
		await page.goto('/o/definitely-not-your-org/grid')
		await expect(page).not.toHaveURL(/definitely-not-your-org/)
	})
})
