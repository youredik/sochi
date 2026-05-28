/**
 * Yandex.Путешествия mock-OTA state store — YDB implementation.
 *
 * Closes multi-instance race (Round 14.5 re-do). See sibling
 * `ostrovok/store.ydb.ts` для full architecture canon — identical pattern,
 * Yandex shapes (booking_token + order map only, no 5-stage prebook FSM).
 *
 * Schema: migration `0080_mock_ota_state_tables.sql` creates
 *   - `mockOtaYandexBookingToken` (P1D TTL on expiresAt)
 *   - `mockOtaYandexOrder`        (P7D TTL on createdAt)
 */

import type { query } from '@ydbjs/query'
import { toJson, toTs } from '../../../../db/ydb-helpers.ts'
import type {
	BookingTokenContext,
	CancelOutcome,
	MockOtaOrder,
	StoreBookingTokenInput,
	YandexStore,
} from './store.ts'

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export function createYdbYandexStore(
	sql: ReturnType<typeof query>,
	opts: { tenantId: string },
): YandexStore {
	const { tenantId } = opts

	return {
		async storeBookingToken(input: StoreBookingTokenInput): Promise<void> {
			const now = input.nowMs ?? Date.now()
			const expiresAtMs = now + TOKEN_TTL_MS
			const ctx: BookingTokenContext = {
				hotelId: input.hotelId,
				checkinDate: input.checkinDate,
				checkoutDate: input.checkoutDate,
				adults: input.adults,
				children: input.children,
				totalPriceMicros: input.totalPriceMicros,
				expiresAtMs,
			}
			await sql`
				UPSERT INTO mockOtaYandexBookingToken (tenantId, bookingToken, contextJson, expiresAt, createdAt)
				VALUES (${tenantId}, ${input.token}, ${toJson(ctx)}, ${toTs(new Date(expiresAtMs))}, ${toTs(new Date(now))})
			`
		},

		async getBookingToken(token: string, nowMs?: number): Promise<BookingTokenContext | null> {
			const now = nowMs ?? Date.now()
			const [rows = []] = await sql<{ contextJson: unknown }[]>`
				SELECT contextJson
				FROM mockOtaYandexBookingToken
				WHERE tenantId = ${tenantId}
				  AND bookingToken = ${token}
				  AND expiresAt > ${toTs(new Date(now))}
			`
			const row = rows[0]
			if (!row || row.contextJson == null) return null
			const parsed = row.contextJson as BookingTokenContext
			// JSON.parse turns bigint serialized as string back to string; restore
			// `totalPriceMicros` to bigint per BookingTokenContext shape.
			return {
				...parsed,
				totalPriceMicros: BigInt(parsed.totalPriceMicros as unknown as string),
			}
		},

		async consumeBookingToken(token: string, nowMs?: number): Promise<BookingTokenContext | null> {
			const ctx = await this.getBookingToken(token, nowMs)
			if (ctx === null) return null
			await sql`
				DELETE FROM mockOtaYandexBookingToken
				WHERE tenantId = ${tenantId} AND bookingToken = ${token}
			`
			return ctx
		},

		async storeOrder(order: MockOtaOrder): Promise<void> {
			await sql`
				UPSERT INTO mockOtaYandexOrder (tenantId, orderId, orderJson, status, createdAt)
				VALUES (${tenantId}, ${order.orderId}, ${toJson(order)}, ${order.status}, ${toTs(new Date(order.createdAtMs))})
			`
		},

		async getOrder(orderId: string): Promise<MockOtaOrder | null> {
			const [rows = []] = await sql<{ orderJson: unknown }[]>`
				SELECT orderJson
				FROM mockOtaYandexOrder
				WHERE tenantId = ${tenantId}
				  AND orderId = ${orderId}
			`
			const row = rows[0]
			if (!row || row.orderJson == null) return null
			return row.orderJson as MockOtaOrder
		},

		async cancelOrder(orderId: string): Promise<CancelOutcome> {
			const [rows = []] = await sql<{ orderJson: unknown; status: string }[]>`
				SELECT orderJson, status
				FROM mockOtaYandexOrder
				WHERE tenantId = ${tenantId}
				  AND orderId = ${orderId}
			`
			const row = rows[0]
			if (!row || row.orderJson == null) return 'not_found'
			if (row.status === 'CANCELLED') return 'already_cancelled'
			const existing = row.orderJson as MockOtaOrder
			const updated: MockOtaOrder = { ...existing, status: 'CANCELLED' }
			await sql`
				UPSERT INTO mockOtaYandexOrder (tenantId, orderId, orderJson, status, createdAt)
				VALUES (${tenantId}, ${orderId}, ${toJson(updated)}, 'CANCELLED', ${toTs(new Date(existing.createdAtMs))})
			`
			return 'cancelled'
		},

		async __reset(): Promise<void> {
			await sql`DELETE FROM mockOtaYandexBookingToken WHERE tenantId = ${tenantId}`
			await sql`DELETE FROM mockOtaYandexOrder WHERE tenantId = ${tenantId}`
		},

		async __listBookingTokens() {
			const [rows = []] = await sql<{ bookingToken: string; contextJson: unknown }[]>`
				SELECT bookingToken, contextJson
				FROM mockOtaYandexBookingToken
				WHERE tenantId = ${tenantId}
			`
			return rows
				.filter((r) => r.contextJson != null)
				.map((r) => {
					const ctx = r.contextJson as BookingTokenContext
					return {
						token: r.bookingToken,
						context: {
							...ctx,
							totalPriceMicros: BigInt(ctx.totalPriceMicros as unknown as string),
						},
					}
				})
		},

		async __listOrders() {
			const [rows = []] = await sql<{ orderJson: unknown }[]>`
				SELECT orderJson
				FROM mockOtaYandexOrder
				WHERE tenantId = ${tenantId}
			`
			return rows.filter((r) => r.orderJson != null).map((r) => r.orderJson as MockOtaOrder)
		},
	}
}
