/**
 * Round 9 — Yandex.Путешествия mock OTA HTTP-routes strict tests.
 *
 * Wraps the Round 8 production-grade `YandexTravelMock` adapter with a
 * guest-facing HTTP surface that mirrors the real Yandex.Путешествия API
 * shape (`whitelabel.travel.yandex-net.ru`). Demo guest creates an order
 * → mock fires CloudEvents webhook back to our own
 * `/api/channel/webhooks/YT` endpoint → reservation lands в PMS inbox.
 *
 * Test IDs follow `[YTR<n>]` numbering for cross-reference.
 *
 * Strict-tests canon (`feedback_strict_tests`):
 *   - Exact-value `.toBe(...)` / `.toEqual(...)` only.
 *   - No weak matchers (см. feedback_strict_tests canon).
 *   - Immutable-field assertions where applicable.
 *   - Adversarial cases (missing auth, bad token, idempotent replay).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { parseCloudEvent } from '../../../../lib/channel-manager/cloud-events.ts'
import { createInMemoryYandexStore, type YandexStore } from './state.ts'
import { createYandexMockOtaRoutes } from './yandex.routes.ts'

// Round 14 self-review #6 — fresh in-memory store per test (replaces module-
// level `__resetState`).
let testStore: YandexStore = createInMemoryYandexStore()

const TEST_TENANT = 'org_demo_yt'
const TEST_HOTEL = 'hotel_demo_42'
const TEST_AUTH = 'OAuth demo-mock-token-1234'

interface FetchCall {
	readonly url: string
	readonly init?: RequestInit | undefined
}

function buildFetchSpy(opts: { respond?: (call: FetchCall) => Response | Promise<Response> } = {}) {
	const calls: FetchCall[] = []
	const spy = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		calls.push({ url, init })
		if (opts.respond) return opts.respond({ url, init })
		return new Response(JSON.stringify({ accepted: true, eventId: 'mocked', kid: 'kid_demo' }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}
	// `typeof fetch` includes `preconnect` (Bun's WHATWG fetch); test spy doesn't
	// need it — cast through `unknown` to satisfy strict TS without violating
	// any runtime contract (route handler only calls the function variant).
	const fetchImpl = spy as unknown as typeof fetch
	return { calls, fetchImpl }
}

function mountApp(deps: { fetchImpl?: typeof fetch } = {}) {
	const router = createYandexMockOtaRoutes({
		tenantId: TEST_TENANT,
		propertyId: TEST_HOTEL,
		webhookTargetUrl: 'http://test.invalid/api/channel/webhooks/YT',
		webhookSecret: 'whsec_demo_test_only',
		store: testStore,
		...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
	})
	return new Hono().route('/v1', router)
}

const VALID_SEARCH_QUERY = new URLSearchParams({
	hotelId: TEST_HOTEL,
	checkinDate: '2027-06-15',
	checkoutDate: '2027-06-17',
	adults: '2',
	children: '0',
}).toString()

async function searchOnce(app: Hono): Promise<{
	status: number
	body: {
		offers: ReadonlyArray<{
			booking_token: string
			room_name: string
			daily_prices: ReadonlyArray<number>
			total_price: number
			currency: string
			can_send_comment_to_hotel: boolean
		}>
	}
}> {
	const res = await app.request(`/v1/hotels/hotel/offers?${VALID_SEARCH_QUERY}`, {
		method: 'GET',
		headers: { authorization: TEST_AUTH },
	})
	const body = (await res.json()) as {
		offers: ReadonlyArray<{
			booking_token: string
			room_name: string
			daily_prices: ReadonlyArray<number>
			total_price: number
			currency: string
			can_send_comment_to_hotel: boolean
		}>
	}
	return { status: res.status, body }
}

describe('Yandex mock-OTA HTTP routes', () => {
	beforeEach(() => {
		testStore = createInMemoryYandexStore()
	})
	afterEach(async () => {
		await testStore.__reset()
	})

	it('[YTR1] GET /hotels/hotel/offers returns offers with valid booking_token', async () => {
		const app = mountApp()
		const { status, body } = await searchOnce(app)
		expect(status).toBe(200)
		expect(body.offers.length).toBe(1)
		const offer = body.offers[0]
		expect(offer === undefined).toBe(false)
		if (offer === undefined) throw new Error('unreachable')
		expect(offer.booking_token.length).toBe(12)
		expect(offer.currency).toBe('RUB')
		expect(offer.can_send_comment_to_hotel).toBe(true)
		expect(offer.daily_prices.length).toBe(2) // 2 nights between 15→17
		expect(offer.total_price).toBe(offer.daily_prices.reduce((s, p) => s + p, 0))
		// Booking token persisted в state так POST /orders может его консьюмить.
		expect((await testStore.__listBookingTokens()).length).toBe(1)
		const stored = (await testStore.__listBookingTokens())[0]
		expect(stored === undefined).toBe(false)
		if (stored === undefined) throw new Error('unreachable')
		expect(stored.token).toBe(offer.booking_token)
	})

	it('[YTR2] GET /hotels/hotel/offers rejects bad date range (checkin >= checkout) with 400', async () => {
		const app = mountApp()
		const bad = new URLSearchParams({
			hotelId: TEST_HOTEL,
			checkinDate: '2027-06-17',
			checkoutDate: '2027-06-15', // before checkin
			adults: '1',
			children: '0',
		}).toString()
		const res = await app.request(`/v1/hotels/hotel/offers?${bad}`, {
			method: 'GET',
			headers: { authorization: TEST_AUTH },
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe('invalid_date_range')
		expect((await testStore.__listBookingTokens()).length).toBe(0)
	})

	it('[YTR3] POST /hotels/booking/orders requires valid booking_token (400 invalid_booking_token)', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })
		const res = await app.request('/v1/hotels/booking/orders', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: TEST_AUTH,
			},
			body: JSON.stringify({
				booking_token: 'NOPE_NOT_REAL',
				customer_email: 'ivan@example.com',
				customer_phone: '+70000000001',
				guests: [{ first_name: 'Иван', last_name: 'Иванов' }],
			}),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe('invalid_booking_token')
		// No webhook fired когда token не valid.
		expect(calls.length).toBe(0)
		expect((await testStore.__listOrders()).length).toBe(0)
	})

	it('[YTR4] POST /hotels/booking/orders with valid token returns CONFIRMED + fires CloudEvents webhook', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })
		const { body: searchBody } = await searchOnce(app)
		const token = searchBody.offers[0]?.booking_token
		expect(token === undefined).toBe(false)
		if (token === undefined) throw new Error('unreachable')

		const res = await app.request('/v1/hotels/booking/orders', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: TEST_AUTH,
			},
			body: JSON.stringify({
				booking_token: token,
				customer_email: 'guest@example.com',
				customer_phone: '+70000000001',
				guests: [{ first_name: 'Иван', last_name: 'Иванов' }],
				comment: 'Тестовый комментарий',
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { order_id: string; status: string }
		expect(body.status).toBe('CONFIRMED')
		expect(body.order_id.startsWith('yt-order-')).toBe(true)

		// Webhook fired ровно один раз с правильной signature shape.
		expect(calls.length).toBe(1)
		const call = calls[0]
		if (call === undefined) throw new Error('unreachable')
		expect(call.url).toBe('http://test.invalid/api/channel/webhooks/YT')
		const headers = call.init?.headers as Record<string, string> | undefined
		expect(headers === undefined).toBe(false)
		if (headers === undefined) throw new Error('unreachable')
		expect(headers['content-type']).toBe('application/json')
		expect(typeof headers['webhook-id']).toBe('string')
		expect(typeof headers['webhook-timestamp']).toBe('string')
		expect(headers['webhook-signature']?.startsWith('v1,')).toBe(true)

		// Body — valid CloudEvents 1.0.2 envelope.
		const rawBody = call.init?.body
		expect(typeof rawBody).toBe('string')
		if (typeof rawBody !== 'string') throw new Error('unreachable')
		const parsed = parseCloudEvent(JSON.parse(rawBody))
		expect(parsed === null).toBe(false)
		if (parsed === null) throw new Error('unreachable')
		expect(parsed.specversion).toBe('1.0')
		expect(parsed.type).toBe('app.sochi.channel.booking.created.v1')
		expect(parsed.source).toBe(`urn:sochi:channel:YT:tenant:${TEST_TENANT}`)
		expect(parsed.subject).toBe(body.order_id)
		const data = parsed.data as { order_id: string; channel_id: string }
		expect(data.order_id).toBe(body.order_id)
		expect(data.channel_id).toBe('YT')

		expect((await testStore.__listOrders()).length).toBe(1)
		// Token consumed — single-use semantics.
		expect((await testStore.__listBookingTokens()).length).toBe(0)
	})

	it('[YTR5] POST /payment/cancel returns CANCELLED + fires CloudEvents webhook', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })
		const { body: searchBody } = await searchOnce(app)
		const token = searchBody.offers[0]?.booking_token
		if (token === undefined) throw new Error('unreachable')

		const createRes = await app.request('/v1/hotels/booking/orders', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: TEST_AUTH },
			body: JSON.stringify({
				booking_token: token,
				customer_email: 'guest@example.com',
				customer_phone: '+70000000001',
				guests: [{ first_name: 'Иван', last_name: 'Иванов' }],
			}),
		})
		expect(createRes.status).toBe(200)
		const { order_id: orderId } = (await createRes.json()) as {
			order_id: string
		}
		expect(calls.length).toBe(1) // created webhook

		const cancelRes = await app.request(`/v1/hotels/booking/orders/${orderId}/payment/cancel`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: TEST_AUTH,
			},
		})
		expect(cancelRes.status).toBe(200)
		const body = (await cancelRes.json()) as {
			order_id: string
			status: string
		}
		expect(body.order_id).toBe(orderId)
		expect(body.status).toBe('CANCELLED')

		// Cancel webhook fired (second call).
		expect(calls.length).toBe(2)
		const cancelCall = calls[1]
		if (cancelCall === undefined) throw new Error('unreachable')
		const rawBody = cancelCall.init?.body
		if (typeof rawBody !== 'string') throw new Error('unreachable')
		const parsed = parseCloudEvent(JSON.parse(rawBody))
		if (parsed === null) throw new Error('unreachable')
		expect(parsed.type).toBe('app.sochi.channel.booking.cancelled.v1')
	})

	it('[YTR6] Missing Authorization → 401 unauthorized', async () => {
		const app = mountApp()
		const res = await app.request(
			`/v1/hotels/hotel/offers?${VALID_SEARCH_QUERY}`,
			{ method: 'GET' }, // no auth header
		)
		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe('unauthorized')
	})

	it('[YTR6.b] Empty Authorization → 401 unauthorized', async () => {
		const app = mountApp()
		const res = await app.request(`/v1/hotels/hotel/offers?${VALID_SEARCH_QUERY}`, {
			method: 'GET',
			headers: { authorization: '' },
		})
		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe('unauthorized')
	})

	it('[YTR7] Reserved-test guest email accepted normally (no rejection)', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })
		const { body: searchBody } = await searchOnce(app)
		const token = searchBody.offers[0]?.booking_token
		if (token === undefined) throw new Error('unreachable')

		const res = await app.request('/v1/hotels/booking/orders', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: TEST_AUTH },
			body: JSON.stringify({
				booking_token: token,
				customer_email: 'ivan@example.com', // RFC 2606 reserved
				customer_phone: '+70000000001', // Россвязь reserved
				guests: [{ first_name: 'Иван', last_name: 'Иванов' }],
			}),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { status: string }
		expect(body.status).toBe('CONFIRMED')
		// Webhook fires even for reserved-test data (it's demo).
		expect(calls.length).toBe(1)
	})

	it('[YTR8] Idempotent cancel: second cancel of same order_id returns already_cancelled', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })
		const { body: searchBody } = await searchOnce(app)
		const token = searchBody.offers[0]?.booking_token
		if (token === undefined) throw new Error('unreachable')

		const createRes = await app.request('/v1/hotels/booking/orders', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: TEST_AUTH },
			body: JSON.stringify({
				booking_token: token,
				customer_email: 'guest@example.com',
				customer_phone: '+70000000001',
				guests: [{ first_name: 'Иван', last_name: 'Иванов' }],
			}),
		})
		const { order_id: orderId } = (await createRes.json()) as {
			order_id: string
		}

		// First cancel — CANCELLED + webhook fires.
		const c1 = await app.request(`/v1/hotels/booking/orders/${orderId}/payment/cancel`, {
			method: 'POST',
			headers: { authorization: TEST_AUTH },
		})
		expect(c1.status).toBe(200)
		const b1 = (await c1.json()) as { status: string }
		expect(b1.status).toBe('CANCELLED')
		expect(calls.length).toBe(2) // created + first cancelled

		// Second cancel — already_cancelled status, NO additional webhook.
		const c2 = await app.request(`/v1/hotels/booking/orders/${orderId}/payment/cancel`, {
			method: 'POST',
			headers: { authorization: TEST_AUTH },
		})
		expect(c2.status).toBe(200)
		const b2 = (await c2.json()) as { order_id: string; status: string }
		expect(b2.order_id).toBe(orderId)
		expect(b2.status).toBe('already_cancelled')
		// Still 2 calls — no duplicate webhook on idempotent cancel.
		expect(calls.length).toBe(2)
	})

	it('[YTR8.b] Cancel non-existent order → 404 not_found, no webhook', async () => {
		const { fetchImpl, calls } = buildFetchSpy()
		const app = mountApp({ fetchImpl })
		const res = await app.request('/v1/hotels/booking/orders/yt-order-doesnotexis/payment/cancel', {
			method: 'POST',
			headers: { authorization: TEST_AUTH },
		})
		expect(res.status).toBe(404)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe('order_not_found')
		expect(calls.length).toBe(0)
	})
})
