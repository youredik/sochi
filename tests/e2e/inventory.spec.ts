import AxeBuilder from '@axe-core/playwright'
import { expect } from '@playwright/test'
import { test } from './_fixtures.ts'

/**
 * Inventory admin — Phase II Layer 4 + Layer 5 verification.
 *
 * Sidebar nav → /o/{slug}/properties/{propId}/inventory/rooms via the
 * inventory section link. Asserts:
 *   - h1 «Инвентарь» rendered
 *   - 3 tabs visible с canonical RU labels («Номера и категории», «Тарифы»,
 *     «Цены и ограничения»)
 *   - The currently-rendered tab carries aria-selected="true" (and exactly 1
 *     tab is selected — APG tablist invariant)
 *   - Click «+ Категория» → Sheet with title «Новая категория номеров» opens
 *   - axe scan WCAG 2.2 AA — zero violations on the rendered page
 *
 * Per `[[layer_4_5_mandatory_per_subphase]]` canon — every UI-touching
 * sub-phase MUST ship c Layer 4 (Playwright e2e) + Layer 5 (axe) before
 * commit. Phase II of inventory-admin satisfies this gate here.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const

async function axeClean(page: import('@playwright/test').Page, context: string): Promise<void> {
	const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze()
	if (results.violations.length > 0) {
		console.error(`axe violations (${context}):`, JSON.stringify(results.violations, null, 2))
	}
	expect(results.violations).toEqual([])
}

test.describe('inventory — rooms page (Phase II)', () => {
	test('navigates from sidebar, renders 3 tabs + opens category sheet, axe-clean', async ({
		page,
	}) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)

		// Sidebar → Инвентарь. Mounted for owner per RBAC (room:update).
		await page.locator('[data-section-id="inventory"]').click()
		await expect(page).toHaveURL(/\/properties\/[^/]+\/inventory\/rooms$/)

		// h1 page title.
		await expect(page.getByRole('heading', { level: 1, name: 'Инвентарь' })).toBeVisible()

		// Tabs (APG pattern: role=tablist + 3× role=tab).
		const tablist = page.getByRole('tablist', { name: 'Разделы инвентаря' })
		await expect(tablist).toBeVisible()
		const tabs = tablist.getByRole('tab')
		await expect(tabs).toHaveCount(3)
		await expect(tabs.nth(0)).toHaveText('Номера и категории')
		await expect(tabs.nth(1)).toHaveText('Тарифы')
		await expect(tabs.nth(2)).toHaveText('Цены и ограничения')

		// Exactly 1 selected (the current «rooms» tab).
		await expect(tablist.getByRole('tab', { selected: true })).toHaveCount(1)
		await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')

		// Section heading inside the rooms panel.
		await expect(page.getByRole('heading', { name: 'Категории номеров' })).toBeVisible()

		// «+ Категория» CTA opens the create-sheet.
		await page
			.getByRole('button', { name: /Категория/ })
			.first()
			.click()
		await expect(page.getByText('Новая категория номеров')).toBeVisible()

		// Close the sheet so it doesn't bleed axe violations into the scan
		// (Radix Sheet portals into <body>, axe scans whole page; closing
		// the sheet keeps the rendered tree to just the main page surface).
		await page.keyboard.press('Escape')
		await expect(page.getByText('Новая категория номеров')).not.toBeVisible()

		// Layer 5 — WCAG 2.2 AA axe scan on the rendered page.
		await axeClean(page, 'inventory-rooms')
	})
})

test.describe('inventory — edit + delete (Phase II.bis + III.bis)', () => {
	test('category row exposes Pencil edit + Trash delete; both open canonical surfaces, axe-clean', async ({
		page,
	}) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)
		await page.locator('[data-section-id="inventory"]').click()
		await expect(page).toHaveURL(/\/inventory\/rooms$/)

		// Default e2e tenant has «Стандартный» category seeded.
		// Click pencil → edit sheet opens с prefilled title.
		await page.getByRole('button', { name: /Изменить категорию «Стандартный»/ }).click()
		await expect(page.getByText('Изменить «Стандартный»', { exact: true })).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(page.getByText('Изменить «Стандартный»', { exact: true })).not.toBeVisible()

		// Click trash → confirm dialog opens с category-name title.
		await page.getByRole('button', { name: /Удалить категорию «Стандартный»/ }).click()
		await expect(page.getByText('Удалить «Стандартный»?', { exact: true })).toBeVisible()
		await page.getByRole('button', { name: 'Отмена' }).click()
		await expect(page.getByText('Удалить «Стандартный»?', { exact: true })).not.toBeVisible()

		await axeClean(page, 'inventory-rooms-edit-delete')
	})
})

test.describe('inventory — prices page (Phase IV)', () => {
	test('switches к «Цены и ограничения» tab, renders grid + opens bulk-edit sheet, axe-clean', async ({
		page,
	}) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)

		await page.locator('[data-section-id="inventory"]').click()
		await expect(page).toHaveURL(/\/inventory\/rooms$/)
		await page.getByRole('tab', { name: 'Цены и ограничения' }).click()
		await expect(page).toHaveURL(/\/inventory\/prices$/)

		await expect(page.getByRole('heading', { name: 'Цены и ограничения' })).toBeVisible()

		// «Изменить цены» CTA должен быть enabled (e2e tenant has default
		// «Базовый» plan seeded в auth.setup).
		const editCta = page.getByRole('button', { name: /Изменить цены/ }).first()
		await expect(editCta).toBeEnabled()
		await editCta.click()

		// Sheet contents: «Дни недели» legend visible (exact-match — Sheet
		// description copy also contains «дни недели» phrase).
		await expect(page.getByText('Дни недели', { exact: true })).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(page.getByText('Дни недели', { exact: true })).not.toBeVisible()

		await axeClean(page, 'inventory-prices')
	})
})

test.describe('inventory — rate-plans page (Phase III)', () => {
	test('switches к «Тарифы» tab, renders rate-plans surface + opens form sheet, axe-clean', async ({
		page,
	}) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)

		await page.locator('[data-section-id="inventory"]').click()
		await expect(page).toHaveURL(/\/inventory\/rooms$/)

		// Click the «Тарифы» tab in the inventory tablist.
		await page.getByRole('tab', { name: 'Тарифы' }).click()
		await expect(page).toHaveURL(/\/inventory\/rate-plans$/)

		// Page-level h2 visible (rate-plans section heading).
		await expect(page.getByRole('heading', { name: 'Тарифные планы' })).toBeVisible()

		// «+ Тариф» CTA должен быть enabled (the e2e tenant has the «Стандартный»
		// category seeded в auth.setup).
		const addCta = page.getByRole('button', { name: /Тариф/ }).first()
		await expect(addCta).toBeEnabled()
		await addCta.click()

		// Sheet title surfaces.
		await expect(page.getByText('Новый тариф')).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(page.getByText('Новый тариф')).not.toBeVisible()

		await axeClean(page, 'inventory-rate-plans')
	})
})

test.describe('inventory — inline-bounds validation (B5)', () => {
	test('category form: maxOccupancy out-of-range surfaces inline FieldError (no server 400)', async ({
		page,
	}) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)

		await page.locator('[data-section-id="inventory"]').click()
		await expect(page).toHaveURL(/\/inventory\/rooms$/)

		// Open the create-category sheet.
		await page
			.getByRole('button', { name: /Категория/ })
			.first()
			.click()
		await expect(page.getByText('Новая категория номеров')).toBeVisible()

		// `getByLabel('Гостей')` collides with the sidebar aria-label «Картотека
		// гостей и миграционный учёт МВД» (substring match across the page).
		// `getByRole('spinbutton')` is the canonical accessible selector для
		// `<input type="number">` per Playwright + WAI-ARIA roles.
		const occ = page.getByRole('spinbutton', { name: 'Гостей' })
		// Above-max — server `occupancySchema.max(20)` would 400; client surfaces inline.
		await occ.fill('21')
		await expect(page.getByText('Не больше 20')).toBeVisible()
		// Below-min — server `occupancySchema.min(1)` would 400.
		await occ.fill('0')
		await expect(page.getByText('Не меньше 1')).toBeVisible()
		// Recover к valid — error disappears.
		await occ.fill('2')
		await expect(page.getByText('Не меньше 1')).not.toBeVisible()
		await expect(page.getByText('Не больше 20')).not.toBeVisible()

		// Close sheet so axe scan inspects the page surface, not the portal.
		await page.keyboard.press('Escape')
		await expect(page.getByText('Новая категория номеров')).not.toBeVisible()
		await axeClean(page, 'inventory-rooms-bounds')
	})

	test('rate-plan form: minStay out-of-range surfaces inline FieldError', async ({ page }) => {
		await page.goto('/')
		await expect(page).toHaveURL(/\/o\/[^/]+\/?/)

		await page.locator('[data-section-id="inventory"]').click()
		await page.getByRole('tab', { name: 'Тарифы' }).click()
		await expect(page).toHaveURL(/\/inventory\/rate-plans$/)

		await page
			.getByRole('button', { name: /Тариф/ })
			.first()
			.click()
		await expect(page.getByText('Новый тариф')).toBeVisible()

		const minStay = page.getByRole('spinbutton', { name: 'Мин. ночей' })
		await minStay.fill('31')
		await expect(page.getByText('Не больше 30')).toBeVisible()
		await minStay.fill('0')
		await expect(page.getByText('Не меньше 1')).toBeVisible()

		await page.keyboard.press('Escape')
		await expect(page.getByText('Новый тариф')).not.toBeVisible()
		await axeClean(page, 'inventory-rate-plans-bounds')
	})
})
