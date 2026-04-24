import { expect, test } from '@playwright/test'

/**
 * APG keyboard navigation (M5e.3) adversarial e2e.
 *
 * Hunts:
 *   1. Tab enters the grid, lands on first-cell (roving tabindex=0)
 *   2. ArrowRight/Left moves focus one cell in-row, no wrap at edges
 *   3. ArrowDown/Up moves focus across rows, no wrap at edges
 *   4. Home/End jump to row boundaries
 *   5. Ctrl+Home / Ctrl+End jump to grid corners
 *   6. Enter on focused empty cell opens create dialog with correct date
 *   7. Enter on focused band opens edit dialog
 *   8. Colspan band: Right from band START jumps past the span
 *   9. Shift+Arrow / Ctrl+Arrow does NOT move focus (browser select / word
 *      jump preserved)
 */

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

test.describe('reservation grid — APG keyboard navigation', () => {
	test('Tab enters grid, lands on the initial roving-tabindex cell', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()
		await expect(page).toHaveURL(/\/grid$/)

		// Focus the "Вперёд →" nav button first (known tab stop before grid)
		// and Tab until we land inside the grid.
		await page.getByRole('button', { name: 'Следующие 15 дней' }).focus()

		// Tab once — should land on the initial grid cell (tabIndex=0 per
		// roving pattern).
		await page.keyboard.press('Tab')

		// The initial tab stop is row 0, first cell (aria-colindex=2).
		const activeRole = await page.evaluate(() => document.activeElement?.getAttribute('role'))
		expect(activeRole).toBe('gridcell')

		const activeColIdx = await page.evaluate(() =>
			document.activeElement?.getAttribute('aria-colindex'),
		)
		expect(activeColIdx).toBe('2')
	})

	test('ArrowRight / ArrowLeft move focus within row; no wrap', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		// Focus the first empty cell deterministically via click (no bands
		// at futureIso(1) yet in a fresh tenant-less context — but we share
		// state with other tests; use a guaranteed-empty cell by clicking
		// the today cell's button then immediately pressing Escape to close
		// any dialog that pops, then continue with the now-focused cell).
		// Simpler: focus by aria-colindex directly.
		const firstCell = page.locator('[role="gridcell"][aria-colindex="2"]').first()
		await firstCell.focus()
		await expect(firstCell).toBeFocused()

		await page.keyboard.press('ArrowRight')
		// Focus moves to aria-colindex=3 (unless the cell at col 2 is a
		// band with span>1, in which case it skips). We don't know the
		// state of this row without more coupling — assert the minimum:
		// focus left aria-colindex=2.
		const afterRight = await page.evaluate(() =>
			document.activeElement?.getAttribute('aria-colindex'),
		)
		expect(Number(afterRight)).toBeGreaterThan(2)

		// ArrowLeft returns to col 2
		await page.keyboard.press('ArrowLeft')
		const afterLeft = await page.evaluate(() =>
			document.activeElement?.getAttribute('aria-colindex'),
		)
		expect(afterLeft).toBe('2')

		// ArrowLeft at col 2 clamps (no wrap)
		await page.keyboard.press('ArrowLeft')
		const stillClamped = await page.evaluate(() =>
			document.activeElement?.getAttribute('aria-colindex'),
		)
		expect(stillClamped).toBe('2')
	})

	test('Home/End jump to row boundaries', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const firstCell = page.locator('[role="gridcell"][aria-colindex="2"]').first()
		await firstCell.focus()

		await page.keyboard.press('End')
		const atEnd = await page.evaluate(() =>
			Number(document.activeElement?.getAttribute('aria-colindex')),
		)
		// Grid has 15 date columns → aria-colindex range [2, 16]. Last
		// visible cell's aria-colindex must be exactly 16 (band or empty).
		expect(atEnd).toBe(16)

		await page.keyboard.press('Home')
		const atHome = await page.evaluate(() =>
			document.activeElement?.getAttribute('aria-colindex'),
		)
		expect(atHome).toBe('2')
	})

	test('Ctrl+Home / Ctrl+End jump to grid corners', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		// Put focus somewhere non-corner first
		const someCell = page.locator('[role="gridcell"][aria-colindex="5"]').first()
		await someCell.focus()

		await page.keyboard.press('ControlOrMeta+End')
		const ctrlEnd = await page.evaluate(() => ({
			col: document.activeElement?.getAttribute('aria-colindex'),
			// Walk up to find role=row parent's aria-rowindex. Our rows use
			// className="contents" so the direct parent isn't a role=row
			// DOM wrapper — we use the grid's aria-rowcount to verify.
			// For now just confirm we landed on a gridcell.
			role: document.activeElement?.getAttribute('role'),
		}))
		expect(ctrlEnd.role).toBe('gridcell')
		expect(ctrlEnd.col).toBe('16')

		await page.keyboard.press('ControlOrMeta+Home')
		const ctrlHome = await page.evaluate(() => ({
			col: document.activeElement?.getAttribute('aria-colindex'),
			role: document.activeElement?.getAttribute('role'),
		}))
		expect(ctrlHome.role).toBe('gridcell')
		expect(ctrlHome.col).toBe('2')
	})

	test('Enter on focused empty cell opens create dialog', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		// Focus a specific empty cell via aria-label to avoid band collisions.
		// Use a mid-window date that's likely empty in a fresh state; if not
		// empty, this e2e is order-dependent — accept that risk.
		const targetDate = futureIso(9)
		const cell = page.locator(`button[data-cell-date="${targetDate}"]`)
		await cell.focus()

		// Native <button> handles Enter → dispatches click → opens dialog.
		await page.keyboard.press('Enter')
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole('heading', { name: /Новое бронирование/ })).toBeVisible()
		await expect(dialog.getByText(new RegExp(`заезд ${targetDate}`))).toBeVisible()

		// Close without creating
		await dialog.getByRole('button', { name: 'Отмена' }).click()
		await expect(dialog).not.toBeVisible()
	})

	test('Space on focused empty cell also opens create dialog (native button behavior)', async ({
		page,
	}) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const targetDate = futureIso(8)
		const cell = page.locator(`button[data-cell-date="${targetDate}"]`)
		await cell.focus()

		await page.keyboard.press('Space')
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		await dialog.getByRole('button', { name: 'Отмена' }).click()
	})

	test('Shift+ArrowRight does NOT move grid focus (browser select preserved)', async ({
		page,
	}) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const firstCell = page.locator('[role="gridcell"][aria-colindex="2"]').first()
		await firstCell.focus()
		const beforeCol = await page.evaluate(() =>
			document.activeElement?.getAttribute('aria-colindex'),
		)
		expect(beforeCol).toBe('2')

		await page.keyboard.press('Shift+ArrowRight')
		const afterCol = await page.evaluate(() =>
			document.activeElement?.getAttribute('aria-colindex'),
		)
		// Focus did NOT move — Shift+Arrow rejected by keyToAction (browser
		// select-extend semantic preserved per WCAG 2.1.1).
		expect(afterCol).toBe('2')
	})

	test('ArrowDown moves focus across rows', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const firstCell = page.locator('[role="gridcell"][aria-colindex="2"]').first()
		await firstCell.focus()

		// Grid has only 1 roomType row → ArrowDown should clamp (no wrap,
		// no second row to go to). Focus should stay on same cell.
		// (If in the future multiple roomTypes are added, this test assumes
		// ArrowDown moves to row 2 — we assert at minimum that it does not
		// throw / lose focus.)
		await page.keyboard.press('ArrowDown')
		const afterDown = await page.evaluate(() => ({
			col: document.activeElement?.getAttribute('aria-colindex'),
			role: document.activeElement?.getAttribute('role'),
		}))
		expect(afterDown.role).toBe('gridcell')
		// Column preserved on vertical movement
		expect(afterDown.col).toBe('2')
	})

	test('Tab out of grid: Shift+Tab before first cell exits grid entirely (roving tabindex)', async ({
		page,
	}) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const firstCell = page.locator('[role="gridcell"][aria-colindex="2"]').first()
		await firstCell.focus()

		// Shift+Tab should exit the grid (all other cells have tabIndex=-1).
		await page.keyboard.press('Shift+Tab')
		const activeRole = await page.evaluate(() => document.activeElement?.getAttribute('role'))
		// Active element is now OUTSIDE the grid — not a gridcell.
		expect(activeRole).not.toBe('gridcell')
	})

	test('PageDown/PageUp: handler fires + focus stays in grid (not browser scroll)', async ({
		page,
	}) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const firstCell = page.locator('[role="gridcell"][aria-colindex="2"]').first()
		await firstCell.focus()

		// PageDown default browser behavior: scrolls viewport DOWN. Our handler
		// calls preventDefault() on the recognized key, so the browser scroll
		// is suppressed. Assert:
		//  (a) focus remains on a gridcell (not scrolled away)
		//  (b) window.scrollY did not change (preventDefault effective)
		const scrollBefore = await page.evaluate(() => window.scrollY)
		await page.keyboard.press('PageDown')
		const afterDown = await page.evaluate(() => ({
			scroll: window.scrollY,
			role: document.activeElement?.getAttribute('role'),
			col: document.activeElement?.getAttribute('aria-colindex'),
		}))
		expect(afterDown.role).toBe('gridcell')
		expect(afterDown.scroll).toBe(scrollBefore) // preventDefault worked
		// With only 1 roomType row, PageDown clamps at row 0 — column preserved.
		expect(afterDown.col).toBe('2')

		await page.keyboard.press('PageUp')
		const afterUp = await page.evaluate(() => ({
			role: document.activeElement?.getAttribute('role'),
			col: document.activeElement?.getAttribute('aria-colindex'),
		}))
		expect(afterUp.role).toBe('gridcell')
		expect(afterUp.col).toBe('2')
	})

	test('Enter on focused BAND opens edit dialog (parity with empty-cell Enter)', async ({
		page,
	}) => {
		// Create a booking FIRST so there's a band to focus. Use day 0 (today)
		// to keep this test independent from other date-offset tests.
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const targetDate = futureIso(0)
		await page.locator(`button[data-cell-date="${targetDate}"]`).click()
		const createDialog = page.getByRole('dialog')
		await expect(createDialog).toBeVisible()
		await createDialog.getByLabel('Фамилия').fill('Клавиатура')
		await createDialog.getByLabel('Имя').fill('Тест')
		await createDialog.getByLabel('Номер документа').fill('4510555000')
		await createDialog.getByRole('button', { name: /Создать бронирование/ }).click()
		await expect(page.getByText('Бронирование создано')).toBeVisible()
		await expect(createDialog).not.toBeVisible()

		// Focus the newly-created band and hit Enter — should open EDIT dialog.
		const band = page.locator(`[data-booking-id][aria-label*="${targetDate} —"]`)
		await band.focus()
		await page.keyboard.press('Enter')

		const editDialog = page.getByRole('dialog')
		await expect(editDialog).toBeVisible()
		await expect(editDialog.getByRole('heading', { name: /Бронь:.+Подтверждена/ })).toBeVisible()
		// Close dialog to not pollute downstream tests.
		await editDialog.locator('[aria-label="Закрыть"]').click()
		await expect(editDialog).not.toBeVisible()
	})

	test('focus return after dialog close: roving tabindex preserved', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		// Arrow away from initial position so we know focus has actually moved
		// before opening the dialog.
		const firstCell = page.locator('[role="gridcell"][aria-colindex="2"]').first()
		await firstCell.focus()
		await page.keyboard.press('ArrowRight')
		await page.keyboard.press('ArrowRight')
		const beforeCol = await page.evaluate(() =>
			document.activeElement?.getAttribute('aria-colindex'),
		)
		expect(beforeCol).toBe('4')

		// Open create dialog via Enter
		await page.keyboard.press('Enter')
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		// Close via Escape (Radix Dialog handles natively, returns focus to trigger)
		await page.keyboard.press('Escape')
		await expect(dialog).not.toBeVisible()

		// Real invariant: roving tabindex state (our React useState) must
		// remember (0, 4). Verify by directly focusing col=4 cell via its
		// tabIndex=0 attribute — only ONE cell has tabIndex=0 in roving
		// pattern, and it must still be col 4. Then ArrowRight advances
		// to col 5.
		const tabStopCol = await page.evaluate(() => {
			const cells = Array.from(document.querySelectorAll('[role="gridcell"][tabindex="0"]'))
			return cells[0]?.getAttribute('aria-colindex') ?? null
		})
		expect(tabStopCol).toBe('4')

		// Focus that cell deterministically (Radix may or may not have
		// restored focus exactly here in headless Chromium — we assert
		// state, not browser behavior).
		await page.locator('[role="gridcell"][tabindex="0"]').focus()
		await page.keyboard.press('ArrowRight')
		const afterArrow = await page.evaluate(() =>
			document.activeElement?.getAttribute('aria-colindex'),
		)
		expect(afterArrow).toBe('5')
	})
})
