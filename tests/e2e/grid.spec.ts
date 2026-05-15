import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'
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
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+-w\d+\/?$/)

		await page.locator('[data-section-id="grid"]').first().click()
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+-w\d+\/grid$/)

		// Grid container present with correct ARIA metadata.
		const grid = page.getByRole('grid')
		await expect(grid).toBeVisible()
		await expect(grid).toHaveAttribute('aria-rowcount', '2') // 1 header + 1 roomType
		await expect(grid).toHaveAttribute('aria-colcount', '16') // 1 rowheader + 15 date cols
	})

	test('roomType row shows "Стандарт" from setup wizard', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await expect(page.getByRole('rowheader', { name: /Стандарт/ })).toBeVisible()
	})

	test('today column marked with aria-current="date"', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const todayHeader = page.locator('[aria-current="date"]')
		await expect(todayHeader).toBeVisible()
	})

	test('date navigation: Вперёд shifts window forward by 15 days', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()

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
		await page.locator('[data-section-id="grid"]').first().click()
		await page.getByRole('button', { name: 'Следующие 15 дней' }).click()
		await expect(page.locator('[aria-current="date"]')).toHaveCount(0)

		await page.getByRole('button', { name: /Сегодня/ }).click()
		await expect(page.locator('[aria-current="date"]')).toHaveCount(1)
	})

	test('cross-tenant URL /o/not-your-slug/grid redirects to own org (positive assert)', async ({
		page,
	}) => {
		await page.goto('/o/definitely-not-your-org/grid')
		// Positive assertion: must land on owner's OWN /o/e2e-hotel-…/ path,
		// not just "anywhere but the adversarial slug". Prevents false-positive
		// passes (e.g. blank page / error page that also lacks the slug).
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+-w\d+\/?$/)
	})

	test('Назад button shifts window back (symmetric to Вперёд)', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()

		const firstDateHeader = page.locator('[role="columnheader"]').nth(1)
		const before = (await firstDateHeader.textContent())?.trim() ?? ''
		expect(before.length).toBeGreaterThan(0)

		await page.getByRole('button', { name: 'Предыдущие 15 дней' }).click()
		await expect(firstDateHeader).not.toHaveText(before, { useInnerText: true })

		// Go back to present — headers should match pre-Назад state.
		await page.getByRole('button', { name: 'Следующие 15 дней' }).click()
		await expect(firstDateHeader).toHaveText(before, { useInnerText: true })
	})
})

// ---------------------------------------------------------------------------
// G6 + G6.bis (2026-05-15) — Cloudbeds Spring 2026 display-range canon.
// Dropdown extension с 8 опций: 3/4/7/14/15/21/30/fit. Канон RU labels:
// «1 неделя», «2 недели», «3 недели». Backward-compat 15 retained.
//
// G6.bis fills empirical e2e gap from G6 ship (commit 868983a) — was unit-
// only verification. Per `[[layer-4-5-mandatory-per-subphase]]` каждая
// фаза должна пройти e2e в real browser.
// ---------------------------------------------------------------------------

test.describe('reservation grid — G6 display range selector (Cloudbeds canon)', () => {
	test('[G6-E1] dropdown opens с 8 options в canonical Cloudbeds order', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.getByRole('button', { name: /Размер окна/i }).click()
		// Items appear as menuitems. Canonical ascending order по day-count
		// (week aliases interspersed): 3д → 4д → 1н → 2н → 15д → 3н → 30д → fit.
		const items = await page.getByRole('menuitem').all()
		expect(items.length).toBe(8)
		expect((await items[0]?.textContent())?.trim()).toBe('3 дня')
		expect((await items[1]?.textContent())?.trim()).toBe('4 дня')
		expect((await items[2]?.textContent())?.trim()).toBe('1 неделя')
		expect((await items[3]?.textContent())?.trim()).toBe('2 недели')
		expect((await items[4]?.textContent())?.trim()).toBe('15 дней')
		expect((await items[5]?.textContent())?.trim()).toBe('3 недели')
		expect((await items[6]?.textContent())?.trim()).toBe('30 дней')
		expect((await items[7]?.textContent())?.trim()).toBe('По ширине экрана')
	})

	test('[G6-E2] click «1 неделя» → grid renders 7 date columns (aria-colcount=8)', async ({
		page,
	}) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.getByRole('button', { name: /Размер окна/i }).click()
		await page.getByRole('menuitem', { name: /^1 неделя$/ }).click()
		// 7 date columns + 1 rowheader = aria-colcount 8.
		await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '8')
		// Selector label syncs к active value.
		await expect(page.getByRole('button', { name: /Размер окна/i })).toContainText('1 неделя')
	})

	test('[G6-E3] click «2 недели» → 14 date columns (aria-colcount=15)', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.getByRole('button', { name: /Размер окна/i }).click()
		await page.getByRole('menuitem', { name: /^2 недели$/ }).click()
		await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '15')
	})

	test('[G6-E4] click «3 недели» → 21 date columns (aria-colcount=22)', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.getByRole('button', { name: /Размер окна/i }).click()
		await page.getByRole('menuitem', { name: /^3 недели$/ }).click()
		await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '22')
	})

	test('[G6-E5] click «4 дня» → 4 date columns (aria-colcount=5, Cloudbeds quick-view)', async ({
		page,
	}) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.getByRole('button', { name: /Размер окна/i }).click()
		await page.getByRole('menuitem', { name: /^4 дня$/ }).click()
		await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '5')
	})

	test('[G6-E6] backward-compat: «15 дней» legacy option preserved (no migration needed)', async ({
		page,
	}) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		// First switch к something else, then back к 15 — verify it's still
		// в the dropdown post-G6 extension (drift catch).
		await page.getByRole('button', { name: /Размер окна/i }).click()
		await page.getByRole('menuitem', { name: /^1 неделя$/ }).click()
		await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '8')

		await page.getByRole('button', { name: /Размер окна/i }).click()
		await page.getByRole('menuitem', { name: /^15 дней$/ }).click()
		await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '16')
	})
})
