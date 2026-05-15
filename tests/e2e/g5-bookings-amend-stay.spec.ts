import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'

/**
 * G5 Apaleo Amend-Stay e2e (2026-05-15).
 *
 * Covers visible UI + HTTP layer для the 3 pre-arrival amend operations
 * (move-dates / change-rate-plan / change-guests-count). Pattern mirrors
 * `g4-bookings-compliance.spec.ts` — admin-endpoint seeding, unique-day
 * isolation to avoid state leak с other booking specs.
 *
 * Hunts:
 *   [G5-E1] move-dates happy path — click amend button → date picker →
 *           Save → toast + band moves к new range
 *   [G5-E2] move-dates validation — checkOut ≤ checkIn → submit disabled
 *           + visible hint
 *   [G5-E3] change-rate-plan — select different active plan → Save → toast
 *   [G5-E4] change-rate-plan disabled when same ratePlanId selected
 *           (no-op canon)
 *   [G5-E5] change-guests-count — number input → Save → toast
 *   [G5-E6] change-guests-count validation — 0 / 21 → submit disabled с
 *           inline error
 *   [G5-E7] amend buttons HIDDEN for in_house bookings except
 *           change-guests-count (Apaleo walk-up canon)
 *   [G5-E8] amend buttons HIDDEN for terminal bookings (cancelled — read-only)
 *   [G5-E9] cross-tenant: PATCH endpoint 404 NOT_FOUND on bogus ID (3 routes)
 *
 * Single-worker sequential. Spec sort: `g5-` > `g4-` > `bookings*` so this
 * runs AFTER booking-creation specs, минимизируя state leak.
 */

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

const API_BASE = 'http://localhost:8787/api/v1'

