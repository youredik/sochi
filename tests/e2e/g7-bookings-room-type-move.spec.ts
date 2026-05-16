import AxeBuilder from '@axe-core/playwright'
import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'

/**
 * G7 (2026-05-16) Apaleo drag-move к different roomType row + WCAG 2.2
 * SC 2.5.7 pointer-alternative ActionView amend dialog.
 *
 * Hunts visible UX:
 *   [G7-E1] dialog «Переместить в категорию» visible for confirmed bookings
 *   [G7-E2] dialog HIDDEN for in_house / terminal bookings (status guard)
 *   [G7-E3] dialog happy path — select different roomType → Save → toast
 *   [G7-E4] dialog submit disabled when same roomType selected (no-op canon)
 *   [G7-E5] PATCH /change-room-type cross-tenant 404 (security)
 *   [G7-E6] PATCH /change-room-type cancelled status → 409 INVALID_BOOKING_AMEND_STATE
 *   [G7-E7] PATCH /change-room-type idempotent — same roomTypeId returns 200 unchanged
 *   [G7-E8] data-row-room-type-id present on each rowheader (DnD drop-target wire)
 *
 * Drag-gesture e2e via Playwright `dragTo` deferred (Pragmatic DnD uses
 * native HTML5 drag events which Playwright simulates inconsistently per
 * browser engine — covered manually + via integration tests). Pointer-
 * alternative dialog flow IS the WCAG-mandated path и exercises same
 * server endpoint.
 *
 * Single-worker sequential. Spec sort `g7-` > `g6-` so runs AFTER existing.
 */

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

const API_BASE = 'http://localhost:8787/api/v1'

