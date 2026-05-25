/**
 * Yandex mock-OTA API client — strict shape tests.
 *
 * Test matrix:
 *   ─── searchOffers ─────────────────────────────────────────────
 *     [S1] GET /api/_mock-ota/yandex/v1/hotels/hotel/offers
 *     [S2] params encoded as URLSearchParams
 *     [S3] Authorization header = "OAuth demo-test-token"
 *     [S4] success path returns { kind: 'ok', data: { offers: [...] } }
 *     [S5] http 400 with error body returns { kind: 'error' }
 *
 *   ─── createOrder ──────────────────────────────────────────────
 *     [C1] POST /api/_mock-ota/yandex/v1/hotels/booking/orders
 *     [C2] body is JSON-encoded request payload
 *     [C3] Content-Type and Authorization headers set
 *     [C4] success returns { kind: 'ok', data: { order_id, status } }
 *     [C5] http 400 returns { kind: 'error' }
 */

import { describe, expect, test } from 'bun:test'
import {
	createOrder,
	DEFAULT_HOTEL_ID,
	searchOffers,
	type YandexCreateOrderResponse,
	type YandexOffersResponse,
} from './api-client.ts'

interface CapturedCall {
	url: string
	method: string
	headers: Record<string, string>
	body: string | undefined
}

function makeMockFetch(
	responseBody: unknown,
	{ ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): { fetch: typeof fetch; calls: CapturedCall[] } {
	const calls: CapturedCall[] = []
	const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const headers: Record<string, string> = {}
		const hdr = init?.headers
		if (hdr instanceof Headers) {
			hdr.forEach((v, k) => {
				headers[k] = v
			})
		} else if (Array.isArray(hdr)) {
			for (const [k, v] of hdr) headers[k] = v
		} else if (hdr && typeof hdr === 'object') {
			for (const [k, v] of Object.entries(hdr)) headers[k] = String(v)
		}
		calls.push({
			url: typeof input === 'string' ? input : input.toString(),
			method: init?.method ?? 'GET',
			headers,
			body: typeof init?.body === 'string' ? init.body : undefined,
		})
		return {
			ok,
			status,
			json: async () => responseBody,
		} as Response
	}) as typeof fetch
	return { fetch: mockFetch, calls }
}

describe('searchOffers', () => {
	const successBody: YandexOffersResponse = {
		offers: [
			{
				booking_token: 'aBcDeFgHiJkL',
				room_name: 'Стандартный номер с видом на горы',
				daily_prices: [6000, 6000],
				total_price: 12000,
				currency: 'RUB',
				can_send_comment_to_hotel: true,
			},
		],
	}

	test('[S1+S2] GET path includes URLSearchParams for hotelId/dates/party', async () => {
		const { fetch: mockFetch, calls } = makeMockFetch(successBody)
		await searchOffers(
			{
				hotelId: DEFAULT_HOTEL_ID,
				checkinDate: '2026-06-15',
				checkoutDate: '2026-06-17',
				adults: 2,
				children: 0,
			},
			mockFetch,
		)
		expect(calls.length).toBe(1)
		const call = calls[0]!
		expect(call.method).toBe('GET')
		expect(call.url).toContain('/api/_mock-ota/yandex/v1/hotels/hotel/offers')
		expect(call.url).toContain('hotelId=demo-hotel-sochi')
		expect(call.url).toContain('checkinDate=2026-06-15')
		expect(call.url).toContain('checkoutDate=2026-06-17')
		expect(call.url).toContain('adults=2')
		expect(call.url).toContain('children=0')
	})

	test('[S3] Authorization header sent exactly', async () => {
		const { fetch: mockFetch, calls } = makeMockFetch(successBody)
		await searchOffers(
			{
				hotelId: 'x',
				checkinDate: '2026-06-15',
				checkoutDate: '2026-06-17',
				adults: 1,
				children: 0,
			},
			mockFetch,
		)
		expect(calls[0]!.headers.Authorization ?? calls[0]!.headers.authorization).toBe(
			'OAuth demo-test-token',
		)
	})

	test('[S4] success path returns { kind: "ok", data }', async () => {
		const { fetch: mockFetch } = makeMockFetch(successBody)
		const result = await searchOffers(
			{
				hotelId: 'x',
				checkinDate: '2026-06-15',
				checkoutDate: '2026-06-17',
				adults: 1,
				children: 0,
			},
			mockFetch,
		)
		expect(result.kind).toBe('ok')
		if (result.kind === 'ok') {
			expect(result.data.offers.length).toBe(1)
			expect(result.data.offers[0]!.booking_token).toBe('aBcDeFgHiJkL')
			expect(result.data.offers[0]!.total_price).toBe(12000)
		}
	})

	test('[S5] http 400 returns { kind: "error", status, error }', async () => {
		const { fetch: mockFetch } = makeMockFetch(
			{ error: 'invalid_date_range' },
			{ ok: false, status: 400 },
		)
		const result = await searchOffers(
			{
				hotelId: 'x',
				checkinDate: 'bad',
				checkoutDate: 'bad',
				adults: 1,
				children: 0,
			},
			mockFetch,
		)
		expect(result.kind).toBe('error')
		if (result.kind === 'error') {
			expect(result.status).toBe(400)
			expect(result.error).toBe('invalid_date_range')
		}
	})
})

