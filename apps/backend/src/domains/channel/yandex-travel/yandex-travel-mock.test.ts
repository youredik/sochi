/**
 * Yandex.Travel Mock — strict tests YT1-YT12 (M10 / A7.3).
 *
 * Pure-function tests. Verifies D6 + D11+D12 inbound + D17 consent +
 * D19 cross-border + D25 + D25.c canon:
 *
 *   - push-ARI idempotent (same delta replayed → no double-count)
 *   - signed JSON POST с HMAC-SHA256
 *   - replay window 300s
 *   - IP-allowlist gate (production canon)
 *   - cancellation policy mandatory
 *   - 152-ФЗ residency: non-RU photo host → reject
 *   - granular consent 3-checkbox enforcement
 *   - RUB-only currency reject
 *   - Алиса AI discoverability: metadata via emit envelope
 */

import { describe, expect, it } from 'bun:test'
import { buildCloudEvent, buildSourceUrn } from '../../../lib/channel-manager/cloud-events.ts'
import { computeYtSignature, createYandexTravelMock, findNonRuHost } from './yandex-travel-mock.ts'

const TENANT = 'org_yt_test_a'
const PROPERTY = 'prop_yt_main'
const SECRET = `yt-test-secret-${'A'.repeat(40)}`
const SOURCE_URN = buildSourceUrn({ channelCode: 'YT', organizationId: TENANT })

function buildAri(overrides: Partial<{ date: string; availability: number }> = {}) {
	return {
		tenantId: TENANT,
		propertyId: PROPERTY,
		date: overrides.date ?? '2027-06-15',
		roomTypeId: 'yt_rt_deluxe',
		ratePlanId: 'yt_rp_bar',
		availability: overrides.availability ?? 5,
		rateMicros: 6_000_000n,
		currency: 'RUB' as const,
	}
}

function buildSignedWebhook(input: { body: object; secret: string; timestampSec?: number }) {
	const bodyStr = JSON.stringify(input.body)
	const ts = input.timestampSec ?? Math.floor(Date.now() / 1000)
	const sig = computeYtSignature({
		timestampSec: ts,
		rawBody: bodyStr,
		secret: input.secret,
	})
	return {
		rawBody: new TextEncoder().encode(bodyStr),
		headers: {
			'x-yt-timestamp': ts.toString(),
			'x-yt-signature': sig,
		},
	}
}

describe('YT Mock — D1/D6 push-ARI passthrough (YT1-YT3)', () => {
	it('[YT1] pushAri accepts new delta + persists в idempotency index', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const r = await yt.pushAri([buildAri({ date: '2027-06-15' })])
		expect(r.accepted).toBe(1)
		expect(r.rejected).toBe(0)
		expect(yt.__test_listAriPushes()).toHaveLength(1)
	})

	it('[YT2] pushAri idempotent: replaying same (tenant,property,roomType,ratePlan,date) → 0 accepted', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		await yt.pushAri([buildAri({ date: '2027-06-15' })])
		const r2 = await yt.pushAri([buildAri({ date: '2027-06-15' })])
		expect(r2.accepted).toBe(0)
		expect(yt.__test_listAriPushes()).toHaveLength(1) // not duplicated
	})

	it('[YT3] pushAriFull clears index + re-pushes everything', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		await yt.pushAri([buildAri({ date: '2027-06-15' })])
		const r = await yt.pushAriFull([
			buildAri({ date: '2027-06-15' }),
			buildAri({ date: '2027-06-16' }),
		])
		expect(r.accepted).toBe(2)
		expect(yt.__test_listAriPushes()).toHaveLength(2)
	})
})

