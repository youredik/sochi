/**
 * Round 9 — typed fetch client for the Yandex.Путешествия mock-OTA backend.
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md`.
 *
 * Wraps two backend endpoints mounted at `/api/_mock-ota/yandex/v1`:
 *   - `GET /hotels/hotel/offers` — search availability (returns booking_token)
 *   - `POST /hotels/booking/orders` — create order (returns order_id + status)
 *
 * **Auth**: real Yandex.Путешествия requires `Authorization: OAuth <token>`.
 * Mock accepts any non-empty bearer string; we send a deterministic value so
 * demo logs are predictable.
 *
 * **Shape contract** — mirrors real Yandex.Путешествия whitelabel API. Do
 * NOT add fields without checking the backend route handler — the demo
 * deliberately stays small so the visual surface area is the focus.
 */

const API_BASE = '/api/_mock-ota/yandex/v1'
const DEMO_AUTH_TOKEN = 'OAuth demo-test-token'

/**
 * Round 14.6.4 follow-up — frontend hotelId placeholder.
 *
 * Pre-Round-14.6.4 this constant flowed as the authoritative hotelId через
 * query param; backend echoed it в webhook data → identical hotel_id для
 * every tenant. Round 14.6.4 backend now DERIVES the hotelId per-tenant
 * from authenticated session (`c.var.tenantId` → `resolveDemoPropertyId`).
 * Backend ignores query.hotelId value but still validates non-empty
 * (legacy callers + Round 9 smoke tests pass it explicitly).
 *
 * Frontend retains this placeholder ONLY to satisfy that non-empty contract.
 * Canonical 2026 multi-tenant pattern — server-side identity derivation is
 * the only authority (web research 28.05.2026).
 */
export const DEFAULT_HOTEL_ID = 'demo-hotel-sochi'

export interface YandexOffer {
	readonly booking_token: string
	readonly room_name: string
	readonly daily_prices: ReadonlyArray<number>
	readonly total_price: number
	readonly currency: string
	readonly can_send_comment_to_hotel: boolean
}

export interface YandexOffersResponse {
	readonly offers: ReadonlyArray<YandexOffer>
}

export interface YandexErrorResponse {
	readonly error: string
}

export interface YandexCreateOrderRequest {
	readonly booking_token: string
	readonly customer_email: string
	readonly customer_phone: string
	readonly guests: ReadonlyArray<{
		readonly first_name: string
		readonly last_name: string
		readonly is_child?: boolean
		readonly age?: number
	}>
	readonly comment?: string
}

export interface YandexCreateOrderResponse {
	readonly order_id: string
	readonly status: 'CONFIRMED'
}

export type YandexApiResult<T> =
	| { readonly kind: 'ok'; readonly data: T }
	| { readonly kind: 'error'; readonly status: number; readonly error: string }

export interface SearchOffersParams {
	readonly hotelId: string
	readonly checkinDate: string
	readonly checkoutDate: string
	readonly adults: number
	readonly children: number
}

/**
 * Search availability for a hotel + date range. Returns a `booking_token`
 * that must be passed to {@link createOrder} to confirm the reservation.
 */
export async function searchOffers(
	params: SearchOffersParams,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<YandexApiResult<YandexOffersResponse>> {
	const url = new URL(
		`${API_BASE}/hotels/hotel/offers`,
		globalThis.location?.origin ?? 'http://localhost',
	)
	url.searchParams.set('hotelId', params.hotelId)
	url.searchParams.set('checkinDate', params.checkinDate)
	url.searchParams.set('checkoutDate', params.checkoutDate)
	url.searchParams.set('adults', String(params.adults))
	url.searchParams.set('children', String(params.children))

	const res = await fetchImpl(url.pathname + url.search, {
		method: 'GET',
		headers: {
			Authorization: DEMO_AUTH_TOKEN,
		},
	})

	const body = (await res.json()) as YandexOffersResponse | YandexErrorResponse
	if (!res.ok || 'error' in body) {
		const errBody = body as YandexErrorResponse
		return { kind: 'error', status: res.status, error: errBody.error }
	}
	return { kind: 'ok', data: body }
}

/**
 * Confirm an order using a previously-issued `booking_token`. Token is
 * single-use — calling twice with the same token returns 400.
 */
export async function createOrder(
	body: YandexCreateOrderRequest,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<YandexApiResult<YandexCreateOrderResponse>> {
	const res = await fetchImpl(`${API_BASE}/hotels/booking/orders`, {
		method: 'POST',
		headers: {
			Authorization: DEMO_AUTH_TOKEN,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})

	const responseBody = (await res.json()) as YandexCreateOrderResponse | YandexErrorResponse
	if (!res.ok || 'error' in responseBody) {
		const errBody = responseBody as YandexErrorResponse
		return { kind: 'error', status: res.status, error: errBody.error }
	}
	return { kind: 'ok', data: responseBody }
}