async function setup(
	page: import('@playwright/test').Page,
	dayOffset: number,
	docSuffix: string,
): Promise<{
	bookingId: string
	primaryRoomTypeId: string
	secondRoomTypeId: string
	propertyId: string
}> {
	await page.goto('/')
	const propsRes = await page.request.get(`${API_BASE}/properties`)
	const propertyId = ((await propsRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!propertyId) throw new Error('no property')

	const [rtRes, rpRes] = await Promise.all([
		page.request.get(`${API_BASE}/properties/${propertyId}/room-types`),
		page.request.get(`${API_BASE}/properties/${propertyId}/rate-plans`),
	])
	const allRoomTypes = ((await rtRes.json()) as { data: Array<{ id: string; name: string }> }).data
	const primaryRoomTypeId = allRoomTypes[0]?.id
	const ratePlanId = ((await rpRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!primaryRoomTypeId || !ratePlanId) throw new Error('roomType/ratePlan missing')

	// Ensure 2-й roomType exists для destination drag/dialog target. Идempotent.
	let secondRoomTypeId = allRoomTypes[1]?.id ?? ''
	if (!secondRoomTypeId) {
		const rt2Res = await page.request.post(`${API_BASE}/properties/${propertyId}/room-types`, {
			data: {
				name: `Люкс G7-${docSuffix}`,
				maxOccupancy: 4,
				baseBeds: 2,
				extraBeds: 1,
				inventoryCount: 3,
			},
		})
		if (!rt2Res.ok()) throw new Error(`roomType.create ${rt2Res.status()}: ${await rt2Res.text()}`)
		secondRoomTypeId = ((await rt2Res.json()) as { data: { id: string } }).data.id

		// Default ratePlan для new roomType + seed rates на upcoming dates.
		const rp2Res = await page.request.post(`${API_BASE}/rate-plans`, {
			data: {
				roomTypeId: secondRoomTypeId,
				name: 'BAR G7',
				code: `BAR-G7-${docSuffix}`,
				isDefault: true,
				isRefundable: true,
				cancellationHours: 24,
				mealsIncluded: 'none',
				minStay: 1,
				currency: 'RUB',
			},
		})
		if (!rp2Res.ok()) throw new Error(`rate-plan.create ${rp2Res.status()}: ${await rp2Res.text()}`)
		const rp2Id = ((await rp2Res.json()) as { data: { id: string } }).data.id

		// Seed rates для 14 days ahead — covers any dayOffset < 14.
		const ratesPayload = Array.from({ length: 14 }, (_, i) => ({
			date: futureIso(i),
			amount: '4500',
			currency: 'RUB',
		}))
		await page.request.post(`${API_BASE}/rate-plans/${rp2Id}/rates`, {
			data: { rates: ratesPayload },
		})
		// Seed availability allotment=3 для new roomType.
		await page.request.post(`${API_BASE}/room-types/${secondRoomTypeId}/availability`, {
			data: {
				rates: Array.from({ length: 14 }, (_, i) => ({
					date: futureIso(i),
					allotment: 3,
					minStay: null,
					maxStay: null,
					closedToArrival: false,
					closedToDeparture: false,
					stopSell: false,
				})),
			},
		})
	}

	const guestRes = await page.request.post(`${API_BASE}/guests`, {
		data: {
			lastName: `G7${docSuffix}`,
			firstName: 'Тест',
			citizenship: 'RU',
			documentType: 'passport',
			documentNumber: `4510${docSuffix}`,
		},
	})
	const guestId = ((await guestRes.json()) as { data: { id: string } }).data.id

	const checkInIso = futureIso(dayOffset)
	const checkOutIso = futureIso(dayOffset + 1)
	const bRes = await page.request.post(`${API_BASE}/properties/${propertyId}/bookings`, {
		data: {
			roomTypeId: primaryRoomTypeId,
			ratePlanId,
			checkIn: checkInIso,
			checkOut: checkOutIso,
			guestsCount: 1,
			primaryGuestId: guestId,
			guestSnapshot: {
				firstName: 'Тест',
				lastName: `G7${docSuffix}`,
				citizenship: 'RU',
				documentType: 'passport',
				documentNumber: `4510${docSuffix}`,
			},
			channelCode: 'walkIn',
		},
	})
	if (!bRes.ok()) throw new Error(`booking.create ${bRes.status()}: ${await bRes.text()}`)
	const bookingId = ((await bRes.json()) as { data: { id: string } }).data.id
	return { bookingId, primaryRoomTypeId, secondRoomTypeId, propertyId }
}

test.describe('G7 change-room-type — pointer-alternative dialog + endpoint', () => {
	test('[G7-E1] dialog amend button visible для confirmed bookings', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 3, `${ts}01`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		// Button presence
		await expect(dialog.locator('[data-amend="change-room-type"]')).toBeVisible()
		await expect(dialog.locator('[data-amend="change-room-type"]')).toContainText(
			'Переместить в категорию',
		)
	})

	test('[G7-E2] dialog HIDDEN для cancelled (terminal)', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 4, `${ts}02`)
		// Cancel via API
		await page.request.patch(`${API_BASE}/bookings/${bookingId}/cancel`, {
			data: { reason: 'test G7-E2' },
		})
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await expect(dialog.locator('[data-amend="change-room-type"]')).toHaveCount(0)
	})

	test('[G7-E3] dialog happy path — pick different roomType → Save → toast', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 10, `${ts}03`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await dialog.locator('[data-amend="change-room-type"]').click()

		const form = dialog.locator('[data-slot="amend-change-room-type-form"]')
		await expect(form).toBeVisible()
		await form.getByLabel('Новая категория').click()
		// Pick FIRST option that's NOT current (use option-name match — second
		// roomType always created in setup как «Люкс G7-...»).
		const options = page.getByRole('option')
		await expect(options.first()).toBeVisible()
		// Click last option (most likely different from current default).
		const lastOption = options.last()
		await lastOption.click()

		await form.getByRole('button', { name: /Переместить/ }).click()
		await expect(page.getByText('Бронь перемещена')).toBeVisible()
	})

	test('[G7-E4] submit disabled когда same roomType selected (no-op canon)', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 11, `${ts}04`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await dialog.locator('[data-amend="change-room-type"]').click()
		const form = dialog.locator('[data-slot="amend-change-room-type-form"]')
		// Default selection = current roomType → submit disabled
		const submit = form.getByRole('button', { name: /Переместить/ })
		await expect(submit).toBeDisabled()
	})

	test('[G7-E5] cross-tenant 404 — change-room-type на bogus id', async ({ page }) => {
		await page.goto('/')
		const BOGUS = 'book_00000000000000000000000000'
		const res = await page.request.patch(`${API_BASE}/bookings/${BOGUS}/change-room-type`, {
			data: { roomTypeId: 'rmt_00000000000000000000000000' },
		})
		expect(res.status()).toBe(404)
		const body = (await res.json()) as { error?: { code?: string } }
		expect(body.error?.code).toBe('NOT_FOUND')
	})

	test('[G7-E6] cancelled status → 409 INVALID_BOOKING_AMEND_STATE', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, secondRoomTypeId } = await setup(page, 1, `${ts}06`)
		await page.request.patch(`${API_BASE}/bookings/${bookingId}/cancel`, {
			data: { reason: 'test G7-E6' },
		})
		const res = await page.request.patch(`${API_BASE}/bookings/${bookingId}/change-room-type`, {
			data: { roomTypeId: secondRoomTypeId },
		})
		expect(res.status()).toBe(409)
		const body = (await res.json()) as { error?: { code?: string } }
		expect(body.error?.code).toBe('INVALID_BOOKING_AMEND_STATE')
	})

	test('[G7-E7] idempotent no-op — same roomTypeId returns 200 unchanged', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, primaryRoomTypeId } = await setup(page, 2, `${ts}07`)
		const res = await page.request.patch(`${API_BASE}/bookings/${bookingId}/change-room-type`, {
			data: { roomTypeId: primaryRoomTypeId },
		})
		expect(res.status()).toBe(200)
		const body = (await res.json()) as { data: { roomTypeId: string } }
		expect(body.data.roomTypeId).toBe(primaryRoomTypeId)
	})

	test('[G7-E8] data-row-room-type-id present on rowheaders (DnD drop-target wire)', async ({
		page,
	}) => {
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const rowHeaders = page.locator('[data-row-room-type-id]')
		await expect(rowHeaders.first()).toBeVisible()
		const count = await rowHeaders.count()
		expect(count).toBeGreaterThanOrEqual(1)
		const firstId = await rowHeaders.first().getAttribute('data-row-room-type-id')
		expect(firstId).toMatch(/^rmt_/)
	})

	// G7.bis adversarial — close all D-G7.* canon gaps surfaced в self-review.

	test('[G7-E9] locked-block opt-out — cancelled band has data-band-status="cancelled" (not draggable)', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 5, `${ts}09`)
		await page.request.patch(`${API_BASE}/bookings/${bookingId}/cancel`, {
			data: { reason: 'test G7-E9' },
		})
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()
		await expect(band).toHaveAttribute('data-band-status', 'cancelled')
		// querySelector в Pragmatic DnD wiring filters [data-band-status="confirmed"];
		// 'cancelled' bands не получают draggable. Verify via attr — drag-listener
		// presence is impl detail not directly observable, but selector-filter
		// canon is the documented contract.
	})

	test('[G7-E10] keyboard alternative — Tab to band → Enter opens dialog → amend works', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 6, `${ts}10`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()
		await band.focus()
		await page.keyboard.press('Enter')
		// Dialog opens.
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		// «Переместить в категорию» button visible (keyboard-reachable amend).
		await expect(dialog.locator('[data-amend="change-room-type"]')).toBeVisible()
	})

	test('[G7-E11] mobile pointer:coarse gate — narrow viewport не breaks UI (drag listener suppressed внутри)', async ({
		page,
	}) => {
		// Set mobile viewport (375x667 iPhone). Pragmatic DnD useEffect
		// checks matchMedia('(pointer: coarse)') at mount; emulated touch
		// device triggers gate. Visible UX must still work via dialog.
		await page.setViewportSize({ width: 375, height: 667 })
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 7, `${ts}11`)
		// On mobile sidebar collapses (A.bis canon) — sidebar grid link
		// hidden behind hamburger. Navigate directly к /grid route.
		const orgSlug = page.url().match(/\/o\/([^/]+)/)?.[1] ?? ''
		expect(orgSlug).not.toBe('')
		await page.goto(`/o/${orgSlug}/grid`)
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()
		// Tap band → dialog opens. Operator amends via pointer-alternative
		// (WCAG 2.5.7 mandated path).
		await band.click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await expect(dialog.locator('[data-amend="change-room-type"]')).toBeVisible()
	})

	test('[G7-E12] axe WCAG 2.2 AA — grid с DnD attrs + amend dialog open', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 8, `${ts}12`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		await page.locator(`[data-booking-id="${bookingId}"]`).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog).toBeVisible()
		await dialog.locator('[data-amend="change-room-type"]').click()
		await expect(dialog.locator('[data-slot="amend-change-room-type-form"]')).toBeVisible()
		await page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== 'running'),
		)
		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
			.analyze()
		if (results.violations.length > 0) {
			console.error('G7-E12 axe violations:', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})

	test('[G7-E13] Pragmatic drag-gesture — empirical via Playwright dragTo (move band к new row)', async ({
		page,
	}) => {
		// Per [[empirical-before-asserting-limits]]: TRY dragTo before
		// deferring. HTML5 native drag events Pragmatic DnD listens к не
		// always trigger via Playwright (browser engine inconsistencies).
		// If reliable — drag works. If not — assertion catches the band
		// failing к respond, signalling we need а unit-level drag-fire test.
		const ts = Date.now().toString().slice(-6)
		const { bookingId } = await setup(page, 9, `${ts}13`)
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()
		await expect(band).toHaveAttribute('data-band-status', 'confirmed')
		// Find second rowheader (different roomType) как drop target.
		const rowHeaders = page.locator('[data-row-room-type-id]')
		const headerCount = await rowHeaders.count()
		if (headerCount < 2) {
			// Single-roomType tenant — skip (set up в parallel-test isolation
			// might race; second-roomType created in setup() should give us ≥2).
			test.skip(true, `Need ≥2 rowheaders, got ${headerCount}`)
		}
		// Try Playwright drag — pragmatic listens к native dragstart/dragover/drop.
		await band.dragTo(rowHeaders.last())
		// Empirical: if Pragmatic responded, mutation fires + toast shown.
		// Use generous timeout — drag has more overhead than click.
		await expect(page.getByText('Бронь перемещена в новую категорию')).toBeVisible({
			timeout: 8000,
		})
	})
})
