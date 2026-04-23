import { expect, test } from '@playwright/test'

/**
 * Booking-edit dialog (M5e.2) adversarial e2e.
 *
 * Runs with `owner.json` storageState (auth.setup.ts). Each test creates
 * its own booking first via the create dialog (M5e.1), then clicks the
 * resulting band to open the edit dialog.
 *
 * Hunts:
 *   1. Check-in happy path: click band on confirmed booking → "Заезд" →
 *      band palette flips to in-house color (black)
 *   2. Cancel requires reason: empty reason → submit disabled + hint
 *   3. Cancel happy path: fill reason → band flips to cancelled (grey,
 *      strikethrough label)
 *   4. Terminal state: click a cancelled band → dialog shows no action
 *      buttons, only "Закрыть" + displays cancel reason
 *   5. Cross-tenant: PATCH via page.request on a bogus booking id → 404
 */

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

async function createConfirmedBooking(page: import('@playwright/test').Page, dayOffset: number) {
	await page.goto('/')
	await page.getByRole('link', { name: /Шахматка/ }).click()
	const targetDate = futureIso(dayOffset)
	await page.locator(`button[data-cell-date="${targetDate}"]`).click()
	const dialog = page.getByRole('dialog')
	await expect(dialog).toBeVisible()
	await dialog.getByLabel('Фамилия').fill(`Edit${dayOffset}`)
	await dialog.getByLabel('Имя').fill(`Тест${dayOffset}`)
	await dialog.getByLabel('Номер документа').fill(`451000${dayOffset}000`)
	await dialog.getByRole('button', { name: /Создать бронирование/ }).click()
	await expect(page.getByText('Бронирование создано')).toBeVisible()
	await expect(dialog).not.toBeVisible()
	return targetDate
}

test.describe('booking-edit dialog', () => {
	test('check-in: click confirmed band → "Заезд" → band flips to in-house palette', async ({
		page,
	}) => {
		await createConfirmedBooking(page, 11)

		// Locate the confirmed band and capture its classes (palette = bg-blue-500)
		const band = page.locator('[data-booking-id]').last()
		await expect(band).toContainText('Подтверждена')
		await expect(band).toHaveClass(/bg-blue-500/)

		// Open edit dialog
		await band.click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole('heading', { name: /Бронь:.+Подтверждена/ })).toBeVisible()

		// Click check-in
		await dialog.getByRole('button', { name: 'Заезд' }).click()
		await expect(page.getByText('Гость заселён')).toBeVisible()
		await expect(dialog).not.toBeVisible()

		// Band now in_house — black palette + "В проживании" label
		await expect(band).toContainText('В проживании')
		await expect(band).toHaveClass(/bg-neutral-900/)
	})

	test('cancel: empty reason → submit disabled + hint shown', async ({ page }) => {
		await createConfirmedBooking(page, 12)

		await page.locator('[data-booking-id]').last().click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		await dialog.getByRole('button', { name: 'Отменить бронь' }).click()
		const reasonField = dialog.getByLabel('Причина отмены')
		await expect(reasonField).toBeVisible()

		// Reason empty → submit disabled
		const submit = dialog.getByRole('button', { name: 'Подтвердить отмену' })
		await expect(submit).toBeDisabled()

		// Whitespace-only also disabled (trim invariant)
		await reasonField.fill('   ')
		await reasonField.blur()
		await expect(submit).toBeDisabled()
		await expect(dialog.getByText('Укажите причину отмены')).toBeVisible()

		// Real reason → enabled
		await reasonField.fill('Гость отменил по телефону')
		await expect(submit).toBeEnabled()
	})

	test('cancel happy → band flips to cancelled palette (strikethrough, grey)', async ({
		page,
	}) => {
		await createConfirmedBooking(page, 13)

		const band = page.locator('[data-booking-id]').last()
		await band.click()
		const dialog = page.getByRole('dialog')

		await dialog.getByRole('button', { name: 'Отменить бронь' }).click()
		await dialog.getByLabel('Причина отмены').fill('Change of plans')
		await dialog.getByRole('button', { name: 'Подтвердить отмену' }).click()

		await expect(page.getByText('Бронь отменена')).toBeVisible()
		await expect(dialog).not.toBeVisible()

		// Band palette: grey + line-through + "Отменена" label
		await expect(band).toContainText('Отменена')
		await expect(band).toHaveClass(/bg-neutral-200/)
		await expect(band).toHaveClass(/line-through/)
	})

	test('terminal state: cancelled band → dialog read-only, no action buttons', async ({
		page,
	}) => {
		await createConfirmedBooking(page, 14)
		const band = page.locator('[data-booking-id]').last()

		// Cancel it first
		await band.click()
		const dialog = page.getByRole('dialog')
		await dialog.getByRole('button', { name: 'Отменить бронь' }).click()
		await dialog.getByLabel('Причина отмены').fill('Adversarial terminal test')
		await dialog.getByRole('button', { name: 'Подтвердить отмену' }).click()
		await expect(page.getByText('Бронь отменена')).toBeVisible()

		// Re-open — now terminal branch
		await band.click()
		const terminalDialog = page.getByRole('dialog')
		await expect(terminalDialog).toBeVisible()
		await expect(
			terminalDialog.getByRole('heading', { name: /Бронь завершена.+Отменена/ }),
		).toBeVisible()

		// No action buttons present
		await expect(terminalDialog.getByRole('button', { name: 'Заезд' })).toHaveCount(0)
		await expect(terminalDialog.getByRole('button', { name: 'Отменить бронь' })).toHaveCount(0)
		await expect(terminalDialog.getByRole('button', { name: 'Не заехал' })).toHaveCount(0)

		// Reason and footer "Закрыть" button present (read-only surface).
		// Scope to DialogFooter — the X dismiss icon has aria-label "Закрыть"
		// too, so plain getByRole would match 2 elements.
		await expect(terminalDialog.getByText('Adversarial terminal test')).toBeVisible()
		await expect(
			terminalDialog.locator('[data-slot="dialog-footer"]').getByRole('button', {
				name: 'Закрыть',
			}),
		).toBeVisible()
	})

	test('cross-tenant: PATCH on well-formed non-existent booking id → 404', async ({ page }) => {
		// Well-formed typeid (book_{26 base32}) — passes Zod validator → hits
		// booking.routes.ts:77 → BookingNotFoundError (404). The tenant filter
		// also turns "exists in another tenant" into 404 (no enumeration leak).
		const res = await page.request.patch(
			'http://localhost:3000/api/v1/bookings/book_00000000000000000000000000/cancel',
			{
				data: { reason: 'probe' },
				headers: { 'content-type': 'application/json' },
			},
		)
		expect(res.status()).toBe(404)
		const body = (await res.json()) as { error?: { code?: string } }
		expect(body.error?.code).toBe('NOT_FOUND')
	})
})