describe('YT Mock — D25 webhook signature verify (YT4-YT7)', () => {
	it('[YT4] valid signature + envelope → ok with parsed event', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const event = buildCloudEvent({
			id: 'yt-evt-1',
			source: SOURCE_URN,
			type: 'app.sochi.channel.booking.created.v1',
			data: {
				consent: { processing: true, transferToHotel: true, marketing: false },
				photoUrls: ['https://storage.yandexcloud.net/h/p1.jpg'],
				currency: 'RUB',
			},
		})
		const { rawBody, headers } = buildSignedWebhook({ body: event, secret: SECRET })
		const r = await yt.receiveBookingWebhook({ rawBody, headers, clientIp: undefined })
		expect(r.ok).toBe(true)
		if (r.ok) expect(r.event.id).toBe('yt-evt-1')
	})

	it('[YT5] tampered body (different bytes than signature) → 401', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const event = buildCloudEvent({
			id: 'yt-evt-2',
			source: SOURCE_URN,
			type: 'app.sochi.channel.booking.created.v1',
			data: {
				consent: { processing: true, transferToHotel: true, marketing: false },
			},
		})
		const { rawBody: _, headers } = buildSignedWebhook({ body: event, secret: SECRET })
		void _
		const tamperedBody = JSON.stringify({ ...event, id: 'yt-evt-MUTATED' })
		const r = await yt.receiveBookingWebhook({
			rawBody: new TextEncoder().encode(tamperedBody),
			headers,
			clientIp: undefined,
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.httpStatus).toBe(401)
	})

	it('[YT6] replay window exceeded (timestamp 10min old) → 403', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const event = buildCloudEvent({
			id: 'yt-evt-3',
			source: SOURCE_URN,
			type: 'app.sochi.channel.booking.created.v1',
			data: { consent: { processing: true, transferToHotel: true, marketing: false } },
		})
		const oldTs = Math.floor(Date.now() / 1000) - 600 // 10 min ago
		const { rawBody, headers } = buildSignedWebhook({
			body: event,
			secret: SECRET,
			timestampSec: oldTs,
		})
		const r = await yt.receiveBookingWebhook({ rawBody, headers, clientIp: undefined })
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.httpStatus).toBe(403)
			expect(r.reason).toBe('replay_window_exceeded')
		}
	})

	it('[YT7] missing signature header → 400', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const event = buildCloudEvent({
			id: 'yt-evt-4',
			source: SOURCE_URN,
			type: 'app.sochi.channel.booking.created.v1',
			data: { consent: { processing: true, transferToHotel: true, marketing: false } },
		})
		const r = await yt.receiveBookingWebhook({
			rawBody: new TextEncoder().encode(JSON.stringify(event)),
			headers: { 'x-yt-timestamp': Math.floor(Date.now() / 1000).toString() },
			clientIp: undefined,
		})
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.httpStatus).toBe(400)
	})
})

describe('YT Mock — D25.c IP allowlist (YT8)', () => {
	it('[YT8] IP NOT in allowlist → 401', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
			allowedInboundIps: ['77.88.55.1', '77.88.55.2'],
		})
		const event = buildCloudEvent({
			id: 'yt-evt-5',
			source: SOURCE_URN,
			type: 'app.sochi.channel.booking.created.v1',
			data: { consent: { processing: true, transferToHotel: true, marketing: false } },
		})
		const { rawBody, headers } = buildSignedWebhook({ body: event, secret: SECRET })
		const r = await yt.receiveBookingWebhook({ rawBody, headers, clientIp: '8.8.8.8' })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.httpStatus).toBe(401)
	})
})

describe('YT Mock — D17 granular consent + D19 cross-border + RUB only (YT9-YT11)', () => {
	it('[YT9] consent missing transferToHotel → 422', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const event = buildCloudEvent({
			id: 'yt-evt-consent-1',
			source: SOURCE_URN,
			type: 'app.sochi.channel.booking.created.v1',
			data: {
				// processing=true, NO transferToHotel
				consent: { processing: true, transferToHotel: false, marketing: false },
			},
		})
		const { rawBody, headers } = buildSignedWebhook({ body: event, secret: SECRET })
		const r = await yt.receiveBookingWebhook({ rawBody, headers, clientIp: undefined })
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.httpStatus).toBe(422)
			expect(r.reason).toBe('consent_missing_required_checkboxes')
		}
	})

	it('[YT10] non-RU photo host → 422 (D19 cross-border-transfer gate)', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const event = buildCloudEvent({
			id: 'yt-evt-photo',
			source: SOURCE_URN,
			type: 'app.sochi.channel.booking.created.v1',
			data: {
				consent: { processing: true, transferToHotel: true, marketing: false },
				photoUrls: ['https://aws.cloudfront.net/h/p.jpg'], // US-resident
			},
		})
		const { rawBody, headers } = buildSignedWebhook({ body: event, secret: SECRET })
		const r = await yt.receiveBookingWebhook({ rawBody, headers, clientIp: undefined })
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.httpStatus).toBe(422)
			expect(r.reason).toContain('non_ru_photo_host')
		}
	})

	it('[YT11] non-RUB currency → 422', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const event = buildCloudEvent({
			id: 'yt-evt-currency',
			source: SOURCE_URN,
			type: 'app.sochi.channel.booking.created.v1',
			data: {
				consent: { processing: true, transferToHotel: true, marketing: false },
				currency: 'USD',
			},
		})
		const { rawBody, headers } = buildSignedWebhook({ body: event, secret: SECRET })
		const r = await yt.receiveBookingWebhook({ rawBody, headers, clientIp: undefined })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.reason).toBe('non_rub_currency')
	})
})

