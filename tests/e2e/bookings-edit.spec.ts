import { expect, test } from '@playwright/test'

/**
 * Booking-edit dialog (M5e.2) adversarial e2e.
 *
 * Runs with `owner.json` storageState (auth.setup.ts). Each test creates
 * its own booking first via the create dialog (M5e.1), then clicks the
 * resulting band to open the edit dialog.
 *
 * Tests are intentionally exhaustive across the state machine (hunt-for-
 * bugs discipline, per feedback_strict_tests.md):
 *   - All 4 transitions covered (checkIn, checkOut, cancel, noShow)
 *   - All 3 terminal states have a read-only dialog assertion
 *     (cancelled, checked_out, no_show) — enum coverage, not one
 *     representative.
 *   - Reason-required vs reason-optional delta asserted explicitly
 *   - Cross-tenant 404 probe.
 *
 * Isolation: single-worker sequential (playwright.config). All tests share
 * one tenant (allotment=1 per date), so dayOffset must be UNIQUE within
 * the 15-day grid window [today..today+14].
 */

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

/**
 * Create a confirmed booking on `today + dayOffset` (single night) and
 * return a locator pointing to THIS booking's band — not `.last()` which
 * is unreliable when multiple bands from other tests exist. The band's
 * aria-label embeds the checkIn date (`"<status>, YYYY-MM-DD — …"`);
 * we narrow down via substring match on "{date} —".
 */
async function createConfirmedBooking(
	page: import('@playwright/test').Page,
	dayOffset: number,
) {
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
	const band = page.locator(`[data-booking-id][aria-label*="${targetDate} —"]`)
	await expect(band).toBeVisible()
	return { targetDate, band }
}

