/**
 * Ostrovok ETG Mock — strict tests ETG1-ETG18 (M10 / A7.4).
 *
 * Pure-function tests. Verifies D7-D10 canon:
 *   - D7: HTTP Basic Auth (id:uuid)
 *   - D8: 5-stage SM (search → prebook → book → start → check)
 *   - D9: partner_order_id UUID v4 rotation on double_booking_form collision +
 *         retry cap (3 attempts)
 *   - D10: webhook terminal-only + polling source-of-truth + stuck-in-book
 *          timeout (90s non-3DS / 600s 3DS)
 *
 * Plus 4-brand fan-out + 3 commercial models + RU residency (rg_ext) +
 * sandbox demo-hotel guard hid=8473727 + cross-tenant.
 */

import { describe, expect, it } from 'bun:test'
import {
	buildEtgBasicAuthHeader,
	createOstrovokEtgMock,
	type EtgBrand,
} from './ostrovok-etg-mock.ts'

const TENANT = 'org_etg_test_a'
const PROPERTY = 'prop_etg_main'
const SANDBOX_HID = 8473727

describe('ETG Mock — D7 HTTP Basic Auth (ETG1-ETG2)', () => {
	it('[ETG1] buildEtgBasicAuthHeader produces canonical Basic Auth header', () => {
		const h = buildEtgBasicAuthHeader({ id: 'client-id-123', uuid: 'client-uuid-abc' })
		expect(h.startsWith('Basic ')).toBe(true)
		const decoded = Buffer.from(h.slice('Basic '.length), 'base64').toString('utf-8')
		expect(decoded).toBe('client-id-123:client-uuid-abc')
	})

	it('[ETG2] basicAuthHeader available via __test_inspect', () => {
		const etg = createOstrovokEtgMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			etgClientId: 'id-1',
			etgClientUuid: 'uuid-1',
		})
		const i = etg.__test_inspect()
		expect(i.basicAuthHeader).toBe(
			`Basic ${Buffer.from('id-1:uuid-1', 'utf-8').toString('base64')}`,
		)
	})
})

describe('ETG Mock — D8 5-stage state machine (ETG3-ETG7)', () => {
	it('[ETG3] full 5-stage flow: search → prebook → book → start → check', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 2,
		})
		expect(search).toHaveLength(1)
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({ hid: result.hid, searchId: result.searchId })
		expect(prebook.partnerOrderId.length).toBeGreaterThan(0)
		const book = await etg.book({
			partnerOrderId: prebook.partnerOrderId,
			bookHash: prebook.bookHash,
		})
		expect(book.stage).toBe('book')
		const start = await etg.start({ partnerOrderId: prebook.partnerOrderId })
		expect(start.stage).toBe('start')
		const check = await etg.checkBookingStatus({ partnerOrderId: prebook.partnerOrderId })
		expect(check.stage).toBe('check')
		expect(check.terminal).toBeNull() // not forced — pending terminal callback
	})

	it('[ETG4] sandbox demo-hotel guard: hid != 8473727 → empty search results', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY, mode: 'sandbox' })
		const r = await etg.searchHotels({
			hid: 1234,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		expect(r).toHaveLength(0)
	})

	it('[ETG5] live mode allows arbitrary hid', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY, mode: 'live' })
		const r = await etg.searchHotels({
			hid: 9999,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		expect(r).toHaveLength(1)
	})

	it('[ETG6] forceTerminal "confirmed" transitions to terminal state', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({ hid: result.hid, searchId: result.searchId })
		await etg.book({ partnerOrderId: prebook.partnerOrderId, bookHash: prebook.bookHash })
		await etg.forceTerminal({ partnerOrderId: prebook.partnerOrderId, outcome: 'confirmed' })
		const check = await etg.checkBookingStatus({ partnerOrderId: prebook.partnerOrderId })
		expect(check.terminal).toBe('confirmed')
	})

	it('[ETG7] checkBookingStatus on missing partnerOrderId → throws', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		await expect(etg.checkBookingStatus({ partnerOrderId: 'does-not-exist' })).rejects.toThrow(
			/not found/,
		)
	})
})

