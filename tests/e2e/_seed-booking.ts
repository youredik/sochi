import type { Page } from '@playwright/test'

/**
 * `seedBookingFixture` — создаёт ОДНО valid booking через API для smoke specs
 * которым нужен live визуальный evidence rendering booking band (e.g. status
 * palette colors на chessboard).
 *
 * Pattern reused из payments.spec.ts seedFolioFixture, упрощённый — без folio
 * line/payment seeding (band-only evidence).
 *
 * Idempotent через `docSuffix` — uniquify document number / guest fixtures
 * (предотвращает UNIQUE collisions если same suffix re-used в parallel runs).
 */
export async function seedBookingFixture(
	page: Page,
	opts: { futureDays?: number; docSuffix?: string } = {},
): Promise<{ bookingId: string; orgSlug: string; checkInIso: string }> {
	const futureDays = opts.futureDays ?? 1
	const docSuffix = opts.docSuffix ?? Date.now().toString().slice(-6)
	const apiBase = (await page.evaluate(() => location.origin)).replace(':5273', ':3000') + '/api/v1'

	// Pull active org slug + first property.
	const meRes = await page.request.get(`${apiBase}/auth/me`)
	let orgSlug: string
	if (meRes.ok()) {
		const me = await meRes.json() as { activeOrganizationSlug?: string }
		orgSlug = me.activeOrganizationSlug ?? ''
	} else {
		// Fallback: parse current URL.
		orgSlug = page.url().match(/\/o\/([a-z0-9-]+)/)?.[1] ?? ''
	}
	if (!orgSlug) throw new Error('seedBookingFixture: no active org')

	const propsRes = await page.request.get(`${apiBase}/properties`)
	if (!propsRes.ok()) throw new Error(`properties.list HTTP ${propsRes.status()}`)
	const propertyId = ((await propsRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!propertyId) throw new Error('seedBookingFixture: no property')

	const [roomTypesRes, ratePlansRes] = await Promise.all([
		page.request.get(`${apiBase}/properties/${propertyId}/room-types`),
		page.request.get(`${apiBase}/properties/${propertyId}/rate-plans`),
	])
	const roomTypeId = ((await roomTypesRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	const ratePlanId = ((await ratePlansRes.json()) as { data: Array<{ id: string }> }).data[0]?.id
	if (!roomTypeId || !ratePlanId) {
		throw new Error('seedBookingFixture: roomType/ratePlan missing — wizard incomplete')
	}

	// Create guest.
	const guestRes = await page.request.post(`${apiBase}/guests`, {
		data: {
			lastName: `Гость-${docSuffix}`,
			firstName: 'Демо',
			citizenship: 'RU',
			documentType: 'passport',
			documentNumber: `4510${docSuffix.padStart(6, '0')}`,
		},
	})
	if (!guestRes.ok()) throw new Error(`guest.create HTTP ${guestRes.status()}: ${await guestRes.text()}`)
	const guestId = ((await guestRes.json()) as { data: { id: string } }).data.id

	const checkInIso = futureIso(futureDays)
	const checkOutIso = futureIso(futureDays + 1)
	const bookingRes = await page.request.post(`${apiBase}/properties/${propertyId}/bookings`, {
		data: {
			roomTypeId,
			ratePlanId,
			checkIn: checkInIso,
			checkOut: checkOutIso,
			guestsCount: 1,
			primaryGuestId: guestId,
			guestSnapshot: {
				firstName: 'Демо',
				lastName: `Гость-${docSuffix}`,
				citizenship: 'RU',
				documentType: 'passport',
				documentNumber: `4510${docSuffix.padStart(6, '0')}`,
			},
			channelCode: 'walkIn',
		},
	})
	if (!bookingRes.ok()) {
		throw new Error(`booking.create HTTP ${bookingRes.status()}: ${await bookingRes.text()}`)
	}
	const bookingId = ((await bookingRes.json()) as { data: { id: string } }).data.id
	return { bookingId, orgSlug, checkInIso }
}

function futureIso(days: number): string {
	const d = new Date()
	d.setUTCDate(d.getUTCDate() + days)
	return d.toISOString().slice(0, 10)
}
