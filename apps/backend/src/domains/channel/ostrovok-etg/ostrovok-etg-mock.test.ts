/**
 * Ostrovok ETG Mock — strict tests ETG1-ETG30 (M10 / A7.4 + Round 8).
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
 *
 * **Round 8 additions** (per `feedback_round_8_strict_sweep_canon_2026_05_25.md`):
 *   - ETG20 prebook respects input checkIn/checkOut/guestCount (P0-3 — no fake fixture)
 *   - ETG21 ChannelReservation carries strictly-increasing sequenceNumber
 *   - ETG22 pushAri rejects out-of-order sequence per-resource
 *   - ETG23 pushAri returns AriPushResult { accepted, rejected, errors }
 *   - ETG24 cancelReservation idempotency-key dedup (no-op retry safety)
 *   - ETG25 verifyBooking cross-tenant guard (throws on mismatch)
 *   - ETG26 pushAri across multiple resources accepted independently
 *   - ETG27 pushAriFull resets monotonicity baseline
 *   - ETG28 cancelReservation cross-tenant guard returns not_found
 *   - ETG29 prebook stores priceMicros scaled by nights × guests
 *   - ETG30 prebook sequenceNumber bumped per state transition
 */

import { describe, expect, it } from 'bun:test'
import type { AriDelta } from '../../../lib/channel-manager/adapter.ts'
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
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 2,
		})
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
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
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
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		etg.__test_simulateDoubleBookingCollision(prebook.partnerOrderId)
		const book = await etg.book({
			partnerOrderId: prebook.partnerOrderId,
			bookHash: prebook.bookHash,
		})
		expect(book.partnerOrderIdRotated).not.toBe(undefined)
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
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
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
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
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
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
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
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
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
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
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
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		await etg.book({ partnerOrderId: prebook.partnerOrderId, bookHash: prebook.bookHash })
		await etg.forceTerminal({ partnerOrderId: prebook.partnerOrderId, outcome: 'confirmed' })
		const r = await etg.cancelReservation({
			tenantId: 'org_OTHER',
			externalId: prebook.partnerOrderId,
			idempotencyKey: 'idem-cross-tenant-1',
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
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
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

describe('ETG Mock — Round 8 P0/P1 fixes (ETG20-ETG30)', () => {
	it('[ETG20] prebook with checkIn=2027-08-01 MUST NOT return 2027-06-15 (P0-3 — no fake fixture)', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const search = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-08-01',
			checkOut: '2027-08-05',
			guestCount: 3,
		})
		const result = search[0]
		if (!result) throw new Error('search result missing')
		const prebook = await etg.prebook({
			hid: result.hid,
			searchId: result.searchId,
			checkIn: '2027-08-01',
			checkOut: '2027-08-05',
			guestCount: 3,
		})
		const inspected = etg.__test_inspect()
		const booking = inspected.bookings.find((b) => b.partnerOrderId === prebook.partnerOrderId)
		expect(booking?.checkIn).toBe('2027-08-01')
		expect(booking?.checkOut).toBe('2027-08-05')
		expect(booking?.guestCount).toBe(3)
		// HARD assertion: hardcoded fake fixture must be eliminated
		expect(booking?.checkIn).not.toBe('2027-06-15')
		expect(booking?.checkOut).not.toBe('2027-06-17')
		expect(booking?.guestCount).not.toBe(1)
	})

	it('[ETG21] ChannelReservation surfaced via readReservations carries strictly-increasing sequenceNumber', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		// Create 2 terminal bookings, second is more recent → higher sequence.
		const s1 = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const r1 = s1[0]
		if (!r1) throw new Error('search 1 missing')
		const p1 = await etg.prebook({
			hid: r1.hid,
			searchId: r1.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		await etg.book({ partnerOrderId: p1.partnerOrderId, bookHash: p1.bookHash })
		await etg.forceTerminal({ partnerOrderId: p1.partnerOrderId, outcome: 'confirmed' })

		const s2 = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-07-15',
			checkOut: '2027-07-17',
			guestCount: 2,
		})
		const r2 = s2[0]
		if (!r2) throw new Error('search 2 missing')
		const p2 = await etg.prebook({
			hid: r2.hid,
			searchId: r2.searchId,
			checkIn: '2027-07-15',
			checkOut: '2027-07-17',
			guestCount: 2,
		})
		await etg.book({ partnerOrderId: p2.partnerOrderId, bookHash: p2.bookHash })
		await etg.forceTerminal({ partnerOrderId: p2.partnerOrderId, outcome: 'confirmed' })

		const out = await etg.readReservations({ tenantId: TENANT, propertyId: PROPERTY })
		expect(out.reservations.length).toBe(2)
		const [first, second] = out.reservations
		if (!first || !second) throw new Error('missing rows')
		expect(typeof first.sequenceNumber).toBe('bigint')
		expect(typeof second.sequenceNumber).toBe('bigint')
		// Strict monotonic across bookings (forceTerminal bumps sequenceNumber).
		expect(second.sequenceNumber > first.sequenceNumber).toBe(true)
	})

	it('[ETG22] pushAri rejects out-of-order sequence per-resource', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const d1: AriDelta = {
			tenantId: TENANT,
			propertyId: PROPERTY,
			date: '2027-06-15',
			roomTypeId: 'rt-1',
			ratePlanId: 'rp-1',
			availability: 5,
			rateMicros: 7_000_000n,
			currency: 'RUB',
			sequenceNumber: 1000n,
		}
		const d2: AriDelta = {
			...d1,
			sequenceNumber: 500n, // out-of-order: lower than d1
		}
		const r1 = await etg.pushAri([d1])
		expect(r1.accepted).toBe(1)
		expect(r1.rejected).toBe(0)
		expect(r1.errors).toHaveLength(0)
		const r2 = await etg.pushAri([d2])
		expect(r2.accepted).toBe(0)
		expect(r2.rejected).toBe(1)
		expect(r2.errors).toHaveLength(1)
		expect(r2.errors[0]?.category).toBe('invalid_payload')
		expect(r2.errors[0]?.itemIndex).toBe(0)
	})

	it('[ETG23] pushAri returns AriPushResult with errors[] populated for mixed batch', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const dOk: AriDelta = {
			tenantId: TENANT,
			propertyId: PROPERTY,
			date: '2027-06-15',
			roomTypeId: 'rt-1',
			ratePlanId: 'rp-1',
			availability: 5,
			rateMicros: 7_000_000n,
			currency: 'RUB',
			sequenceNumber: 1000n,
		}
		// Seed highest=1000 → next call with 500 will be rejected.
		await etg.pushAri([dOk])
		const dBad: AriDelta = { ...dOk, sequenceNumber: 500n }
		const dOk2: AriDelta = { ...dOk, sequenceNumber: 1500n }
		const r = await etg.pushAri([dBad, dOk2])
		expect(r.accepted).toBe(1)
		expect(r.rejected).toBe(1)
		expect(r.errors).toHaveLength(1)
		expect(r.errors[0]?.itemIndex).toBe(0)
		expect(r.errors[0]?.category).toBe('invalid_payload')
	})

	it('[ETG24] cancelReservation idempotency-key dedup — repeat call returns already_cancelled', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const s = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const r = s[0]
		if (!r) throw new Error('search missing')
		const p = await etg.prebook({
			hid: r.hid,
			searchId: r.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		await etg.book({ partnerOrderId: p.partnerOrderId, bookHash: p.bookHash })
		await etg.forceTerminal({ partnerOrderId: p.partnerOrderId, outcome: 'confirmed' })
		const idem = 'idem-cancel-1'
		const first = await etg.cancelReservation({
			tenantId: TENANT,
			externalId: p.partnerOrderId,
			idempotencyKey: idem,
		})
		expect(first.status).toBe('cancelled')
		const second = await etg.cancelReservation({
			tenantId: TENANT,
			externalId: p.partnerOrderId,
			idempotencyKey: idem,
		})
		expect(second.status).toBe('already_cancelled')
	})

	it('[ETG25] verifyBooking cross-tenant guard — foreign tenantId throws cross_tenant_refused', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		await expect(
			etg.verifyBooking({
				tenantId: 'org_OTHER',
				propertyId: PROPERTY,
				roomTypeId: 'rt-1',
				ratePlanId: 'rp-1',
				checkIn: '2027-06-15',
				checkOut: '2027-06-17',
				guestCount: 1,
				guest: {
					firstName: 'A',
					lastName: 'B',
					email: 'test@example.test',
					phone: '+79991112233',
				},
			}),
		).rejects.toThrow(/cross_tenant_refused/)
	})

	it('[ETG26] pushAri across multiple resources accepts independently (per-resource monotonicity)', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const base: Omit<AriDelta, 'date' | 'sequenceNumber'> = {
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'rt-1',
			ratePlanId: 'rp-1',
			availability: 5,
			rateMicros: 7_000_000n,
			currency: 'RUB',
		}
		const d1: AriDelta = { ...base, date: '2027-06-15', sequenceNumber: 100n }
		const d2: AriDelta = { ...base, date: '2027-06-16', sequenceNumber: 50n }
		const r = await etg.pushAri([d1, d2])
		expect(r.accepted).toBe(2)
		expect(r.rejected).toBe(0)
		expect(r.errors).toHaveLength(0)
	})

	it('[ETG27] pushAriFull resets monotonicity baseline — lower sequence accepted after reset', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const dHigh: AriDelta = {
			tenantId: TENANT,
			propertyId: PROPERTY,
			date: '2027-06-15',
			roomTypeId: 'rt-1',
			ratePlanId: 'rp-1',
			availability: 5,
			rateMicros: 7_000_000n,
			currency: 'RUB',
			sequenceNumber: 5000n,
		}
		await etg.pushAri([dHigh])
		// pushAriFull is full snapshot → resets per-resource highest baselines.
		const dLow: AriDelta = { ...dHigh, sequenceNumber: 1n }
		const r = await etg.pushAriFull([dLow])
		expect(r.accepted).toBe(1)
		expect(r.rejected).toBe(0)
	})

	it('[ETG28] cancelReservation cross-tenant guard returns not_found (even with valid externalId)', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const s = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const r = s[0]
		if (!r) throw new Error('search missing')
		const p = await etg.prebook({
			hid: r.hid,
			searchId: r.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const out = await etg.cancelReservation({
			tenantId: 'org_OTHER',
			externalId: p.partnerOrderId,
			idempotencyKey: 'idem-foreign',
		})
		expect(out.status).toBe('not_found')
		// Verify booking NOT marked cancelled (cross-tenant guard is hard).
		const inspected = etg.__test_inspect()
		const booking = inspected.bookings.find((b) => b.partnerOrderId === p.partnerOrderId)
		expect(booking?.terminalState).toBeNull()
	})

	it('[ETG29] prebook priceMicros scales by nights × guestCount (no fake fixture)', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const s = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-08-01',
			checkOut: '2027-08-05', // 4 nights
			guestCount: 3,
		})
		const r = s[0]
		if (!r) throw new Error('search missing')
		const p = await etg.prebook({
			hid: r.hid,
			searchId: r.searchId,
			checkIn: '2027-08-01',
			checkOut: '2027-08-05',
			guestCount: 3,
		})
		const inspected = etg.__test_inspect()
		const booking = inspected.bookings.find((b) => b.partnerOrderId === p.partnerOrderId)
		// 7_000_000n micros × 4 nights × 3 guests = 84_000_000n
		expect(booking?.priceMicros).toBe(84_000_000n)
	})

	it('[ETG30] prebook → book transitions bump sequenceNumber (state machine progression visible)', async () => {
		const etg = createOstrovokEtgMock({ tenantId: TENANT, propertyId: PROPERTY })
		const s = await etg.searchHotels({
			hid: SANDBOX_HID,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const r = s[0]
		if (!r) throw new Error('search missing')
		const p = await etg.prebook({
			hid: r.hid,
			searchId: r.searchId,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
		})
		const before = etg.__test_inspect().bookings.find((b) => b.partnerOrderId === p.partnerOrderId)
		const seqAtPrebook = before?.sequenceNumber
		if (seqAtPrebook === undefined) throw new Error('seq missing')
		await etg.book({ partnerOrderId: p.partnerOrderId, bookHash: p.bookHash })
		const after = etg.__test_inspect().bookings.find((b) => b.partnerOrderId === p.partnerOrderId)
		const seqAtBook = after?.sequenceNumber
		if (seqAtBook === undefined) throw new Error('seq missing after book')
		expect(seqAtBook > seqAtPrebook).toBe(true)
	})
})