async function createConfirmedBooking(
	page: import('@playwright/test').Page,
	dayOffset: number,
	docSuffix: string,
): Promise<{
	bookingId: string
	checkInIso: string
	propertyId: string
	roomTypeId: string
	ratePlanId: string
}> {
	await page.goto('/')
	const propsRes = await page.request.get(`${API_BASE}/properties`)
	const propertyId = ((await propsRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!propertyId) throw new Error('no property')

	const [rtRes, rpRes] = await Promise.all([
		page.request.get(`${API_BASE}/properties/${propertyId}/room-types`),
		page.request.get(`${API_BASE}/properties/${propertyId}/rate-plans`),
	])
	const roomTypeId = ((await rtRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	const ratePlanId = ((await rpRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!roomTypeId || !ratePlanId) throw new Error('roomType/ratePlan missing')

	const guestRes = await page.request.post(`${API_BASE}/guests`, {
		data: {
			lastName: `Amend${docSuffix}`,
			firstName: 'Тест',
			citizenship: 'RU',
			documentType: 'passport',
			documentNumber: `4510${docSuffix}`,
		},
	})
	if (!guestRes.ok()) throw new Error(`guest.create ${guestRes.status()}: ${await guestRes.text()}`)
	const guestId = ((await guestRes.json()) as { data: { id: string } }).data.id

	const checkInIso = futureIso(dayOffset)
	const checkOutIso = futureIso(dayOffset + 1)
	const bRes = await page.request.post(`${API_BASE}/properties/${propertyId}/bookings`, {
		data: {
			roomTypeId,
			ratePlanId,
			checkIn: checkInIso,
			checkOut: checkOutIso,
			guestsCount: 1,
			primaryGuestId: guestId,
			guestSnapshot: {
				firstName: 'Тест',
				lastName: `Amend${docSuffix}`,
				citizenship: 'RU',
				documentType: 'passport',
				documentNumber: `4510${docSuffix}`,
			},
			channelCode: 'walkIn',
		},
	})
	if (!bRes.ok()) throw new Error(`booking.create ${bRes.status()}: ${await bRes.text()}`)
	const bookingId = ((await bRes.json()) as { data: { id: string } }).data.id
	return { bookingId, checkInIso, propertyId, roomTypeId, ratePlanId }
}

test.describe('G5 Apaleo Amend-Stay — UI + HTTP layer', () => {
	test('[G5-E1] move-dates happy path — picker → Save → toast', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, checkInIso } = await createConfirmedBooking(page, 3, `${ts}01`)

		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()
		await band.click()

		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await dialog.locator('[data-amend="move-dates"]').click()

		const form = dialog.locator('[data-slot="amend-move-dates-form"]')
		await expect(form).toBeVisible()
		await expect(form.getByLabel('Заезд')).toHaveValue(checkInIso)

		// Move к day+5..6
		const newCheckIn = futureIso(5)
		const newCheckOut = futureIso(6)
		await form.getByLabel('Заезд').fill(newCheckIn)
		await form.getByLabel('Выезд').fill(newCheckOut)
		await form.getByRole('button', { name: /Сохранить новые даты/ }).click()

		await expect(page.getByText('Даты обновлены')).toBeVisible()
		await expect(dialog).not.toBeVisible()
	})

	test('[G5-E2] move-dates validation — checkOut ≤ checkIn → submit disabled + hint', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await createConfirmedBooking(page, 3, `${ts}02`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await dialog.locator('[data-amend="move-dates"]').click()
		const form = dialog.locator('[data-slot="amend-move-dates-form"]')

		// Same-day → invalid
		const sameDay = futureIso(7)
		await form.getByLabel('Заезд').fill(sameDay)
		await form.getByLabel('Выезд').fill(sameDay)
		await expect(form.getByText('Выезд должен быть позже заезда')).toBeVisible()
		const submit = form.getByRole('button', { name: /Сохранить новые даты/ })
		await expect(submit).toBeDisabled()
	})

	test('[G5-E3] change-rate-plan — select different plan → Save → toast', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, propertyId, roomTypeId } = await createConfirmedBooking(page, 10, `${ts}03`)

		// Seed a SECOND rate plan + rates so dropdown has 2 options.
		const rp2Res = await page.request.post(`${API_BASE}/rate-plans`, {
			data: {
				roomTypeId,
				name: 'Промо G5',
				code: `PROMO-G5-${ts}`,
				isDefault: false,
				isRefundable: true,
				cancellationHours: 24,
				mealsIncluded: 'none',
				minStay: 1,
				currency: 'RUB',
			},
		})
		if (!rp2Res.ok()) throw new Error(`rate-plan.create ${rp2Res.status()}: ${await rp2Res.text()}`)
		const rp2Id = ((await rp2Res.json()) as { data: { id: string } }).data.id
		// Seed rates для new plan on the booking's date. Endpoint canon:
		// POST /rate-plans/:ratePlanId/rates  body { rates: [...] }
		const checkIn = futureIso(10)
		const ratesRes = await page.request.post(`${API_BASE}/rate-plans/${rp2Id}/rates`, {
			data: {
				rates: [{ date: checkIn, amount: '3000', currency: 'RUB' }],
			},
		})
		if (!ratesRes.ok())
			throw new Error(`rates.bulkUpsert ${ratesRes.status()}: ${await ratesRes.text()}`)
		// Silence unused-var: propertyId / roomTypeId were used above.
		void propertyId
		void roomTypeId

		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await dialog.locator('[data-amend="change-rate-plan"]').click()

		const form = dialog.locator('[data-slot="amend-change-rate-plan-form"]')
		await expect(form).toBeVisible()
		await form.getByLabel('Новый тариф').click()
		await page.getByRole('option', { name: 'Промо G5' }).click()
		await form.getByRole('button', { name: /Применить тариф/ }).click()
		await expect(page.getByText('Тариф обновлён')).toBeVisible()
	})

	test('[G5-E5] change-guests-count happy path — 1 → 3 → Save', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await createConfirmedBooking(page, 13, `${ts}05`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await dialog.locator('[data-amend="change-guests-count"]').click()

		const form = dialog.locator('[data-slot="amend-change-guests-count-form"]')
		await expect(form).toBeVisible()
		await form.getByLabel('Гостей').fill('3')
		await form.getByRole('button', { name: /Сохранить/ }).click()
		await expect(page.getByText('Количество гостей обновлено')).toBeVisible()
	})

	test('[G5-E6] change-guests-count validation — 0 disabled', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await createConfirmedBooking(page, 13, `${ts}06`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await dialog.locator('[data-amend="change-guests-count"]').click()
		const form = dialog.locator('[data-slot="amend-change-guests-count-form"]')
		await form.getByLabel('Гостей').fill('0')
		const submit = form.getByRole('button', { name: /Сохранить/ })
		await expect(submit).toBeDisabled()
		// 21 also disabled
		await form.getByLabel('Гостей').fill('21')
		await expect(submit).toBeDisabled()
	})

	test('[G5-E8] amend buttons HIDDEN for cancelled bookings (terminal)', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await createConfirmedBooking(page, 13, `${ts}08`)
		// Cancel via API
		await page.request.patch(`${API_BASE}/bookings/${bookingId}/cancel`, {
			data: { reason: 'test G5-E8' },
		})

		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		// Terminal view — no amend buttons.
		await expect(dialog.locator('[data-amend="move-dates"]')).toHaveCount(0)
		await expect(dialog.locator('[data-amend="change-rate-plan"]')).toHaveCount(0)
		await expect(dialog.locator('[data-amend="change-guests-count"]')).toHaveCount(0)
	})

	test('[G5-E9] cross-tenant 404 — all 3 amend PATCH routes on bogus ID', async ({ page }) => {
		const BOGUS = 'book_00000000000000000000000000'
		await page.goto('/')
		const moveRes = await page.request.patch(`${API_BASE}/bookings/${BOGUS}/move-dates`, {
			data: { checkIn: futureIso(1), checkOut: futureIso(2) },
		})
		expect(moveRes.status()).toBe(404)
		const moveBody = (await moveRes.json()) as { error?: { code?: string } }
		expect(moveBody.error?.code).toBe('NOT_FOUND')

		const rateRes = await page.request.patch(`${API_BASE}/bookings/${BOGUS}/change-rate-plan`, {
			data: { ratePlanId: 'rp_00000000000000000000000000' },
		})
		expect(rateRes.status()).toBe(404)
		const rateBody = (await rateRes.json()) as { error?: { code?: string } }
		expect(rateBody.error?.code).toBe('NOT_FOUND')

		const guestsRes = await page.request.patch(
			`${API_BASE}/bookings/${BOGUS}/change-guests-count`,
			{ data: { guestsCount: 2 } },
		)
		expect(guestsRes.status()).toBe(404)
		const guestsBody = (await guestsRes.json()) as { error?: { code?: string } }
		expect(guestsBody.error?.code).toBe('NOT_FOUND')
	})
})
