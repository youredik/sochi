/**
 * Round 9 — typed API client for the Островок / ETG mock-OTA demo flow.
 *
 * Canon: `feedback_round_9_demo_ota_server_canon_2026_05_25.md`.
 *
 * Mirrors the real ETG (Emerging Travel Group) B2B API surface verbatim —
 * five sequential stages. The mock backend lives at
 * `apps/backend/src/domains/_demo/mock-ota-server/ostrovok/ostrovok.routes.ts`.
 *
 * **Auth**: real ETG uses HTTP Basic `KEY_ID:API_KEY`. Mock accepts any
 * non-empty `Authorization: Basic ...`. We send the demo literal
 * `Basic ZGVtbzpkZW1v` (= base64 `demo:demo`) so a curl-replay against
 * the same backend works.
 *
 * **Stage map**:
 *   1. searchHotel         → POST /search/hp/
 *   2. prebookForm         → POST /hotel/order/booking/form/
 *   3. finishBooking       → POST /hotel/order/booking/finish/
 *   4. pollFinishStatus    → POST /hotel/order/booking/finish/status/   (optional)
 *   5. cancelBooking       → POST /hotel/order/cancel/
 *
 * Test seam: callers may inject `fetchImpl` (defaults to `globalThis.fetch`).
 * In bun:test the global fetch is BLOCKED — every test MUST inject a spy
 * (`spyOn(globalThis, 'fetch')`).
 */

const BASE = '/api/_mock-ota/ostrovok/v1/api/b2b/v3'
const AUTH_HEADER = 'Basic ZGVtbzpkZW1v' // base64('demo:demo'); demo-only literal

// ── Wire types — match backend response shape verbatim ─────────────────

export interface OstrovokSearchRequest {
	readonly checkin: string // YYYY-MM-DD
	readonly checkout: string // YYYY-MM-DD
	readonly hid: number
	readonly currency: 'RUB'
	readonly language: 'ru'
	readonly residency: 'ru'
	readonly guests: ReadonlyArray<{
		readonly adults: number
		readonly children: ReadonlyArray<number>
	}>
}

export interface OstrovokRate {
	readonly book_hash: string
	readonly daily_prices: ReadonlyArray<number>
	readonly meal_data: {
		readonly value: string
		readonly has_breakfast: boolean
	}
	readonly room_name: string
	readonly total_price: number
	readonly currency_code: 'RUB'
}

export interface OstrovokHotel {
	readonly hid: number
	readonly rates: ReadonlyArray<OstrovokRate>
}

export interface OstrovokSearchOkResponse {
	readonly status: 'ok'
	readonly data: { readonly hotels: ReadonlyArray<OstrovokHotel> }
	readonly debug: null
	readonly error: null
}

export interface OstrovokFormRequest {
	readonly partner_order_id: string // UUIDv4
	readonly book_hash: string
	readonly language: 'ru'
	readonly user_ip: string
}

export interface OstrovokPaymentType {
	readonly type: 'now'
	readonly amount: string
	readonly currency_code: 'RUB'
	readonly is_need_credit_card_data: boolean
	readonly is_need_cvc: boolean
}

export interface OstrovokFormOkResponse {
	readonly status: 'ok'
	readonly data: {
		readonly order_id: number
		readonly partner_order_id: string
		readonly item_id: number
		readonly payment_types: ReadonlyArray<OstrovokPaymentType>
	}
	readonly debug: null
	readonly error: null
}

export interface OstrovokFinishRequest {
	readonly partner: { readonly partner_order_id: string }
	readonly user: { readonly email: string; readonly phone: string }
	readonly language: 'ru'
	readonly rooms: ReadonlyArray<{
		readonly guests: ReadonlyArray<{
			readonly first_name: string
			readonly last_name: string
			readonly is_child?: boolean
			readonly age?: number
		}>
	}>
	readonly payment_type: {
		readonly type: 'now'
		readonly amount: string
		readonly currency_code: 'RUB'
	}
}

export interface OstrovokFinishOkResponse {
	readonly status: 'ok'
	readonly data: null
	readonly debug: null
	readonly error: null
}

export interface OstrovokStatusOkResponse {
	readonly status: 'ok'
	readonly data: null
	readonly debug: null
	readonly error: null
}

export interface OstrovokCancelOkResponse {
	readonly status: 'ok'
	readonly data: {
		readonly amount_payable: {
			readonly amount: string
			readonly currency_code: 'RUB'
		}
		readonly amount_refunded: {
			readonly amount: string
			readonly currency_code: 'RUB'
		}
		readonly amount_sell: {
			readonly amount: string
			readonly currency_code: 'RUB'
		}
		readonly amount_info: { readonly currency_code: 'RUB' }
		readonly cancellation_state: 'cancelled' | 'already_cancelled'
	}
	readonly debug: null
	readonly error: null
}

