/**
 * In-memory state for the Round 9 Yandex.Путешествия mock-OTA HTTP server.
 *
 * Holds two ephemeral maps:
 *   - `bookingTokens` — issued by `GET /hotels/hotel/offers` and consumed by
 *     `POST /hotels/booking/orders`. Each token carries the search context
 *     (hotelId, date range, party size) so order creation can validate that
 *     guest fields match what was quoted.
 *   - `orders` — created via `POST /hotels/booking/orders`, mutated via
 *     `POST /hotels/booking/orders/{order_id}/payment/cancel`. The status
 *     transitions `CONFIRMED → CANCELLED` are one-way; a second cancel returns
 *     `already_cancelled` to the route handler so it can echo idempotent shape.
 *
 * Token / order IDs follow real Yandex.Путешествия shape:
 *   - `booking_token` — 12 char [A-Za-z0-9] (mirrors observed real-API tokens).
 *   - `order_id` — `yt-order-{12-hex}` (own prefix; real Yandex uses opaque
 *     uuid-like — we keep human-readable for demo log clarity).
 *
 * TTL: tokens expire after 24h walltime (`expiresAt` field). Sweep is lazy —
 * on `consumeBookingToken` we check expiry and reject if past. No background
 * cron — the demo state pool is small and the wrap process restarts daily on
 * deploy anyway. Phase 2 — move to `mockOtaReservation_demo` YDB table with
 * 24h native TTL per `feedback_native_yc_services_first_canon_2026_05_24`.
 *
 * **Reset**: `__resetState()` clears both maps. Called by the admin reset
 * endpoint (Batch 3) and by `beforeEach` in tests for isolation.
 */

import { randomBytes, randomUUID } from 'node:crypto'

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export interface BookingTokenContext {
	readonly hotelId: string
	readonly checkinDate: string // YYYY-MM-DD
	readonly checkoutDate: string // YYYY-MM-DD
	readonly adults: number
	readonly children: number
	readonly totalPriceMicros: bigint
	readonly expiresAtMs: number
}

export interface MockOtaOrder {
	readonly orderId: string
	readonly bookingToken: string
	readonly customerEmail: string
	readonly customerPhone: string
	readonly status: 'CONFIRMED' | 'CANCELLED'
	readonly externalReservationId: string
	readonly createdAtMs: number
	readonly guests: ReadonlyArray<{
		readonly firstName: string
		readonly lastName: string
		readonly isChild: boolean
		readonly age?: number
	}>
}

const bookingTokens = new Map<string, BookingTokenContext>()
const orders = new Map<string, MockOtaOrder>()

/**
 * Generate a 12-char alphanumeric booking token, mirroring observed
 * Yandex.Путешествия `booking_token` shape. Uses `randomBytes` to avoid
 * collisions across concurrent search requests.
 */
export function generateBookingToken(): string {
	const bytes = randomBytes(12)
	let out = ''
	for (let i = 0; i < 12; i++) {
		// biome-ignore lint/style/noNonNullAssertion: bytes length pinned 12.
		out += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length]
	}
	return out
}

export function generateOrderId(): string {
	return `yt-order-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * Store a freshly-minted booking token along with its search context.
 * Sets `expiresAtMs` based on optional `nowMs` injector (for test determinism).
 */
export function storeBookingToken(input: {
	token: string
	hotelId: string
	checkinDate: string
	checkoutDate: string
	adults: number
	children: number
	totalPriceMicros: bigint
	nowMs?: number
}): void {
	const now = input.nowMs ?? Date.now()
	bookingTokens.set(input.token, {
		hotelId: input.hotelId,
		checkinDate: input.checkinDate,
		checkoutDate: input.checkoutDate,
		adults: input.adults,
		children: input.children,
		totalPriceMicros: input.totalPriceMicros,
		expiresAtMs: now + TOKEN_TTL_MS,
	})
}

/**
 * Look up a previously-issued booking token. Returns the context if still
 * valid (not expired), null otherwise. Does NOT consume — callers that want
 * single-use semantics must call `consumeBookingToken` instead.
 */
export function getBookingToken(token: string, nowMs?: number): BookingTokenContext | null {
	const ctx = bookingTokens.get(token)
	if (ctx === undefined) return null
	const now = nowMs ?? Date.now()
	if (ctx.expiresAtMs < now) {
		bookingTokens.delete(token)
		return null
	}
	return ctx
}

/**
 * Single-use consume: returns the context if valid, then deletes the token.
 * Used by `POST /hotels/booking/orders` so the same token cannot create
 * multiple orders.
 */
export function consumeBookingToken(token: string, nowMs?: number): BookingTokenContext | null {
	const ctx = getBookingToken(token, nowMs)
	if (ctx === null) return null
	bookingTokens.delete(token)
	return ctx
}

/**
 * Persist a freshly-confirmed order. Caller is responsible for generating
 * the orderId (typically via `generateOrderId()`).
 */
export function storeOrder(order: MockOtaOrder): void {
	orders.set(order.orderId, order)
}

export function getOrder(orderId: string): MockOtaOrder | null {
	return orders.get(orderId) ?? null
}

/**
 * Mark an order as cancelled. Returns 'cancelled' on first call,
 * 'already_cancelled' on subsequent calls, 'not_found' if no such order.
 * Status mutation is monotonic — once CANCELLED, never returns to CONFIRMED.
 */
export function cancelOrder(orderId: string): 'cancelled' | 'already_cancelled' | 'not_found' {
	const existing = orders.get(orderId)
	if (existing === undefined) return 'not_found'
	if (existing.status === 'CANCELLED') return 'already_cancelled'
	orders.set(orderId, { ...existing, status: 'CANCELLED' })
	return 'cancelled'
}

/**
 * Test / admin reset helper. Drops every booking token + order. Called by
 * `beforeEach` in tests and by the admin `POST /api/_mock-ota/admin/reset`
 * endpoint (Batch 3). Production code paths must never call this.
 */
export function __resetState(): void {
	bookingTokens.clear()
	orders.clear()
}

/**
 * Read-only snapshot accessors for tests / admin panel introspection.
 * Not exposed via HTTP routes directly.
 */
export function __listBookingTokens(): ReadonlyArray<{
	readonly token: string
	readonly context: BookingTokenContext
}> {
	return Array.from(bookingTokens.entries()).map(([token, context]) => ({
		token,
		context,
	}))
}

export function __listOrders(): ReadonlyArray<MockOtaOrder> {
	return Array.from(orders.values())
}
