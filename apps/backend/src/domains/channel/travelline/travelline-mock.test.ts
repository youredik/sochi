/**
 * TravelLine Mock — strict tests TL1-TL18 + Round 8 sequence/idempotency (M10 / A7.2).
 *
 * Pure-function tests (no DB). Verifies D1-D5 canon:
 *   - D1: source-of-truth ARI (push no-ops, search returns fixture)
 *   - D2: polling reception + continueToken cursor + lastModification−2d overlap
 *   - D3: OAuth 15-min JWT auto-refresh + per-IP rate-limit (3rps/15rpm/300rph)
 *   - D4: verify→create two-step + 24h CreateBookingToken + Checksum mismatch 409
 *   - D5: tlRoomTypeId/tlRatePlanId fixture pass-through
 *
 * Plus cross-tenant isolation + cancellation semantics + cancellation policy enum.
 *
 * Round 8 (P1-1 / P0 / P1-5): per-resource sequenceNumber monotonicity, AriPushResult
 * with errors array, idempotency-keyed cancelReservation.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { sequenceFromTimestamp } from '../../../lib/channel-manager/sequence.ts'
import {
	computeChecksum,
	createTravellineMock,
	TravellineRateLimitError,
} from './travelline-mock.ts'

const TENANT = 'org_tl_test_a'
const PROPERTY = 'prop_tl_main'
const HOTEL_ID = `tl-hotel-${TENANT}`

function buildAvailabilityFixture() {
	return [
		{
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			date: '2027-06-15',
			availability: 5,
			rateMicros: 5_000_000n,
		},
		{
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			date: '2027-06-16',
			availability: 5,
			rateMicros: 5_000_000n,
		},
		{
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			date: '2027-06-17',
			availability: 4, // partial booking
			rateMicros: 5_000_000n,
		},
	]
}

describe('TravelLine Mock — D1 source-of-truth ARI (TL1-TL3)', () => {
	it('[TL1] pushAri returns success but is no-op (TL ignores; PMS reads-only)', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			seedAvailability: buildAvailabilityFixture(),
		})
		const result = await tl.pushAri([
			{
				tenantId: TENANT,
				propertyId: PROPERTY,
				date: '2027-06-15',
				roomTypeId: 'tl_rt_deluxe',
				ratePlanId: 'tl_rp_bar_flex',
				availability: 5,
				rateMicros: 5_000_000n,
				currency: 'RUB',
				sequenceNumber: sequenceFromTimestamp(1_700_000_000_000, 1),
			},
		])
		// TL polling-based — pushAri validates sequence + tracks high-water mark,
		// then ACK'd without forwarding к real upstream. Caller's sequence accepted.
		expect(result.accepted).toBe(1)
		expect(result.rejected).toBe(0)
		expect(result.errors).toEqual([])
	})

	it('[TL2] searchAvailability returns fixture rows for date range', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			seedAvailability: buildAvailabilityFixture(),
		})
		const rows = await tl.searchAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 2,
		})
		expect(rows).toHaveLength(2) // 06-15 + 06-16, не 06-17 (checkOut exclusive)
		expect(rows[0]?.roomTypeId).toBe('tl_rt_deluxe')
		expect(rows[0]?.availability).toBe(5)
		expect(rows[0]?.rateMicros).toBe(5_000_000n)
	})

	it('[TL3] searchAvailability outside fixture range returns empty', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			seedAvailability: buildAvailabilityFixture(),
		})
		const rows = await tl.searchAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2030-01-01',
			checkOut: '2030-01-05',
			guestCount: 1,
		})
		expect(rows).toHaveLength(0)
	})
})

describe('TravelLine Mock — D2 polling reception (TL4-TL6)', () => {
	it('[TL4] readReservations: empty store returns empty page hasMore=false', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const r = await tl.readReservations({ tenantId: TENANT, propertyId: PROPERTY })
		expect(r.reservations).toHaveLength(0)
		expect(r.hasMore).toBe(false)
		expect(r.nextContinueToken).toBeUndefined()
	})

	it('[TL5] readReservations: continueToken cursor resumes after stored modification', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		tl.__test_seedReservation({
			tlReservationId: 'tl-r-1',
			tenantId: TENANT,
			propertyId: PROPERTY,
			hotelId: HOTEL_ID,
			tlRoomTypeId: 'tl_rt_deluxe',
			tlRatePlanId: 'tl_rp_bar_flex',
			arrivalDate: '2027-07-01',
			departureDate: '2027-07-03',
			guestCount: 2,
			totalPriceMicros: 10_000_000n,
			status: 'Confirmed',
			lastModificationUtc: '2026-05-04T10:00:00.000Z',
			sequenceNumber: sequenceFromTimestamp(Date.parse('2026-05-04T10:00:00.000Z'), 1),
			guest: { firstName: 'Иван', lastName: 'Петров', email: 'ip@test.ru' },
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime',
				hoursBeforeRef: 24,
				penaltyKind: 'first_night',
				penaltyValue: 1,
			},
		})
		tl.__test_seedReservation({
			tlReservationId: 'tl-r-2',
			tenantId: TENANT,
			propertyId: PROPERTY,
			hotelId: HOTEL_ID,
			tlRoomTypeId: 'tl_rt_deluxe',
			tlRatePlanId: 'tl_rp_bar_flex',
			arrivalDate: '2027-08-01',
			departureDate: '2027-08-02',
			guestCount: 1,
			totalPriceMicros: 5_000_000n,
			status: 'Confirmed',
			lastModificationUtc: '2026-05-04T11:00:00.000Z',
			sequenceNumber: sequenceFromTimestamp(Date.parse('2026-05-04T11:00:00.000Z'), 1),
			guest: { firstName: 'Маша', lastName: 'Сидорова' },
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime',
				hoursBeforeRef: 24,
				penaltyKind: 'first_night',
				penaltyValue: 1,
			},
		})
		// First call — no cursor → returns both ordered.
		const r1 = await tl.readReservations({ tenantId: TENANT, propertyId: PROPERTY })
		expect(r1.reservations.map((r) => r.externalId)).toEqual(['tl-r-1', 'tl-r-2'])
		// Use synthetic continueToken to skip past first.
		const r2 = await tl.readReservations({
			tenantId: TENANT,
			propertyId: PROPERTY,
			continueToken: 'cursor|2026-05-04T10:00:00.000Z|tl-r-1',
		})
		expect(r2.reservations.map((r) => r.externalId)).toEqual(['tl-r-2'])
	})

	it('[TL6] readReservations: lastModification−2d overlap canonical', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		tl.__test_seedReservation({
			tlReservationId: 'tl-r-old',
			tenantId: TENANT,
			propertyId: PROPERTY,
			hotelId: HOTEL_ID,
			tlRoomTypeId: 'tl_rt_deluxe',
			tlRatePlanId: 'tl_rp_bar_flex',
			arrivalDate: '2027-09-01',
			departureDate: '2027-09-02',
			guestCount: 1,
			totalPriceMicros: 5_000_000n,
			status: 'Confirmed',
			lastModificationUtc: '2026-04-30T00:00:00.000Z', // ~5 days before lastMod
			sequenceNumber: sequenceFromTimestamp(Date.parse('2026-04-30T00:00:00.000Z'), 1),
			guest: { firstName: 'A', lastName: 'B' },
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime',
				hoursBeforeRef: 24,
				penaltyKind: 'first_night',
				penaltyValue: 1,
			},
		})
		tl.__test_seedReservation({
			tlReservationId: 'tl-r-recent',
			tenantId: TENANT,
			propertyId: PROPERTY,
			hotelId: HOTEL_ID,
			tlRoomTypeId: 'tl_rt_deluxe',
			tlRatePlanId: 'tl_rp_bar_flex',
			arrivalDate: '2027-09-05',
			departureDate: '2027-09-06',
			guestCount: 1,
			totalPriceMicros: 5_000_000n,
			status: 'Confirmed',
			lastModificationUtc: '2026-05-04T10:00:00.000Z',
			sequenceNumber: sequenceFromTimestamp(Date.parse('2026-05-04T10:00:00.000Z'), 1),
			guest: { firstName: 'C', lastName: 'D' },
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime',
				hoursBeforeRef: 24,
				penaltyKind: 'first_night',
				penaltyValue: 1,
			},
		})
		// Replay from lastMod=2026-05-05 → window starts at 2026-05-03 → recent INCLUDED, old EXCLUDED.
		const r = await tl.readReservations({
			tenantId: TENANT,
			propertyId: PROPERTY,
			lastModificationUtc: '2026-05-05T00:00:00.000Z',
		})
		const ids = r.reservations.map((r) => r.externalId)
		expect(ids).toContain('tl-r-recent')
		expect(ids).not.toContain('tl-r-old')
	})
})

describe('TravelLine Mock — D3 OAuth + rate-limit (TL7-TL10)', () => {
	let nowMs = 1_700_000_000_000
	const fakeNow = () => nowMs

	beforeEach(() => {
		nowMs = 1_700_000_000_000
	})

	it('[TL7] JWT issued on first call, reused before refresh window', async () => {
		const tl = createTravellineMock({ tenantId: TENANT, propertyId: PROPERTY, nowMs: fakeNow })
		await tl.searchAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2027-06-15',
			checkOut: '2027-06-16',
			guestCount: 1,
		})
		const jwt1 = tl.__test_inspect().jwt?.accessToken
		nowMs += 60_000 // 1 minute later, well within 15-min TTL
		await tl.searchAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2027-06-15',
			checkOut: '2027-06-16',
			guestCount: 1,
		})
		const jwt2 = tl.__test_inspect().jwt?.accessToken
		expect(jwt1).not.toBe(undefined)
		expect(jwt1).toBe(jwt2)
	})

	it('[TL8] JWT auto-refresh когда within 60s of expiry (15-min TTL canonical)', async () => {
		const tl = createTravellineMock({ tenantId: TENANT, propertyId: PROPERTY, nowMs: fakeNow })
		await tl.searchAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2027-06-15',
			checkOut: '2027-06-16',
			guestCount: 1,
		})
		const jwt1 = tl.__test_inspect().jwt?.accessToken
		nowMs += 14 * 60_000 + 30_000 // 14m30s — within 60s of expiry
		await tl.searchAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2027-06-15',
			checkOut: '2027-06-16',
			guestCount: 1,
		})
		const jwt2 = tl.__test_inspect().jwt?.accessToken
		expect(jwt2).not.toBe(jwt1)
		expect(jwt2).not.toBe(undefined)
	})

	it('[TL9] rate-limit per-IP: 4th request in same second → 429 with Retry-After', async () => {
		const tl = createTravellineMock({ tenantId: TENANT, propertyId: PROPERTY, nowMs: fakeNow })
		await tl.pushAri([])
		await tl.pushAri([])
		await tl.pushAri([])
		await expect(tl.pushAri([])).rejects.toBeInstanceOf(TravellineRateLimitError)
	})

	it('[TL10] simulated rate-limit exhaustion always raises until reset', async () => {
		const tl = createTravellineMock({ tenantId: TENANT, propertyId: PROPERTY, nowMs: fakeNow })
		tl.__test_simulateRateLimitExhaustion()
		await expect(tl.pushAri([])).rejects.toBeInstanceOf(TravellineRateLimitError)
		try {
			await tl.pushAri([])
		} catch (err) {
			expect(err).toBeInstanceOf(TravellineRateLimitError)
			expect((err as TravellineRateLimitError).retryAfterSeconds).toBeGreaterThanOrEqual(1)
			expect((err as TravellineRateLimitError).httpStatus).toBe(429)
		}
	})
})

describe('TravelLine Mock — D4 verify→create two-step (TL11-TL15)', () => {
	it('[TL11] verifyBooking issues token + checksum + 24h expiresAt', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const r = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 2,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		expect(r.createBookingToken.length).toBeGreaterThan(0)
		expect(r.checksum.length).toBe(64) // sha256 hex
		expect(r.totalAmountMicros).toBe(20_000_000n) // 2 nights × 2 guests × 5M
		const expiresMs = new Date(r.expiresAtUtc).getTime()
		expect(expiresMs - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000)
		expect(expiresMs - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000)
	})

	it('[TL12] createBooking happy path with matching checksum → externalId returned + reservation stored', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const verify = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 2,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		const create = await tl.createBooking({
			verifyResult: verify,
			idempotencyKey: 'idemp-1',
		})
		expect(create.externalId.startsWith('tl-res-')).toBe(true)
		const inspected = tl.__test_inspect()
		expect(inspected.reservations.find((r) => r.tlReservationId === create.externalId)).not.toBe(
			undefined,
		)
	})

	it('[TL13] createBooking with TAMPERED checksum → 409 CHECKSUM_MISMATCH', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const verify = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 2,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		const tampered = { ...verify, checksum: 'a'.repeat(64) }
		await expect(
			tl.createBooking({ verifyResult: tampered, idempotencyKey: 'idemp-1' }),
		).rejects.toMatchObject({
			httpStatus: 409,
			errorCode: 'CHECKSUM_MISMATCH',
		})
	})

	it('[TL14] createBooking single-use: second create на same token → 410 TOKEN_USED', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const verify = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 2,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		await tl.createBooking({ verifyResult: verify, idempotencyKey: 'idemp-1' })
		await expect(
			tl.createBooking({ verifyResult: verify, idempotencyKey: 'idemp-2' }),
		).rejects.toMatchObject({
			httpStatus: 410,
			errorCode: 'TOKEN_USED',
		})
	})

	it('[TL15] createBooking after 24h+1ms → 410 TOKEN_EXPIRED', async () => {
		let nowMs = 1_700_000_000_000
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			nowMs: () => nowMs,
		})
		const verify = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 2,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		nowMs += 24 * 60 * 60 * 1000 + 1
		await expect(
			tl.createBooking({ verifyResult: verify, idempotencyKey: 'idemp-1' }),
		).rejects.toMatchObject({
			httpStatus: 410,
			errorCode: 'TOKEN_EXPIRED',
		})
	})
})

describe('TravelLine Mock — cancellation + cross-tenant + idempotency (TL16-TL18)', () => {
	it('[TL16] cancelReservation: idempotent (cancelled twice → already_cancelled)', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const verify = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		const create = await tl.createBooking({ verifyResult: verify, idempotencyKey: 'i-1' })
		// First cancellation — different idempotencyKey so cache не collides.
		const c1 = await tl.cancelReservation({
			tenantId: TENANT,
			externalId: create.externalId,
			idempotencyKey: 'cancel-key-1',
		})
		expect(c1.status).toBe('cancelled')
		// Second call с DIFFERENT key — sees Cancelled state, returns already_cancelled.
		const c2 = await tl.cancelReservation({
			tenantId: TENANT,
			externalId: create.externalId,
			idempotencyKey: 'cancel-key-2',
		})
		expect(c2.status).toBe('already_cancelled')
	})

	it('[TL17] cross-tenant: cancelReservation от wrong tenant → not_found', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const verify = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		const create = await tl.createBooking({ verifyResult: verify, idempotencyKey: 'i-1' })
		const result = await tl.cancelReservation({
			tenantId: 'org_DIFFERENT',
			externalId: create.externalId,
			idempotencyKey: 'cross-tenant-cancel-key',
		})
		expect(result.status).toBe('not_found')
	})

	it('[TL18] computeChecksum determinism + tamper-detection on guest email order', () => {
		const args = {
			hotelId: 'tl-h',
			tlRoomTypeId: 'rt',
			tlRatePlanId: 'rp',
			arrivalDate: '2027-06-15',
			departureDate: '2027-06-16',
			totalPriceMicros: 5_000_000n,
			guestEmails: ['b@test.ru', 'a@test.ru'],
		}
		const c1 = computeChecksum(args)
		const c2 = computeChecksum({ ...args, guestEmails: ['a@test.ru', 'b@test.ru'] })
		expect(c1).toBe(c2) // emails sorted before hashing — order-independent
		const c3 = computeChecksum({ ...args, totalPriceMicros: 5_000_001n })
		expect(c3).not.toBe(c1)
	})
})

describe('TravelLine Mock — receiveBookingWebhook canonically rejected', () => {
	it('[TL19] receiveBookingWebhook returns 501 — TL is polling-not-webhook (D2)', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const r = await tl.receiveBookingWebhook({
			rawBody: new Uint8Array([1, 2, 3]),
			headers: {},
			clientIp: undefined,
		})
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.httpStatus).toBe(501)
			expect(r.reason).toContain('polling-not-webhook')
		}
	})
})

describe('TravelLine Mock — emitReservationEvent CloudEvent envelope', () => {
	it('[TL20] emitReservationEvent produces canonical CE with tenant URN source', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const verify = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		const create = await tl.createBooking({ verifyResult: verify, idempotencyKey: 'i-1' })
		const reservation = tl
			.__test_inspect()
			.reservations.find((r) => r.tlReservationId === create.externalId)
		if (!reservation) throw new Error('reservation not found in test fixture')
		const event = tl.emitReservationEvent(reservation)
		expect(event.specversion).toBe('1.0')
		expect(event.source).toBe(`urn:sochi:channel:TL:tenant:${TENANT}`)
		expect(event.type).toBe('app.sochi.channel.booking.created.v1')
		expect(event.id).toBe(reservation.tlReservationId)
		expect(event.subject).toBe(reservation.tlReservationId)
	})
})

// =============================================================================
// Round 8 — P1-1 sequence number monotonicity + AriPushResult.errors
// =============================================================================

describe('TravelLine Mock — Round 8 P1-1 sequenceNumber monotonicity (TL21-TL25)', () => {
	function delta(date: string, seq: bigint) {
		return {
			tenantId: TENANT,
			propertyId: PROPERTY,
			date,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			availability: 5,
			rateMicros: 5_000_000n,
			currency: 'RUB' as const,
			sequenceNumber: seq,
		}
	}

	it('[TL21] pushAri accepts strictly-increasing sequence per-resource', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const r1 = await tl.pushAri([delta('2027-06-15', 100n), delta('2027-06-15', 200n)])
		expect(r1.accepted).toBe(2)
		expect(r1.rejected).toBe(0)
		expect(r1.errors).toEqual([])
	})

	it('[TL22] pushAri rejects out-of-order sequence with invalid_payload', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		// First push sets high-water = 200n.
		const r1 = await tl.pushAri([delta('2027-06-15', 100n), delta('2027-06-15', 200n)])
		expect(r1.accepted).toBe(2)
		// Replay older sequence — MUST reject.
		const r2 = await tl.pushAri([delta('2027-06-15', 150n)])
		expect(r2.accepted).toBe(0)
		expect(r2.rejected).toBe(1)
		expect(r2.errors).toHaveLength(1)
		const first = r2.errors[0]
		expect(first?.category).toBe('invalid_payload')
		expect(first?.itemIndex).toBe(0)
		expect(first?.upstreamCode).toBe('TL_SEQUENCE_NOT_MONOTONIC')
	})

	it('[TL23] pushAri equal-to-high-water rejected (strict greater-than required)', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		await tl.pushAri([delta('2027-06-15', 100n)])
		const r = await tl.pushAri([delta('2027-06-15', 100n)])
		expect(r.accepted).toBe(0)
		expect(r.rejected).toBe(1)
		expect(r.errors[0]?.message).toBe('sequence_number_not_monotonic')
	})

	it('[TL24] pushAri per-resource isolation — same seq на different date OK', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		// Same sequenceNumber на different date — different resource → both accepted.
		const r = await tl.pushAri([delta('2027-06-15', 100n), delta('2027-06-16', 100n)])
		expect(r.accepted).toBe(2)
		expect(r.rejected).toBe(0)
	})

	it('[TL25] pushAriFull clears high-water then validates within snapshot', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		// Pre-seed high-water = 500 via pushAri.
		await tl.pushAri([delta('2027-06-15', 500n)])
		// pushAriFull RESETS, so old «too old» seq is now OK as first entry.
		const r1 = await tl.pushAriFull([delta('2027-06-15', 100n)])
		expect(r1.accepted).toBe(1)
		expect(r1.rejected).toBe(0)
		// Second snapshot pass — within-snapshot duplicate seq rejected.
		const r2 = await tl.pushAriFull([
			delta('2027-06-15', 100n),
			delta('2027-06-15', 100n), // not > 100n in same snapshot
		])
		expect(r2.accepted).toBe(1)
		expect(r2.rejected).toBe(1)
		expect(r2.errors[0]?.message).toBe('sequence_number_not_monotonic_within_snapshot')
	})
})

// =============================================================================
// Round 8 — Idempotency-keyed cancelReservation
// =============================================================================

describe('TravelLine Mock — Round 8 cancelReservation idempotency (TL26-TL28)', () => {
	async function freshlyCreated() {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const verify = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		const create = await tl.createBooking({ verifyResult: verify, idempotencyKey: 'i-1' })
		return { tl, externalId: create.externalId }
	}

	it('[TL26] cancelReservation с same idempotencyKey → cached outcome (no double-cancel side-effect)', async () => {
		const { tl, externalId } = await freshlyCreated()
		const key = 'cancel-idem-key-A'
		const c1 = await tl.cancelReservation({ tenantId: TENANT, externalId, idempotencyKey: key })
		expect(c1.status).toBe('cancelled')
		// Repeat с same key — cached, не processes side-effect (high-water sequence не bumped).
		const inspectBefore = tl.__test_inspect()
		const beforeSeq = inspectBefore.reservations.find(
			(r) => r.tlReservationId === externalId,
		)?.sequenceNumber
		const c2 = await tl.cancelReservation({ tenantId: TENANT, externalId, idempotencyKey: key })
		expect(c2.status).toBe('cancelled') // same cached outcome
		const inspectAfter = tl.__test_inspect()
		const afterSeq = inspectAfter.reservations.find(
			(r) => r.tlReservationId === externalId,
		)?.sequenceNumber
		expect(beforeSeq).toBe(afterSeq) // no re-cancellation
	})

	it('[TL27] cancelReservation idempotency index populated с both terminal cached outcomes', async () => {
		const { tl, externalId } = await freshlyCreated()
		await tl.cancelReservation({
			tenantId: TENANT,
			externalId,
			idempotencyKey: 'key-1',
		})
		await tl.cancelReservation({
			tenantId: TENANT,
			externalId: 'nonexistent-id',
			idempotencyKey: 'key-2-not-found',
		})
		const idx = tl.__test_inspect().cancelIdempotencyIndex
		expect(idx.get('key-1')).toBe('cancelled')
		expect(idx.get('key-2-not-found')).toBe('not_found')
	})

	it('[TL28] cancelReservation cross-tenant + idempotency: cached not_found does NOT leak data', async () => {
		const { tl, externalId } = await freshlyCreated()
		// First call (cross-tenant) → not_found cached.
		const r1 = await tl.cancelReservation({
			tenantId: 'org_OTHER',
			externalId,
			idempotencyKey: 'cross-tenant-key',
		})
		expect(r1.status).toBe('not_found')
		// Repeat returns same cached outcome — without mutating reservation.
		const r2 = await tl.cancelReservation({
			tenantId: 'org_OTHER',
			externalId,
			idempotencyKey: 'cross-tenant-key',
		})
		expect(r2.status).toBe('not_found')
		// Underlying reservation должно остаться Confirmed (cross-tenant gate held).
		const stored = tl.__test_inspect().reservations.find((r) => r.tlReservationId === externalId)
		expect(stored?.status).toBe('Confirmed')
	})
})

// =============================================================================
// Round 8 — ChannelReservation.sequenceNumber propagation through readReservations
// =============================================================================

describe('TravelLine Mock — Round 8 readReservations sequenceNumber (TL29-TL30)', () => {
	it('[TL29] readReservations propagates per-resource sequenceNumber to caller', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		tl.__test_seedReservation({
			tlReservationId: 'tl-seq-1',
			tenantId: TENANT,
			propertyId: PROPERTY,
			hotelId: HOTEL_ID,
			tlRoomTypeId: 'tl_rt_deluxe',
			tlRatePlanId: 'tl_rp_bar_flex',
			arrivalDate: '2027-09-01',
			departureDate: '2027-09-02',
			guestCount: 1,
			totalPriceMicros: 5_000_000n,
			status: 'Confirmed',
			lastModificationUtc: '2026-05-10T08:00:00.000Z',
			sequenceNumber: 42_424_242n,
			guest: { firstName: 'X', lastName: 'Y' },
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime',
				hoursBeforeRef: 24,
				penaltyKind: 'first_night',
				penaltyValue: 1,
			},
		})
		const r = await tl.readReservations({ tenantId: TENANT, propertyId: PROPERTY })
		expect(r.reservations).toHaveLength(1)
		const first = r.reservations[0]
		expect(first?.sequenceNumber).toBe(42_424_242n)
	})

	it('[TL30] createBooking issues a strictly-increasing sequenceNumber на new reservation', async () => {
		const tl = createTravellineMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			__test_disableRateLimit: true,
		})
		const verify = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		const a = await tl.createBooking({ verifyResult: verify, idempotencyKey: 'i-a' })
		const verify2 = await tl.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			checkIn: '2027-07-15',
			checkOut: '2027-07-17',
			guestCount: 1,
			guest: { firstName: 'C', lastName: 'D', email: 'c@test.ru', phone: '+79991234568' },
		})
		const b = await tl.createBooking({ verifyResult: verify2, idempotencyKey: 'i-b' })
		const inspected = tl.__test_inspect()
		const ra = inspected.reservations.find((r) => r.tlReservationId === a.externalId)
		const rb = inspected.reservations.find((r) => r.tlReservationId === b.externalId)
		expect(ra?.sequenceNumber).toBeLessThan(rb?.sequenceNumber ?? 0n)
	})
})