export interface OstrovokErrorEnvelope {
	readonly status: 'error'
	readonly error: string
}

export class OstrovokApiError extends Error {
	readonly code: string
	readonly httpStatus: number
	constructor(code: string, httpStatus: number) {
		super(`Ostrovok API error: ${code} (HTTP ${httpStatus})`)
		this.name = 'OstrovokApiError'
		this.code = code
		this.httpStatus = httpStatus
	}
}

export interface OstrovokClientOptions {
	readonly fetchImpl?: typeof fetch
	readonly baseUrl?: string
}

async function postJson<TReq, TOk>(
	endpoint: string,
	body: TReq,
	opts: OstrovokClientOptions,
): Promise<TOk> {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch
	const base = opts.baseUrl ?? BASE
	const res = await fetchImpl(`${base}${endpoint}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			Authorization: AUTH_HEADER,
		},
		body: JSON.stringify(body),
	})
	const json = (await res.json()) as TOk | OstrovokErrorEnvelope
	if (!res.ok || (json as OstrovokErrorEnvelope).status === 'error') {
		const code = (json as OstrovokErrorEnvelope).error ?? `http_${res.status}`
		throw new OstrovokApiError(code, res.status)
	}
	return json as TOk
}

/**
 * Stage 1 — POST /search/hp/. Returns the demo hotel + rate offers when
 * `hid === SANDBOX_DEMO_HID` (8473727); other hids → empty hotels array.
 */
export function searchHotel(
	req: OstrovokSearchRequest,
	opts: OstrovokClientOptions = {},
): Promise<OstrovokSearchOkResponse> {
	return postJson<OstrovokSearchRequest, OstrovokSearchOkResponse>('/search/hp/', req, opts)
}

/**
 * Stage 2 — POST /hotel/order/booking/form/. Client MUST pass a
 * `partner_order_id` already in UUIDv4 shape — generate via
 * `crypto.randomUUID()` before calling. Backend rejects non-UUIDv4 with
 * `invalid_partner_order_id`.
 */
export function prebookForm(
	req: OstrovokFormRequest,
	opts: OstrovokClientOptions = {},
): Promise<OstrovokFormOkResponse> {
	return postJson<OstrovokFormRequest, OstrovokFormOkResponse>(
		'/hotel/order/booking/form/',
		req,
		opts,
	)
}

/**
 * Stage 3 — POST /hotel/order/booking/finish/. Fires the webhook back to
 * our own channel inbox (`/api/channel/webhooks/ETG`) on success — so the
 * PMS side-by-side view will see a fresh reservation row.
 */
export function finishBooking(
	req: OstrovokFinishRequest,
	opts: OstrovokClientOptions = {},
): Promise<OstrovokFinishOkResponse> {
	return postJson<OstrovokFinishRequest, OstrovokFinishOkResponse>(
		'/hotel/order/booking/finish/',
		req,
		opts,
	)
}

/**
 * Stage 4 — POST /hotel/order/booking/finish/status/. Demo simplification:
 * backend always returns `ok` immediately if the booking exists. Real ETG
 * would 'processing' first then 'ok' on a later poll.
 */
export function pollFinishStatus(
	partnerOrderId: string,
	opts: OstrovokClientOptions = {},
): Promise<OstrovokStatusOkResponse> {
	return postJson<{ partner_order_id: string }, OstrovokStatusOkResponse>(
		'/hotel/order/booking/finish/status/',
		{ partner_order_id: partnerOrderId },
		opts,
	)
}

/**
 * Stage 5 — POST /hotel/order/cancel/. Fires a `cancelled` webhook back to
 * the inbox on the first transition; idempotent on subsequent calls
 * (`cancellation_state: 'already_cancelled'`).
 */
export function cancelBooking(
	partnerOrderId: string,
	opts: OstrovokClientOptions = {},
): Promise<OstrovokCancelOkResponse> {
	return postJson<{ partner_order_id: string }, OstrovokCancelOkResponse>(
		'/hotel/order/cancel/',
		{ partner_order_id: partnerOrderId },
		opts,
	)
}

/**
 * Canonical sandbox demo hotel id mirroring the backend constant
 * `SANDBOX_DEMO_HID = 8473727`. UI defaults all property links to this id.
 */
export const SANDBOX_DEMO_HID = 8473727
