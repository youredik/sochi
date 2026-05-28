/**
 * Yandex.Путешествия mock-OTA state store — YDB implementation, multi-tenant.
 *
 * Round 14.6 — store is tenant-agnostic. `tenantId` passed per method call.
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

export function createYdbYandexStore(sql: ReturnType<typeof query>): YandexStore {
	return {
		async storeBookingToken(tenantId, input: StoreBookingTokenInput) {
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

		async getBookingToken(tenantId, token, nowMs) {
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
			return {
				...parsed,
				totalPriceMicros: BigInt(parsed.totalPriceMicros as unknown as string),
			}
		},

		async consumeBookingToken(tenantId, token, nowMs) {
			const ctx = await this.getBookingToken(tenantId, token, nowMs)
			if (ctx === null) return null
			await sql`
				DELETE FROM mockOtaYandexBookingToken
				WHERE tenantId = ${tenantId} AND bookingToken = ${token}
			`
			return ctx
		},

		async storeOrder(tenantId, order: MockOtaOrder) {
			await sql`
				UPSERT INTO mockOtaYandexOrder (tenantId, orderId, orderJson, status, createdAt)
				VALUES (${tenantId}, ${order.orderId}, ${toJson(order)}, ${order.status}, ${toTs(new Date(order.createdAtMs))})
			`
		},

		async getOrder(tenantId, orderId) {
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

		async cancelOrder(tenantId, orderId): Promise<CancelOutcome> {
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

		async __reset(tenantId) {
			await sql`DELETE FROM mockOtaYandexBookingToken WHERE tenantId = ${tenantId}`
			await sql`DELETE FROM mockOtaYandexOrder WHERE tenantId = ${tenantId}`
		},

		async __listBookingTokens(tenantId) {
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

		async __listOrders(tenantId) {
			const [rows = []] = await sql<{ orderJson: unknown }[]>`
				SELECT orderJson
				FROM mockOtaYandexOrder
				WHERE tenantId = ${tenantId}
			`
			return rows.filter((r) => r.orderJson != null).map((r) => r.orderJson as MockOtaOrder)
		},
	}
}