describe('ETG Mock — D9 partner_order_id rotation (ETG8-ETG10)', () => {
	it('[ETG8] double_booking_form collision → partner_order_id rotated; rotation count incremented', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({ hid: result.hid, searchId: result.searchId })
		etg.__test_simulateDoubleBookingCollision(prebook.partnerOrderId)
		const book = await etg.book({
			partnerOrderId: prebook.partnerOrderId,
			bookHash: prebook.bookHash,
		})
		expect(book.partnerOrderIdRotated).toBeDefined()
		expect(book.partnerOrderIdRotated).not.toBe(prebook.partnerOrderId)
	})

	it('[ETG9] retry cap reached (3 rotations) → throws', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({ hid: result.hid, searchId: result.searchId })
		// Trigger 3 collisions; on 4th — cap exceeded.
		etg.__test_simulateDoubleBookingCollision(prebook.partnerOrderId)
		const r1 = await etg.book({
			partnerOrderId: prebook.partnerOrderId,
			bookHash: prebook.bookHash,
		})
		const r1Id = r1.partnerOrderIdRotated
		if (!r1Id) throw new Error('expected rotation 1')
		etg.__test_simulateDoubleBookingCollision(r1Id)
		const r2 = await etg.book({ partnerOrderId: r1Id, bookHash: prebook.bookHash })
		const r2Id = r2.partnerOrderIdRotated
		if (!r2Id) throw new Error('expected rotation 2')
		etg.__test_simulateDoubleBookingCollision(r2Id)
		const r3 = await etg.book({ partnerOrderId: r2Id, bookHash: prebook.bookHash })
		const r3Id = r3.partnerOrderIdRotated
		if (!r3Id) throw new Error('expected rotation 3')
		etg.__test_simulateDoubleBookingCollision(r3Id)
		await expect(etg.book({ partnerOrderId: r3Id, bookHash: prebook.bookHash })).rejects.toThrow(
			/rotation cap exceeded/,
		)
	})

	it('[ETG10] partner_order_id global uniqueness — rotated IDs are different UUIDs', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({ hid: result.hid, searchId: result.searchId })
		etg.__test_simulateDoubleBookingCollision(prebook.partnerOrderId)
		const r = await etg.book({
			partnerOrderId: prebook.partnerOrderId,
			bookHash: prebook.bookHash,
		})
		expect(r.partnerOrderIdRotated).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		)
	})
})

describe('ETG Mock — D10 stuck-in-book timeout + webhook semantics (ETG11-ETG13)', () => {
	it('[ETG11] non-3DS booking stuck >90s → terminal=failed via stuckTimeoutExceeded flag', async () => {
		let nowMs = 1_700_000_000_000
		const etg = createOstrovokEtgMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			nowMs: () => nowMs,
		})
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({ hid: result.hid, searchId: result.searchId })
		await etg.book({
			partnerOrderId: prebook.partnerOrderId,
			bookHash: prebook.bookHash,
			uses3ds: false,
		})
		nowMs += 91_000 // 91s — past 90s timeout for non-3DS
		const check = await etg.checkBookingStatus({ partnerOrderId: prebook.partnerOrderId })
		expect(check.terminal).toBe('failed')
		expect(check.stuckTimeoutExceeded).toBe(true)
	})

	it('[ETG12] 3DS booking timeout = 600s (10 min); 91s not enough', async () => {
		let nowMs = 1_700_000_000_000
		const etg = createOstrovokEtgMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			nowMs: () => nowMs,
		})
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({ hid: result.hid, searchId: result.searchId })
		await etg.book({
			partnerOrderId: prebook.partnerOrderId,
			bookHash: prebook.bookHash,
			uses3ds: true,
		})
		nowMs += 91_000 // 91s — well within 600s 3DS budget
		const check = await etg.checkBookingStatus({ partnerOrderId: prebook.partnerOrderId })
		expect(check.terminal).toBeNull() // NOT timed out yet
	})

	it('[ETG13] webhook with non-terminal status (e.g. "processing") → 400 rejected', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const r = await etg.receiveBookingWebhook({
			rawBody: new TextEncoder().encode(
				JSON.stringify({ partner_order_id: 'po-test', status: 'processing' }),
			),
			headers: {},
			clientIp: undefined,
		})
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.httpStatus).toBe(400)
			expect(r.reason).toBe('non_terminal_status_rejected')
		}
	})
})

