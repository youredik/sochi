/**
 * Round 14 self-review #6 — state store for the Round 9 Yandex.Путешествия
 * mock-OTA HTTP server. **YDB-backed primary state** (canon
 * `feedback_p1_means_now_not_later`).
 *
 * History:
 *   - Round 9 → in-memory `Map<string, Context>`
 *   - Round 14 self-review #6 (2026-05-27): user trigger «точно уверен?» caught
 *     Run #112+#114 R12-11 + YT-SMOKE flakiness empirically — multi-instance
 *     state divergence. Promoted к YDB-backed primary state с migration 0080.
 *
 * Two tables (TTL P1D enforced natively):
 *   - `mockOtaYandexBookingToken` — search → booking_token
 *   - `mockOtaYandexOrder`        — order creation → order
 *
 * **Store interface** (canonical pattern, mirrors `DcrStore` + `OstrovokStore`):
 *   - `createInMemoryYandexStore()` — for unit tests
 *   - `createYdbYandexStore(sql)`   — for production / integration tests
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { sql as SQL } from '../../../../db/index.ts'
import { toJson } from '../../../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const DEMO_TENANT = 'demo-tenant'

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

export interface YandexStore {
	storeBookingToken(input: StoreBookingTokenInput): Promise<void>
	getBookingToken(token: string, nowMs?: number): Promise<BookingTokenContext | null>
	consumeBookingToken(token: string, nowMs?: number): Promise<BookingTokenContext | null>
	storeOrder(order: MockOtaOrder): Promise<void>
	getOrder(orderId: string): Promise<MockOtaOrder | null>
	cancelOrder(orderId: string): Promise<'cancelled' | 'already_cancelled' | 'not_found'>
	__reset(): Promise<void>
	__listBookingTokens(): Promise<ReadonlyArray<{ token: string; context: BookingTokenContext }>>
	__listOrders(): Promise<ReadonlyArray<MockOtaOrder>>
}

/**
 * Generate a 12-char alphanumeric booking token, mirroring observed
 * Yandex.Путешествия `booking_token` shape.
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

// ─────────────────────────────────────────────────────────────────────────
// In-memory implementation (unit tests)
// ─────────────────────────────────────────────────────────────────────────

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
			const ctx = bookingTokens.get(token)
			if (ctx === undefined) return null
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) {
				bookingTokens.delete(token)
				return null
			}
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
			return Array.from(bookingTokens.entries()).map(([token, context]) => ({ token, context }))
		},
		async __listOrders() {
			return Array.from(orders.values())
		},
	}
}

// ─────────────────────────────────────────────────────────────────────────
// YDB implementation
// ─────────────────────────────────────────────────────────────────────────

interface YdbBookingTokenRow {
	token: string
	hotelId: string
	checkinDate: string
	checkoutDate: string
	adults: number
	childrenCount: number
	totalPriceMicros: number | bigint
	issuedAt: Date
	expiresAt: Date
}

interface YdbOrderRow {
	orderId: string
	bookingToken: string
	customerEmail: string
	customerPhone: string
	status: string
	externalReservationId: string
	guestsJson: string | unknown
	createdAt: Date
}

function parseYdbJson<T>(value: unknown): T {
	if (typeof value === 'string') return JSON.parse(value) as T
	return value as T
}

function rowToBookingTokenContext(row: YdbBookingTokenRow): BookingTokenContext {
	return {
		hotelId: row.hotelId,
		checkinDate: row.checkinDate,
		checkoutDate: row.checkoutDate,
		adults: row.adults,
		children: row.childrenCount,
		totalPriceMicros:
			typeof row.totalPriceMicros === 'bigint'
				? row.totalPriceMicros
				: BigInt(row.totalPriceMicros),
		expiresAtMs: row.expiresAt.getTime(),
	}
}

function rowToOrder(row: YdbOrderRow): MockOtaOrder {
	return {
		orderId: row.orderId,
		bookingToken: row.bookingToken,
		customerEmail: row.customerEmail,
		customerPhone: row.customerPhone,
		status: row.status as 'CONFIRMED' | 'CANCELLED',
		externalReservationId: row.externalReservationId,
		guests: parseYdbJson<MockOtaOrder['guests']>(row.guestsJson),
		createdAtMs: row.createdAt.getTime(),
	}
}

export function createYdbYandexStore(sql: SqlInstance): YandexStore {
	return {
		async storeBookingToken(input) {
			const now = input.nowMs ?? Date.now()
			const issuedAt = new Date(now)
			const expiresAt = new Date(now + TOKEN_TTL_MS)
			await sql`
				UPSERT INTO mockOtaYandexBookingToken (
					\`tenantId\`, \`token\`, \`hotelId\`, \`checkinDate\`, \`checkoutDate\`,
					\`adults\`, \`childrenCount\`, \`totalPriceMicros\`, \`issuedAt\`, \`expiresAt\`
				) VALUES (
					${DEMO_TENANT}, ${input.token}, ${input.hotelId}, ${input.checkinDate}, ${input.checkoutDate},
					${input.adults}, ${input.children}, ${input.totalPriceMicros}, ${issuedAt}, ${expiresAt}
				)
			`
		},
		async getBookingToken(token, nowMs) {
			const [rows = []] = await sql<YdbBookingTokenRow[]>`
				SELECT token, hotelId, checkinDate, checkoutDate, adults, childrenCount,
					totalPriceMicros, issuedAt, expiresAt
				FROM mockOtaYandexBookingToken
				WHERE tenantId = ${DEMO_TENANT} AND token = ${token}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (row === undefined) return null
			const ctx = rowToBookingTokenContext(row)
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) return null
			return ctx
		},
		async consumeBookingToken(token, nowMs) {
			const ctx = await this.getBookingToken(token, nowMs)
			if (ctx === null) return null
			// Single-use semantic — delete after read.
			await sql`
				DELETE FROM mockOtaYandexBookingToken
				WHERE tenantId = ${DEMO_TENANT} AND token = ${token}
			`
			return ctx
		},
		async storeOrder(order) {
			const createdAt = new Date(order.createdAtMs)
			await sql`
				UPSERT INTO mockOtaYandexOrder (
					\`tenantId\`, \`orderId\`, \`bookingToken\`, \`customerEmail\`, \`customerPhone\`,
					\`status\`, \`externalReservationId\`, \`guestsJson\`, \`createdAt\`
				) VALUES (
					${DEMO_TENANT}, ${order.orderId}, ${order.bookingToken}, ${order.customerEmail},
					${order.customerPhone}, ${order.status}, ${order.externalReservationId},
					${toJson(order.guests)}, ${createdAt}
				)
			`
		},
		async getOrder(orderId) {
			const [rows = []] = await sql<YdbOrderRow[]>`
				SELECT orderId, bookingToken, customerEmail, customerPhone, status,
					externalReservationId, guestsJson, createdAt
				FROM mockOtaYandexOrder
				WHERE tenantId = ${DEMO_TENANT} AND orderId = ${orderId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (row === undefined) return null
			return rowToOrder(row)
		},
		async cancelOrder(orderId) {
			const order = await this.getOrder(orderId)
			if (order === null) return 'not_found'
			if (order.status === 'CANCELLED') return 'already_cancelled'
			await sql`
				UPDATE mockOtaYandexOrder
				SET \`status\` = ${'CANCELLED'}
				WHERE tenantId = ${DEMO_TENANT} AND orderId = ${orderId}
			`
			return 'cancelled'
		},
		async __reset() {
			await sql`DELETE FROM mockOtaYandexBookingToken WHERE tenantId = ${DEMO_TENANT}`
			await sql`DELETE FROM mockOtaYandexOrder WHERE tenantId = ${DEMO_TENANT}`
		},
		async __listBookingTokens() {
			const [rows = []] = await sql<YdbBookingTokenRow[]>`
				SELECT token, hotelId, checkinDate, checkoutDate, adults, childrenCount,
					totalPriceMicros, issuedAt, expiresAt
				FROM mockOtaYandexBookingToken
				WHERE tenantId = ${DEMO_TENANT}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map((r) => ({ token: r.token, context: rowToBookingTokenContext(r) }))
		},
		async __listOrders() {
			const [rows = []] = await sql<YdbOrderRow[]>`
				SELECT orderId, bookingToken, customerEmail, customerPhone, status,
					externalReservationId, guestsJson, createdAt
				FROM mockOtaYandexOrder
				WHERE tenantId = ${DEMO_TENANT}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToOrder)
		},
	}
}
