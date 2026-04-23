import { expect, test } from '@playwright/test'

/**
 * Booking-create dialog (M5e.1) adversarial e2e.
 *
 * Runs with `owner.json` storageState so the tenant already has:
 *   - property, roomType (inventoryCount=1 — the wizard default, NOT the
 *     2 physical rooms created in step 3), seeded BAR rate plan,
 *     30-day rate + availability rows.
 *   - the grid window [today..today+14] has exactly 15 empty cells per row.
 *
 * Hunts:
 *   1. Happy path: click cell → fill guest → submit → band + success toast
 *   2. Overbooking: second booking on already-booked date → 409
 *      NO_INVENTORY → toast + dialog stays open + band count unchanged
 *      (optimistic band rolled back)
 *   3. Form guard: checkOut <= checkIn → submit button disabled (nights < 1)
 */

function futureIso(daysFromToday: number): string {
	// UTC-noon anchor matches the grid's todayIso() so cells line up.
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

test.describe('booking-create dialog', () => {
	test('click cell → fill guest → booking band appears with success toast', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()
		await expect(page).toHaveURL(/\/grid$/)

		const targetDate = futureIso(5)
		// Click the button cell (NOT the band overlay — buttons carry data-cell-*).
		await page.locator(`button[data-cell-date="${targetDate}"]`).click()

		// Dialog opens with the clicked date pre-filled.
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole('heading', { name: /Новое бронирование/ })).toBeVisible()
		await expect(dialog.getByText(new RegExp(`заезд ${targetDate}`))).toBeVisible()

		// Fill minimal guest fields (defaults: Паспорт РФ + RU + 1 guest).
		await dialog.getByLabel('Фамилия').fill('Иванов')
		await dialog.getByLabel('Имя').fill('Иван')
		await dialog.getByLabel('Номер документа').fill('4510123456')

		// Submit
		await dialog.getByRole('button', { name: /Создать бронирование/ }).click()

		// Success toast + dialog closes
		await expect(page.getByText('Бронирование создано')).toBeVisible()
		await expect(dialog).not.toBeVisible()

		// Real booking band appears (data-booking-id lands on non-pending id).
		await expect(page.locator('[data-booking-id]')).toHaveCount(1)
		const bandId = await page.locator('[data-booking-id]').first().getAttribute('data-booking-id')
		expect(bandId).toBeTruthy()
		// Id is NOT a rolled-back optimistic placeholder.
		expect(bandId).not.toMatch(/^pending_/)
		// Band carries the "Подтверждена" label (booking-palette mapping).
		await expect(page.locator('[data-booking-id]').first()).toContainText('Подтверждена')
	})

	test('overbooking: 2nd booking on same date → 409 toast, optimistic band rolled back', async ({
		page,
	}) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		// First booking: single night on today+6
		const firstDate = futureIso(6)
		await page.locator(`button[data-cell-date="${firstDate}"]`).click()
		await page.getByLabel('Фамилия').fill('Петров')
		await page.getByLabel('Имя').fill('Пётр')
		await page.getByLabel('Номер документа').fill('4510999001')
		await page.getByRole('button', { name: /Создать бронирование/ }).click()
		await expect(page.getByText('Бронирование создано')).toBeVisible()

		// Two bookings exist now (this test + previous test's first booking, if it
		// ran in same context). Record the count BEFORE the adversarial attempt.
		const bandsBefore = await page.locator('[data-booking-id]').count()

		// Second booking: click an earlier empty cell, but change checkOut to
		// overlap firstDate (today+6). allotment=1 → server must 409 NO_INVENTORY.
		const clickDate = futureIso(3)
		const overlapCheckOut = futureIso(8) // covers today+3..today+7 → hits firstDate
		await page.locator(`button[data-cell-date="${clickDate}"]`).click()

		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await dialog.getByLabel('Фамилия').fill('Сидоров')
		await dialog.getByLabel('Имя').fill('Семён')
		await dialog.getByLabel('Номер документа').fill('4510999002')
		await dialog.getByLabel('Выезд').fill(overlapCheckOut)
		await dialog.getByRole('button', { name: /Создать бронирование/ }).click()

		// Localized 409 toast
		await expect(page.getByText(/нет свободных номеров/)).toBeVisible()

		// Dialog stays open (user can edit dates + retry). Fail-loud: a
		// regression that silently closes the dialog on error would swallow
		// the user's typed-in data.
		await expect(dialog).toBeVisible()

		// Close dialog manually; assert no new band was committed.
		await dialog.getByRole('button', { name: 'Отмена' }).click()
		await expect(dialog).not.toBeVisible()
		await expect(page.locator('[data-booking-id]')).toHaveCount(bandsBefore)
	})

	test('form guard: checkOut <= checkIn → submit disabled + hint shown', async ({ page }) => {
		await page.goto('/')
		await page.getByRole('link', { name: /Шахматка/ }).click()

		const targetDate = futureIso(10)
		await page.locator(`button[data-cell-date="${targetDate}"]`).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		// Make checkOut equal to checkIn → 0 nights → submit disabled.
		await dialog.getByLabel('Выезд').fill(targetDate)
		await expect(dialog.getByText('Выезд должен быть позже заезда')).toBeVisible()
		await expect(dialog.getByRole('button', { name: /Создать бронирование/ })).toBeDisabled()

		// Reverse dates (checkOut < checkIn) → also disabled.
		await dialog.getByLabel('Выезд').fill(futureIso(9))
		await expect(dialog.getByRole('button', { name: /Создать бронирование/ })).toBeDisabled()

		// Sanity: valid checkOut → submit enabled.
		await dialog.getByLabel('Выезд').fill(futureIso(11))
		await expect(dialog.getByRole('button', { name: /Создать бронирование/ })).toBeEnabled()
	})
})
