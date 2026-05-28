/**
 * Yandex.Путешествия mock-OTA state store — multi-tenant interface.
 *
 * Round 14.6 strategic refactor — store methods accept `tenantId` per call
 * (was: tenantId baked at store creation). Single store instance shared
 * across tenants; isolation via WHERE clause filter on tenantId. Matches
 * canonical multi-tenant repository pattern (idempotency.repo.ts).
 *
 * Canon refs:
 *   - `feedback_no_halfway` (user trigger «без полумер»)
 *   - Stripe livemode 2026 (web research 28.05.2026 confirms canonical)
 */

import { randomBytes, randomUUID } from 'node:crypto'

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export interface BookingTokenContext {
	readonly hotelId: string
	readonly checkinDate: string
	readonly checkoutDate: string
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
	storeBookingToken(tenantId: string, input: StoreBookingTokenInput): Promise<void>
	getBookingToken(
		tenantId: string,
		token: string,
		nowMs?: number,
	): Promise<BookingTokenContext | null>
	consumeBookingToken(
		tenantId: string,
		token: string,
		nowMs?: number,
	): Promise<BookingTokenContext | null>
	storeOrder(tenantId: string, order: MockOtaOrder): Promise<void>
	getOrder(tenantId: string, orderId: string): Promise<MockOtaOrder | null>
	cancelOrder(tenantId: string, orderId: string): Promise<CancelOutcome>

	__reset(tenantId: string): Promise<void>
	__listBookingTokens(
		tenantId: string,
	): Promise<ReadonlyArray<{ token: string; context: BookingTokenContext }>>
	__listOrders(tenantId: string): Promise<ReadonlyArray<MockOtaOrder>>
}

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

export function createInMemoryYandexStore(): YandexStore {
	type TenantState = {
		bookingTokens: Map<string, BookingTokenContext>
		orders: Map<string, MockOtaOrder>
	}
	const tenants = new Map<string, TenantState>()

	function tenantState(tenantId: string): TenantState {
		let s = tenants.get(tenantId)
		if (!s) {
			s = { bookingTokens: new Map(), orders: new Map() }
			tenants.set(tenantId, s)
		}
		return s
	}

	return {
		async storeBookingToken(tenantId, input) {
			const now = input.nowMs ?? Date.now()
			tenantState(tenantId).bookingTokens.set(input.token, {
				hotelId: input.hotelId,
				checkinDate: input.checkinDate,
				checkoutDate: input.checkoutDate,
				adults: input.adults,
				children: input.children,
				totalPriceMicros: input.totalPriceMicros,
				expiresAtMs: now + TOKEN_TTL_MS,
			})
		},

		async getBookingToken(tenantId, token, nowMs) {
			const s = tenantState(tenantId)
			const ctx = s.bookingTokens.get(token)
			if (ctx === undefined) return null
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) {
				s.bookingTokens.delete(token)
				return null
			}
			return ctx
		},

		async consumeBookingToken(tenantId, token, nowMs) {
			const ctx = await this.getBookingToken(tenantId, token, nowMs)
			if (ctx === null) return null
			tenantState(tenantId).bookingTokens.delete(token)
			return ctx
		},

		async storeOrder(tenantId, order) {
			tenantState(tenantId).orders.set(order.orderId, order)
		},

		async getOrder(tenantId, orderId) {
			return tenantState(tenantId).orders.get(orderId) ?? null
		},

		async cancelOrder(tenantId, orderId) {
			const s = tenantState(tenantId)
			const existing = s.orders.get(orderId)
			if (existing === undefined) return 'not_found'
			if (existing.status === 'CANCELLED') return 'already_cancelled'
			s.orders.set(orderId, { ...existing, status: 'CANCELLED' })
			return 'cancelled'
		},

		async __reset(tenantId) {
			const s = tenants.get(tenantId)
			if (s) {
				s.bookingTokens.clear()
				s.orders.clear()
			}
		},

		async __listBookingTokens(tenantId) {
			const s = tenants.get(tenantId)
			if (!s) return []
			return Array.from(s.bookingTokens.entries()).map(([token, context]) => ({ token, context }))
		},

		async __listOrders(tenantId) {
			const s = tenants.get(tenantId)
			if (!s) return []
			return Array.from(s.orders.values())
		},
	}
}