describe('ETG Mock — 4-brand fan-out + commercial models (ETG14-ETG16)', () => {
	it('[ETG14] listBrands returns all 4 canonical brands', () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const brands = etg.listBrands()
		expect(brands).toEqual(['RateHawk', 'ZenHotels', 'B2B.Ostrovok', 'Ostrovok'])
	})

	it('[ETG15] extractBrandFromSource demuxes all 4 source values', () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		expect(etg.extractBrandFromSource('ratehawk')).toBe('RateHawk')
		expect(etg.extractBrandFromSource('zenhotels')).toBe('ZenHotels')
		expect(etg.extractBrandFromSource('b2b.ostrovok')).toBe('B2B.Ostrovok')
		expect(etg.extractBrandFromSource('ostrovok')).toBe('Ostrovok')
		expect(etg.extractBrandFromSource('unknown')).toBeNull()
	})

	it('[ETG16] prebook stores commercial model + brand source on booking state', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			brand: 'ZenHotels' as EtgBrand,
			commercialModel: 'affiliate_gross',
		})
		const inspected = etg.__test_inspect()
		const booking = inspected.bookings.find((b) => b.partnerOrderId === prebook.partnerOrderId)
		expect(booking?.brand).toBe('ZenHotels')
		expect(booking?.commercialModel).toBe('affiliate_gross')
		expect(booking?.source).toBe('zenhotels')
	})
})

describe('ETG Mock — RU residency + cross-tenant + emit (ETG17-ETG19)', () => {
	it('[ETG17] rg_ext photo refs returned (NOT deprecated images field)', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		expect(result.rgExt).toHaveLength(2)
		expect(result.rgExt[0]?.category).toBe('main')
		expect(result.rgExt[0]?.url.startsWith('https://')).toBe(true)
	})

	it('[ETG18] cross-tenant cancelReservation от wrong tenant → not_found', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({ hid: result.hid, searchId: result.searchId })
		await etg.book({ partnerOrderId: prebook.partnerOrderId, bookHash: prebook.bookHash })
		await etg.forceTerminal({ partnerOrderId: prebook.partnerOrderId, outcome: 'confirmed' })
		const r = await etg.cancelReservation({
			tenantId: 'org_OTHER',
			externalId: prebook.partnerOrderId,
		})
		expect(r.status).toBe('not_found')
	})

	it('[ETG19] emitReservationEvent — canonical CE с tenant URN + ETG channelCode', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({ hid: result.hid, searchId: result.searchId })
		await etg.book({ partnerOrderId: prebook.partnerOrderId, bookHash: prebook.bookHash })
		await etg.forceTerminal({ partnerOrderId: prebook.partnerOrderId, outcome: 'confirmed' })
		const inspected = etg.__test_inspect()
		const booking = inspected.bookings.find((b) => b.partnerOrderId === prebook.partnerOrderId)
		if (!booking) throw new Error('booking missing')
		const event = etg.emitReservationEvent(booking)
		expect(event.specversion).toBe('1.0')
		expect(event.source).toBe(`urn:sochi:channel:ETG:tenant:${TENANT}`)
		expect(event.type).toBe('app.sochi.channel.booking.created.v1')
	})
})