describe('createOrder', () => {
	const successBody: YandexCreateOrderResponse = {
		order_id: 'yt-order-abc123def456',
		status: 'CONFIRMED',
	}

	test('[C1+C2+C3] POST path + JSON body + headers', async () => {
		const { fetch: mockFetch, calls } = makeMockFetch(successBody)
		await createOrder(
			{
				booking_token: 'aBcDeFgHiJkL',
				customer_email: 'ivan@example.com',
				customer_phone: '+79999999999',
				guests: [{ first_name: 'Иван', last_name: 'Иванов' }],
			},
			mockFetch,
		)
		expect(calls.length).toBe(1)
		const call = calls[0]!
		expect(call.method).toBe('POST')
		expect(call.url).toBe('/api/_mock-ota/yandex/v1/hotels/booking/orders')
		expect(call.headers['Content-Type'] ?? call.headers['content-type']).toBe('application/json')
		expect(call.headers.Authorization ?? call.headers.authorization).toBe('OAuth demo-test-token')
		const parsed = JSON.parse(call.body ?? '{}')
		expect(parsed.booking_token).toBe('aBcDeFgHiJkL')
		expect(parsed.customer_email).toBe('ivan@example.com')
		expect(parsed.customer_phone).toBe('+79999999999')
		expect(parsed.guests).toEqual([{ first_name: 'Иван', last_name: 'Иванов' }])
	})

	test('[C4] success returns { kind: "ok", data }', async () => {
		const { fetch: mockFetch } = makeMockFetch(successBody)
		const result = await createOrder(
			{
				booking_token: 't',
				customer_email: 'ivan@example.com',
				customer_phone: '+79999999999',
				guests: [{ first_name: 'И', last_name: 'И' }],
			},
			mockFetch,
		)
		expect(result.kind).toBe('ok')
		if (result.kind === 'ok') {
			expect(result.data.order_id).toBe('yt-order-abc123def456')
			expect(result.data.status).toBe('CONFIRMED')
		}
	})

	test('[C5] http 400 returns { kind: "error" }', async () => {
		const { fetch: mockFetch } = makeMockFetch(
			{ error: 'invalid_booking_token' },
			{ ok: false, status: 400 },
		)
		const result = await createOrder(
			{
				booking_token: 'bad',
				customer_email: 'ivan@example.com',
				customer_phone: '+79999999999',
				guests: [{ first_name: 'И', last_name: 'И' }],
			},
			mockFetch,
		)
		expect(result.kind).toBe('error')
		if (result.kind === 'error') {
			expect(result.status).toBe(400)
			expect(result.error).toBe('invalid_booking_token')
		}
	})
})