describe('YT Mock — booking flow + emit + cross-tenant (YT12-YT14)', () => {
	it('[YT12] verify+create+cancel flow + idempotent cancel', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const verify = await yt.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'yt_rt',
			ratePlanId: 'yt_rp',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 2,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		expect(verify.cancellationPolicy.referencePoint).toBe('GuestArrivalTime')
		expect(verify.cancellationPolicy.hoursBeforeRef).toBe(48)
		expect(verify.totalAmountMicros).toBe(24_000_000n) // 6M × 2 nights × 2 guests
		const create = await yt.createBooking({ verifyResult: verify, idempotencyKey: 'i-1' })
		expect(create.externalId.startsWith('yt-res-')).toBe(true)
		const c1 = await yt.cancelReservation({ tenantId: TENANT, externalId: create.externalId })
		expect(c1.status).toBe('cancelled')
		const c2 = await yt.cancelReservation({ tenantId: TENANT, externalId: create.externalId })
		expect(c2.status).toBe('already_cancelled')
	})

	it('[YT13] cross-tenant cancel → not_found', async () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		const verify = await yt.verifyBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'yt_rt',
			ratePlanId: 'yt_rp',
			checkIn: '2027-06-15',
			checkOut: '2027-06-17',
			guestCount: 1,
			guest: { firstName: 'A', lastName: 'B', email: 'a@test.ru', phone: '+79991234567' },
		})
		const create = await yt.createBooking({ verifyResult: verify, idempotencyKey: 'i-1' })
		const r = await yt.cancelReservation({ tenantId: 'org_OTHER', externalId: create.externalId })
		expect(r.status).toBe('not_found')
	})

	it('[YT14] emitReservationEvent — canonical CE envelope с tenant URN', () => {
		const yt = createYandexTravelMock({
			tenantId: TENANT,
			propertyId: PROPERTY,
			hmacSecret: SECRET,
		})
		yt.__test_seedReservation({
			externalId: 'yt-res-emit-1',
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: 'rt',
			ratePlanId: 'rp',
			arrivalDate: '2027-06-15',
			departureDate: '2027-06-17',
			guestCount: 1,
			totalAmountMicros: 12_000_000n,
			status: 'Confirmed',
			lastModificationUtc: new Date().toISOString(),
			guest: { firstName: 'A', lastName: 'B' },
			consent: { processing: true, transferToHotel: true, marketing: false },
		})
		const reservations = yt.__test_inspect().reservations
		const reservation = reservations[0]
		if (!reservation) throw new Error('reservation seed missing')
		const event = yt.emitReservationEvent(reservation)
		expect(event.specversion).toBe('1.0')
		expect(event.source).toBe(SOURCE_URN)
		expect(event.type).toBe('app.sochi.channel.booking.created.v1')
		expect(event.subject).toBe('yt-res-emit-1')
	})
})

describe('YT Mock — findNonRuHost helper (YT15-YT16)', () => {
	it('[YT15] all RU hosts → null', () => {
		expect(
			findNonRuHost([
				'https://storage.yandexcloud.net/h/p.jpg',
				'https://avatars.mds.yandex.net/x/y',
			]),
		).toBeNull()
	})

	it('[YT16] mixed → returns first non-RU host', () => {
		expect(
			findNonRuHost([
				'https://storage.yandexcloud.net/h/p.jpg',
				'https://aws.cloudfront.net/h/x.jpg',
				'https://yandex.ru/u',
			]),
		).toBe('aws.cloudfront.net')
	})

	it('[YT17] malformed URL → returns the bad input as non-RU', () => {
		expect(findNonRuHost(['not-a-url'])).toBe('not-a-url')
	})
})
