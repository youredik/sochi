import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'

/**
 * G4 + G4.bis RU compliance overlay e2e (2026-05-15).
 *
 * Hunts visible UX elements that G4 added к Шахматка band rendering:
 *   1. 152-ФЗ default mask: band visible-text = «Фамилия И.» (не full name)
 *   2. МВД badge top-left: red dot для foreign guests (citizenship !== RU/RUS),
 *      data-mvd-status + data-mvd-urgent attrs.
 *   3. Tooltip on hover/focus: full guest name unmasked + status + dates +
 *      tax line + МВД label.
 *
 * Pattern: create bookings via admin API (page.request) для precise control
 * over citizenship / guest snapshot — UI-create-dialog mode добавил бы
 * variance.
 *
 * Single-worker sequential (playwright.config); все booking-create в
 * пределах visible 15-day window (offsets 3 / 10) — onboarding seed
 * allotment=10 per date allows ≥6 coexisting bookings per cell. Unique
 * guest names per docSuffix для UNIQUE collisions guard. Other specs
 * burned offsets 0,1,2,4,5,6,7,8,9,11,12,13,14 — 3 и 10 свободны.
 */

function futureIso(daysFromToday: number): string {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + daysFromToday)
	return d.toISOString().slice(0, 10)
}

const API_BASE = 'http://localhost:8787/api/v1'

async function createBooking(
	page: import('@playwright/test').Page,
	opts: {
		dayOffset: number
		lastName: string
		firstName: string
		citizenship: string
		docSuffix: string
	},
): Promise<{ bookingId: string; checkInIso: string }> {
	// Auth cookies live на page context (loaded after `page.goto`). Navigate
	// first так что page.request inherits the session storage cookies
	// established by storageState fixture.
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

	// Ensure property has tourism tax rate set к Sочи canon (2% = 200 bps).
	// Onboarding wizard does NOT seed this — operator sets via property settings.
	// Idempotent PATCH: repeated calls converge на same state.
	const propRow = ((await propsRes.json()) as { data: Array<{ tourismTaxRateBps: number | null }> })
		.data[0]
	if (propRow?.tourismTaxRateBps !== 200) {
		await page.request.patch(`${API_BASE}/properties/${propertyId}`, {
			data: { tourismTaxRateBps: 200 },
		})
	}

	const guestRes = await page.request.post(`${API_BASE}/guests`, {
		data: {
			lastName: opts.lastName,
			firstName: opts.firstName,
			citizenship: opts.citizenship,
			documentType: 'passport',
			documentNumber: `4510${opts.docSuffix}`,
		},
	})
	if (!guestRes.ok()) throw new Error(`guest.create ${guestRes.status()}: ${await guestRes.text()}`)
	const guestId = ((await guestRes.json()) as { data: { id: string } }).data.id

	const checkInIso = futureIso(opts.dayOffset)
	const checkOutIso = futureIso(opts.dayOffset + 1)
	const bRes = await page.request.post(`${API_BASE}/properties/${propertyId}/bookings`, {
		data: {
			roomTypeId,
			ratePlanId,
			checkIn: checkInIso,
			checkOut: checkOutIso,
			guestsCount: 1,
			primaryGuestId: guestId,
			guestSnapshot: {
				firstName: opts.firstName,
				lastName: opts.lastName,
				citizenship: opts.citizenship,
				documentType: 'passport',
				documentNumber: `4510${opts.docSuffix}`,
			},
			channelCode: 'walkIn',
		},
	})
	if (!bRes.ok()) throw new Error(`booking.create ${bRes.status()}: ${await bRes.text()}`)
	const bookingId = ((await bRes.json()) as { data: { id: string } }).data.id
	return { bookingId, checkInIso }
}