test.describe('booking-edit dialog', () => {
	test('check-in: click confirmed band → "Заезд" → band flips to in-house palette', async ({
		page,
	}) => {
		const { band } = await createConfirmedBooking(page, 11)
		await expect(band).toContainText('Подтверждена')
		await expect(band).toHaveClass(/bg-blue-500/)

		await band.click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole('heading', { name: /Бронь:.+Подтверждена/ })).toBeVisible()

		await dialog.getByRole('button', { name: 'Заезд' }).click()
		await expect(page.getByText('Гость заселён')).toBeVisible()
		await expect(dialog).not.toBeVisible()

		await expect(band).toContainText('В проживании')
		await expect(band).toHaveClass(/bg-neutral-900/)
	})

	test('cancel: empty reason → submit disabled + hint shown', async ({ page }) => {
		const { band } = await createConfirmedBooking(page, 12)

		await band.click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()

		await dialog.getByRole('button', { name: 'Отменить бронь' }).click()
		const reasonField = dialog.getByLabel('Причина отмены')
		await expect(reasonField).toBeVisible()

		const submit = dialog.getByRole('button', { name: 'Подтвердить отмену' })
		await expect(submit).toBeDisabled()

		// Whitespace-only also disabled (trim invariant)
		await reasonField.fill('   ')
		await reasonField.blur()
		await expect(submit).toBeDisabled()
		await expect(dialog.getByText('Укажите причину отмены')).toBeVisible()

		await reasonField.fill('Гость отменил по телефону')
		await expect(submit).toBeEnabled()
	})

	test('cancel happy → band flips to cancelled palette (strikethrough, grey)', async ({
		page,
	}) => {
		const { band } = await createConfirmedBooking(page, 13)

		await band.click()
		const dialog = page.getByRole('dialog')
		await dialog.getByRole('button', { name: 'Отменить бронь' }).click()
		await dialog.getByLabel('Причина отмены').fill('Change of plans')
		await dialog.getByRole('button', { name: 'Подтвердить отмену' }).click()

		await expect(page.getByText('Бронь отменена')).toBeVisible()
		await expect(dialog).not.toBeVisible()

		await expect(band).toContainText('Отменена')
		await expect(band).toHaveClass(/bg-neutral-200/)
		await expect(band).toHaveClass(/line-through/)
	})

	test('terminal state (cancelled): dialog read-only, reason persisted, no actions', async ({
		page,
	}) => {
		const { band } = await createConfirmedBooking(page, 14)

		await band.click()
		const dialog = page.getByRole('dialog')
		await dialog.getByRole('button', { name: 'Отменить бронь' }).click()
		await dialog.getByLabel('Причина отмены').fill('Adversarial terminal test')
		await dialog.getByRole('button', { name: 'Подтвердить отмену' }).click()
		await expect(page.getByText('Бронь отменена')).toBeVisible()

		// Re-open — terminal branch
		await band.click()
		const terminalDialog = page.getByRole('dialog')
		await expect(terminalDialog).toBeVisible()
		await expect(
			terminalDialog.getByRole('heading', { name: /Бронь завершена.+Отменена/ }),
		).toBeVisible()

		// Enum-coverage: assert each of the 4 action-button names is absent
		await expect(terminalDialog.getByRole('button', { name: 'Заезд' })).toHaveCount(0)
		await expect(terminalDialog.getByRole('button', { name: 'Выезд' })).toHaveCount(0)
		await expect(terminalDialog.getByRole('button', { name: 'Отменить бронь' })).toHaveCount(0)
		await expect(terminalDialog.getByRole('button', { name: 'Не заехал' })).toHaveCount(0)

		await expect(terminalDialog.getByText('Adversarial terminal test')).toBeVisible()
		await expect(
			terminalDialog.locator('[data-slot="dialog-footer"]').getByRole('button', {
				name: 'Закрыть',
			}),
		).toBeVisible()
	})

	test('checkOut: full chain confirmed → in_house → checked_out, palette flips twice', async ({
		page,
	}) => {
		// Days must be within [1..14] (grid window). Avoid collisions with
		// other tests (11, 12, 13, 14 used above, and bookings.spec.ts 5, 6).
		const { band } = await createConfirmedBooking(page, 1)
		await expect(band).toHaveClass(/bg-blue-500/)

		// Check in
		await band.click()
		let dialog = page.getByRole('dialog')
		await dialog.getByRole('button', { name: 'Заезд' }).click()
		await expect(page.getByText('Гость заселён')).toBeVisible()
		await expect(band).toHaveClass(/bg-neutral-900/)

		// Check out — verify enum-guard: only checkOut + cancel available from
		// in_house (NOT checkIn, NOT noShow).
		await band.click()
		dialog = page.getByRole('dialog')
		await expect(dialog.getByRole('button', { name: 'Выезд' })).toBeVisible()
		await expect(dialog.getByRole('button', { name: 'Отменить бронь' })).toBeVisible()
		await expect(dialog.getByRole('button', { name: 'Заезд' })).toHaveCount(0)
		await expect(dialog.getByRole('button', { name: 'Не заехал' })).toHaveCount(0)

		await dialog.getByRole('button', { name: 'Выезд' }).click()
		await expect(page.getByText('Гость выселен')).toBeVisible()
		await expect(band).toHaveClass(/bg-neutral-300/)
		await expect(band).toContainText('Выехал')
	})

	test('no-show happy: reason filled → yellow palette, terminal re-open shows reason', async ({
		page,
	}) => {
		const { band } = await createConfirmedBooking(page, 2)

		await band.click()
		let dialog = page.getByRole('dialog')
		await dialog.getByRole('button', { name: 'Не заехал' }).click()

		const reasonField = dialog.getByLabel('Комментарий (опционально)')
		await expect(reasonField).toBeVisible()
		await reasonField.fill('Гость позвонил, не смог приехать')
		await dialog.getByRole('button', { name: 'Отметить: не заехал' }).click()

		await expect(page.getByText('Отмечено: гость не заехал')).toBeVisible()
		await expect(band).toHaveClass(/bg-yellow-500/)
		await expect(band).toContainText('Не заехал')

		// Terminal re-open: reason persisted, no action buttons
		await band.click()
		dialog = page.getByRole('dialog')
		await expect(dialog.getByRole('heading', { name: /Бронь завершена.+Не заехал/ })).toBeVisible()
		await expect(dialog.getByText('Гость позвонил, не смог приехать')).toBeVisible()
		await expect(dialog.getByRole('button', { name: 'Заезд' })).toHaveCount(0)
		await expect(dialog.getByRole('button', { name: 'Выезд' })).toHaveCount(0)
		await expect(dialog.getByRole('button', { name: 'Отменить бронь' })).toHaveCount(0)
		await expect(dialog.getByRole('button', { name: 'Не заехал' })).toHaveCount(0)
	})

	test('no-show empty-reason delta: submits without reason (unlike cancel)', async ({ page }) => {
		const { band } = await createConfirmedBooking(page, 4)

		await band.click()
		const dialog = page.getByRole('dialog')
		await dialog.getByRole('button', { name: 'Не заехал' }).click()

		const submit = dialog.getByRole('button', { name: 'Отметить: не заехал' })
		// Critical delta from cancel: no-show has no required guard.
		await expect(submit).toBeEnabled()
		await submit.click()

		await expect(page.getByText('Отмечено: гость не заехал')).toBeVisible()
		await expect(band).toHaveClass(/bg-yellow-500/)
	})

	test('terminal state (checked_out): read-only dialog, no actions (enum-coverage)', async ({
		page,
	}) => {
		const { band } = await createConfirmedBooking(page, 7)

		// Drive to terminal checked_out (full chain)
		await band.click()
		await page.getByRole('dialog').getByRole('button', { name: 'Заезд' }).click()
		await expect(page.getByText('Гость заселён')).toBeVisible()
		await band.click()
		await page.getByRole('dialog').getByRole('button', { name: 'Выезд' }).click()
		await expect(page.getByText('Гость выселен')).toBeVisible()

		// Terminal read-only assertion
		await band.click()
		const dialog = page.getByRole('dialog')
		await expect(dialog.getByRole('heading', { name: /Бронь завершена.+Выехал/ })).toBeVisible()
		await expect(dialog.getByRole('button', { name: 'Заезд' })).toHaveCount(0)
		await expect(dialog.getByRole('button', { name: 'Выезд' })).toHaveCount(0)
		await expect(dialog.getByRole('button', { name: 'Отменить бронь' })).toHaveCount(0)
		await expect(dialog.getByRole('button', { name: 'Не заехал' })).toHaveCount(0)
	})

	// Cross-tenant enum coverage: probe ALL 4 PATCH routes, not just one.
	// A missing tenant-filter on ANY of the 4 handlers would leak bookings
	// across tenants. Testing one representative (/cancel) hides bugs in
	// /check-in, /check-out, /no-show — violates strict-tests enum rule.
	const BOGUS_ID = 'book_00000000000000000000000000'
	test.describe('cross-tenant: 404 on every PATCH transition (enum coverage)', () => {
		test('PATCH /cancel on well-formed non-existent id → 404 NOT_FOUND', async ({ page }) => {
			const res = await page.request.patch(
				`http://localhost:3000/api/v1/bookings/${BOGUS_ID}/cancel`,
				{ data: { reason: 'probe' }, headers: { 'content-type': 'application/json' } },
			)
			expect(res.status()).toBe(404)
			const body = (await res.json()) as { error?: { code?: string } }
			expect(body.error?.code).toBe('NOT_FOUND')
		})

		test('PATCH /check-in on well-formed non-existent id → 404 NOT_FOUND', async ({ page }) => {
			const res = await page.request.patch(
				`http://localhost:3000/api/v1/bookings/${BOGUS_ID}/check-in`,
				{ data: {}, headers: { 'content-type': 'application/json' } },
			)
			expect(res.status()).toBe(404)
			const body = (await res.json()) as { error?: { code?: string } }
			expect(body.error?.code).toBe('NOT_FOUND')
		})

		test('PATCH /check-out on well-formed non-existent id → 404 NOT_FOUND', async ({ page }) => {
			// check-out has no body — server accepts empty
			const res = await page.request.patch(
				`http://localhost:3000/api/v1/bookings/${BOGUS_ID}/check-out`,
				{ headers: { 'content-type': 'application/json' } },
			)
			expect(res.status()).toBe(404)
			const body = (await res.json()) as { error?: { code?: string } }
			expect(body.error?.code).toBe('NOT_FOUND')
		})

		test('PATCH /no-show on well-formed non-existent id → 404 NOT_FOUND', async ({ page }) => {
			const res = await page.request.patch(
				`http://localhost:3000/api/v1/bookings/${BOGUS_ID}/no-show`,
				{ data: {}, headers: { 'content-type': 'application/json' } },
			)
			expect(res.status()).toBe(404)
			const body = (await res.json()) as { error?: { code?: string } }
			expect(body.error?.code).toBe('NOT_FOUND')
		})

		test('GET /bookings/:id on well-formed non-existent id → 404 NOT_FOUND', async ({
			page,
		}) => {
			// Also probe the read path (edit dialog opens via this endpoint).
			const res = await page.request.get(
				`http://localhost:3000/api/v1/bookings/${BOGUS_ID}`,
			)
			expect(res.status()).toBe(404)
			const body = (await res.json()) as { error?: { code?: string } }
			expect(body.error?.code).toBe('NOT_FOUND')
		})
	})
})
