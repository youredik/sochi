/**
 * Yandex.Путешествия mock-OTA state store — interface + in-memory impl.
 *
 * Round 14.5 re-do — replaces module-scoped `Map<>` from `state.ts` with
 * DI Store pattern. See `_demo/mock-ota-server/ostrovok/store.ts` for the
 * full architectural justification — both channels follow the same
 * pattern с per-channel data shapes.
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

export interface StoreBookingTokenInput {
	readonly token: string
	readonly hotelId: string
	readonly checkinDate: string
	readonly checkoutDate: string
	readonly adults: number
	readonly children: number
	readonly totalPriceMicros: bigint
	readonly nowMs?: number
}

export type CancelOutcome = 'cancelled' | 'already_cancelled' | 'not_found'

export interface YandexStore {
	storeBookingToken(input: StoreBookingTokenInput): Promise<void>
	getBookingToken(token: string, nowMs?: number): Promise<BookingTokenContext | null>
	consumeBookingToken(token: string, nowMs?: number): Promise<BookingTokenContext | null>
	storeOrder(order: MockOtaOrder): Promise<void>
	getOrder(orderId: string): Promise<MockOtaOrder | null>
	cancelOrder(orderId: string): Promise<CancelOutcome>

	// Test / admin helpers.
	__reset(): Promise<void>
	__listBookingTokens(): Promise<ReadonlyArray<{ token: string; context: BookingTokenContext }>>
	__listOrders(): Promise<ReadonlyArray<MockOtaOrder>>
}

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
 * In-memory implementation — preserves Phase-1 behaviour. Used by unit
 * tests + single-instance dev environments.
 */
export function createInMemoryYandexStore(): YandexStore {
	const bookingTokens = new Map<string, BookingTokenContext>()
	const orders = new Map<string, MockOtaOrder>()

	return {
		async storeBookingToken(input) {
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
		},

		async getBookingToken(token, nowMs) {
			const ctx = bookingTokens.get(token)
			if (ctx === undefined) return null
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) {
				bookingTokens.delete(token)
				return null
			}
			return ctx
		},

		async consumeBookingToken(token, nowMs) {
			const ctx = await this.getBookingToken(token, nowMs)
			if (ctx === null) return null
			bookingTokens.delete(token)
			return ctx
		},

		async storeOrder(order) {
			orders.set(order.orderId, order)
		},

		async getOrder(orderId) {
			return orders.get(orderId) ?? null
		},

		async cancelOrder(orderId) {
			const existing = orders.get(orderId)
			if (existing === undefined) return 'not_found'
			if (existing.status === 'CANCELLED') return 'already_cancelled'
			orders.set(orderId, { ...existing, status: 'CANCELLED' })
			return 'cancelled'
		},

		async __reset() {
			bookingTokens.clear()
			orders.clear()
		},

		async __listBookingTokens() {
			return Array.from(bookingTokens.entries()).map(([token, context]) => ({
				token,
				context,
			}))
		},

		async __listOrders() {
			return Array.from(orders.values())
		},
	}
}