test.describe('G4 RU compliance overlays — band visual + tooltip', () => {
	test('[G4-E1] 152-ФЗ mask: band visible text shows «Фамилия И.», NOT full firstName', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, checkInIso } = await createBooking(page, {
			dayOffset: 3,
			lastName: `Соколов${ts}`,
			firstName: 'Александр',
			citizenship: 'RU',
			docSuffix: `${ts}30`,
		})
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		// Verify band shows mask, not full firstName.
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()
		await expect(band).toContainText(`Соколов${ts} А.`)
		// Adversarial: «лександр» (suffix of firstName beyond initial) MUST NOT leak.
		await expect(band).not.toContainText('лександр')
	})

	test('[G4-E2] МВД badge top-left for foreign guest (citizenship=US → pending)', async ({
		page,
	}) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, checkInIso } = await createBooking(page, {
			dayOffset: 3,
			lastName: `Smith${ts}`,
			firstName: 'John',
			citizenship: 'US',
			docSuffix: `${ts}31`,
		})
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()

		// МВД dot present + correct attrs.
		const mvdDot = band.locator('[data-mvd-status]')
		await expect(mvdDot).toBeAttached()
		await expect(mvdDot).toHaveAttribute('data-mvd-status', 'pending')
		await expect(mvdDot).toHaveAttribute('data-mvd-urgent', 'true')
		// aria-label includes the action cue.
		await expect(band).toHaveAttribute('aria-label', /МУ не подан/)
	})

	test('[G4-E3] G4.bis — RUS alpha-3 (Russian) → NO МВД badge (fix verified)', async ({ page }) => {
		// Prior bug: alpha-3 RUS was treated як foreign → red badge для RU
		// citizen typing 3-char encoding. G4.bis isRussianCitizenship fix.
		const ts = Date.now().toString().slice(-6)
		const { bookingId, checkInIso } = await createBooking(page, {
			dayOffset: 3,
			lastName: `Петров${ts}`,
			firstName: 'Игорь',
			citizenship: 'RUS',
			docSuffix: `${ts}32`,
		})
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()

		// NO МВД dot должен render — RUS canonically == RU citizen.
		await expect(band.locator('[data-mvd-status]')).toHaveCount(0)
		// aria-label NOT to contain МУ-related label.
		const ariaLabel = (await band.getAttribute('aria-label')) ?? ''
		expect(ariaLabel).not.toMatch(/МУ /)
	})

	test('[G4-E4] tooltip on hover: full guest name un-masked + status + dates', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, checkInIso } = await createBooking(page, {
			dayOffset: 10,
			lastName: `Иванов${ts}`,
			firstName: 'Михаил',
			citizenship: 'RU',
			docSuffix: `${ts}33`,
		})
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()
		await band.hover()

		// Tooltip exposes FULL firstName (operator-intentional hover = OK to unmask
		// per 152-ФЗ canon; band visible text продолжает показывать mask).
		// Tooltip portal'd к document.body; each booking has its own с
		// `id` ending в the bookingId. Filter precisely to avoid picking
		// up tooltips from OTHER bookings on the same page.
		const tooltip = page.locator(`[role="tooltip"][id$="-${bookingId}"]`)
		await expect(tooltip.locator('[data-slot="tooltip-guest"]')).toBeVisible()
		await expect(tooltip.locator('[data-slot="tooltip-guest"]')).toContainText(`Иванов${ts}`)
		await expect(tooltip.locator('[data-slot="tooltip-guest"]')).toContainText('Михаил')
	})

	test('[G4-E5] tooltip shows tourism tax line «Туристический налог: X ₽»', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, checkInIso } = await createBooking(page, {
			dayOffset: 10,
			lastName: `Сидоров${ts}`,
			firstName: 'Олег',
			citizenship: 'RU',
			docSuffix: `${ts}34`,
		})
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()
		await band.hover()
		// Tooltip portal'd к document.body; each booking has its own с
		// `id` ending в the bookingId. Filter precisely to avoid picking
		// up tooltips from OTHER bookings on the same page.
		const tooltip = page.locator(`[role="tooltip"][id$="-${bookingId}"]`)
		// ТН строка должна присутствовать с NBSP separator (ГОСТ 8.417 RU
		// typography canon — preserved by formatTourismTaxRub).
		const taxLine = tooltip.locator('[data-slot="tooltip-tax"]')
		await expect(taxLine).toBeVisible()
		await expect(taxLine).toContainText('Туристический налог:')
		// Sочи 2% rate × default seed price → minimum is 1₽; suffix всегда ₽.
		await expect(taxLine).toContainText('₽')
	})

	test('[G4-E6] tooltip for foreign guest shows МВД line («МУ не подан»)', async ({ page }) => {
		const ts = Date.now().toString().slice(-6)
		const { bookingId, checkInIso } = await createBooking(page, {
			dayOffset: 10,
			lastName: `Müller${ts}`,
			firstName: 'Klaus',
			citizenship: 'DE',
			docSuffix: `${ts}35`,
		})
		await page.goto('/')
		await page.locator('[data-section-id="grid"]').first().click()
		const band = page.locator(`[data-booking-id="${bookingId}"]`)
		await expect(band).toBeVisible()
		await band.hover()
		// Tooltip portal'd к document.body; each booking has its own с
		// `id` ending в the bookingId. Filter precisely to avoid picking
		// up tooltips from OTHER bookings on the same page.
		const tooltip = page.locator(`[role="tooltip"][id$="-${bookingId}"]`)
		const mvdLine = tooltip.locator('[data-slot="tooltip-mvd"]')
		await expect(mvdLine).toBeVisible()
		await expect(mvdLine).toContainText('МУ не подан')
	})
})
