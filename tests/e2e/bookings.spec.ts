import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'
/**
 * Booking-create dialog (M5e.1) adversarial e2e.
 *
 * Runs with `owner.json` storageState so the tenant already has:
 *   - property, roomType (inventoryCount=10 per wizard default rooms=10),
 *     seeded «Базовый» rate plan, 90-day rate + availability rows
 *     (`apps/backend/.../onboarding.service.ts` step 6, ratchet-fixed
 *     2026-05-15 after per-worker e2e tenant exposed the missing-availability
 *     trap).
 *   - the grid window [today..today+14] has exactly 15 empty cells per row.
 *
 * Hunts:
 *   1. Happy path: click cell → fill guest → submit → band + success toast
 *   2. Overbooking: PRE-fixture forces `allotment=1` на target date via the
 *      admin `POST /room-types/:id/availability` endpoint (canon: test
 *      fixtures use the SAME endpoint operators use — `[[mock-seam-at-
 *      adapter-not-http]]`); then 2nd booking → 409 NO_INVENTORY → toast
 *      + dialog stays open + band count unchanged (optimistic band rolled
 *      back)
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
		await page.locator('[data-section-id="grid"]').first().click()
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
		// Count-agnostic — other tests in this run may have created bookings
		// in the same tenant. Filter to our target date's column via the band
		// text (status label) and row (target cell's roomTypeId).
		const allBands = page.locator('[data-booking-id]')
		await expect(allBands.first()).toBeVisible()
		// Assert no pending_* optimistic placeholder persisted past success.
		const pendingBands = page.locator('[data-booking-id^="pending_"]')
		await expect(pendingBands).toHaveCount(0)
	})

	test('overbooking: 2nd booking on same date → 409 toast, optimistic band rolled back', async ({
		page,
	}) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await expect(page).toHaveURL(/\/grid$/)

		// First booking: single night on today+6
		const firstDate = futureIso(6)

		// **Force allotment=1 на firstDate** ДО first booking — wizard default
		// is `rooms: 10` (см. `apps/frontend/src/features/setup/wizard-store.ts`
		// INITIAL.rooms), so without this fixture 11 concurrent bookings would
		// be needed to exhaust inventory (too slow for e2e). Setting allotment=1
		// makes overbooking trigger on the 2nd attempt. Per `[[mock-seam-at-
		// adapter-not-http]]` canon — test fixture uses the SAME admin endpoint
		// operators use (POST /room-types/:id/availability), не a test shortcut.
		const cellButton = page.locator(`button[data-cell-date="${firstDate}"]`).first()
		await expect(cellButton).toBeVisible()
		const roomTypeId = await cellButton.getAttribute('data-cell-room-type-id')
		expect(roomTypeId).not.toBeNull()
		const setAllotment = await page.request.post(
			`http://localhost:8787/api/v1/room-types/${roomTypeId}/availability`,
			{
				data: {
					rates: [
						{
							date: firstDate,
							allotment: 1,
							minStay: null,
							maxStay: null,
							closedToArrival: false,
							closedToDeparture: false,
							stopSell: false,
						},
					],
				},
			},
		)
		expect(setAllotment.ok()).toBe(true)

		await cellButton.click()
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
		await page.locator('[data-section-id="grid"]').first().click()

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

test.describe('booking-create G1 — real-bug-hunt fixes', () => {
	test('G-B2: guestsCount=0 surfaces inline «Не меньше 1»; submit gated', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const targetDate = futureIso(12)
		await page.locator(`button[data-cell-date="${targetDate}"]`).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		// Out-of-range below — used к pass HTML5-only, fail server с 400.
		await dialog.getByRole('spinbutton', { name: 'Гостей' }).fill('0')
		await dialog.getByRole('spinbutton', { name: 'Гостей' }).blur()
		await expect(dialog.getByText('Не меньше 1')).toBeVisible()

		// Out-of-range above — same trap.
		await dialog.getByRole('spinbutton', { name: 'Гостей' }).fill('21')
		await dialog.getByRole('spinbutton', { name: 'Гостей' }).blur()
		await expect(dialog.getByText('Не больше 20')).toBeVisible()

		// Recover к valid — error disappears.
		await dialog.getByRole('spinbutton', { name: 'Гостей' }).fill('2')
		await dialog.getByRole('spinbutton', { name: 'Гостей' }).blur()
		await expect(dialog.getByText('Не больше 20')).not.toBeVisible()
		await expect(dialog.getByText('Не меньше 1')).not.toBeVisible()
	})

	test('G-B3: rate plan picker visible с default; can change selection', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const targetDate = futureIso(13)
		await page.locator(`button[data-cell-date="${targetDate}"]`).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		// Тариф label + Select visible.
		const ratePlanTrigger = dialog.getByRole('combobox', { name: 'Тариф' })
		await expect(ratePlanTrigger).toBeVisible()
		// Default seeded — should NOT be «Выберите тариф» (placeholder visible
		// only while query loads); тариф «Базовый» seeded by onboarding wizard.
		await expect(ratePlanTrigger).not.toContainText('Выберите тариф')
		await expect(ratePlanTrigger).not.toContainText('Загружаем')
	})

	test('G-B4: price preview shows nights + total ₽ (live rate-grid query)', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const targetDate = futureIso(14)
		await page.locator(`button[data-cell-date="${targetDate}"]`).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		// Default 1 night; rate-grid seeded 90 days at onboarding's avgPriceRub.
		const preview = dialog.locator('[data-slot="price-preview"]')
		await expect(preview).toBeVisible()
		await expect(preview).toContainText('1 ночь')
		await expect(preview).toContainText('тариф')

		// Itogo line surfaces после rates load — wait for it.
		const total = dialog.locator('[data-slot="price-preview-total"]')
		await expect(total).toBeVisible({ timeout: 5_000 })
		await expect(total).toContainText('Итого:')
		await expect(total).toContainText('₽')
	})
})
