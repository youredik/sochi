/**
 * Ostrovok / ETG mock-OTA state store — YDB implementation, multi-tenant.
 *
 * Round 14.6 — store is tenant-agnostic. `tenantId` passed per method call
 * by route handlers (from `c.var.tenantId`).
 *
 * Schema: migration `0080_mock_ota_state_tables.sql`.
 */

import type { query } from '@ydbjs/query'
import { toJson, toTs } from '../../../../db/ydb-helpers.ts'
import type {
	BookHashContext,
	CancelOutcome,
	FinalizeBookingInput,
	FinalizedBooking,
	FormStageContext,
	OstrovokStore,
	StoreBookHashInput,
	StoreFormStageInput,
} from './store.ts'

const BOOK_HASH_TTL_MS = 24 * 60 * 60 * 1000
const FORM_STAGE_TTL_MS = 60 * 60 * 1000

export function createYdbOstrovokStore(sql: ReturnType<typeof query>): OstrovokStore {
	return {
		async storeBookHash(tenantId, input: StoreBookHashInput) {
			const now = input.nowMs ?? Date.now()
			const expiresAtMs = now + BOOK_HASH_TTL_MS
			const ctx: BookHashContext = {
				hid: input.hid,
				checkin: input.checkin,
				checkout: input.checkout,
				adults: input.adults,
				children: input.children,
				currency: input.currency,
				dailyPrices: input.dailyPrices,
				totalPrice: input.totalPrice,
				roomName: input.roomName,
				mealName: input.mealName,
				issuedAtMs: now,
				expiresAtMs,
			}
			await sql`
				UPSERT INTO mockOtaOstrovokBookHash (tenantId, bookHash, contextJson, expiresAt, createdAt)
				VALUES (${tenantId}, ${input.bookHash}, ${toJson(ctx)}, ${toTs(new Date(expiresAtMs))}, ${toTs(new Date(now))})
			`
		},

		async getBookHash(tenantId, bookHash, nowMs) {
			const now = nowMs ?? Date.now()
			const [rows = []] = await sql<{ contextJson: unknown }[]>`
				SELECT contextJson
				FROM mockOtaOstrovokBookHash
				WHERE tenantId = ${tenantId}
				  AND bookHash = ${bookHash}
				  AND expiresAt > ${toTs(new Date(now))}
			`
			const row = rows[0]
			if (!row || row.contextJson == null) return null
			return row.contextJson as BookHashContext
		},

		async storeFormStage(tenantId, input: StoreFormStageInput) {
			const now = input.nowMs ?? Date.now()
			const expiresAtMs = now + FORM_STAGE_TTL_MS
			const ctx: FormStageContext = {
				partnerOrderId: input.partnerOrderId,
				bookHash: input.bookHash,
				orderId: input.orderId,
				itemId: input.itemId,
				currency: input.currency,
				totalAmount: input.totalAmount,
				createdAtMs: now,
				expiresAtMs,
			}
			await sql`
				UPSERT INTO mockOtaOstrovokFormStage (tenantId, partnerOrderId, contextJson, expiresAt, createdAt)
				VALUES (${tenantId}, ${input.partnerOrderId}, ${toJson(ctx)}, ${toTs(new Date(expiresAtMs))}, ${toTs(new Date(now))})
			`
		},

		async getFormStage(tenantId, partnerOrderId, nowMs) {
			const now = nowMs ?? Date.now()
			const [rows = []] = await sql<{ contextJson: unknown }[]>`
				SELECT contextJson
				FROM mockOtaOstrovokFormStage
				WHERE tenantId = ${tenantId}
				  AND partnerOrderId = ${partnerOrderId}
				  AND expiresAt > ${toTs(new Date(now))}
			`
			const row = rows[0]
			if (!row || row.contextJson == null) return null
			return row.contextJson as FormStageContext
		},

		async finalizeBooking(tenantId, input: FinalizeBookingInput) {
			const now = input.nowMs ?? Date.now()
			const finalized: FinalizedBooking = {
				partnerOrderId: input.form.partnerOrderId,
				orderId: input.form.orderId,
				itemId: input.form.itemId,
				hid: input.bookHashContext.hid,
				checkin: input.bookHashContext.checkin,
				checkout: input.bookHashContext.checkout,
				adults: input.bookHashContext.adults,
				children: input.bookHashContext.children,
				currency: input.form.currency,
				totalAmount: input.form.totalAmount,
				status: 'confirmed',
				customerEmail: input.customerEmail,
				customerPhone: input.customerPhone,
				guests: input.guests,
				createdAtMs: now,
			}
			await sql`
				UPSERT INTO mockOtaOstrovokBooking (tenantId, partnerOrderId, bookingJson, status, createdAt)
				VALUES (${tenantId}, ${input.form.partnerOrderId}, ${toJson(finalized)}, ${finalized.status}, ${toTs(new Date(now))})
			`
			await sql`
				DELETE FROM mockOtaOstrovokFormStage
				WHERE tenantId = ${tenantId} AND partnerOrderId = ${input.form.partnerOrderId}
			`
			return finalized
		},

		async getBooking(tenantId, partnerOrderId) {
			const [rows = []] = await sql<{ bookingJson: unknown }[]>`
				SELECT bookingJson
				FROM mockOtaOstrovokBooking
				WHERE tenantId = ${tenantId}
				  AND partnerOrderId = ${partnerOrderId}
			`
			const row = rows[0]
			if (!row || row.bookingJson == null) return null
			return row.bookingJson as FinalizedBooking
		},

		async cancelBooking(tenantId, partnerOrderId): Promise<CancelOutcome> {
			const [rows = []] = await sql<{ bookingJson: unknown; status: string }[]>`
				SELECT bookingJson, status
				FROM mockOtaOstrovokBooking
				WHERE tenantId = ${tenantId}
				  AND partnerOrderId = ${partnerOrderId}
			`
			const row = rows[0]
			if (!row || row.bookingJson == null) return 'not_found'
			if (row.status === 'cancelled') return 'already_cancelled'
			const existing = row.bookingJson as FinalizedBooking
			const updated: FinalizedBooking = { ...existing, status: 'cancelled' }
			await sql`
				UPSERT INTO mockOtaOstrovokBooking (tenantId, partnerOrderId, bookingJson, status, createdAt)
				VALUES (${tenantId}, ${partnerOrderId}, ${toJson(updated)}, 'cancelled', ${toTs(new Date(existing.createdAtMs))})
			`
			return 'cancelled'
		},

		async __reset(tenantId) {
			await sql`DELETE FROM mockOtaOstrovokBookHash WHERE tenantId = ${tenantId}`
			await sql`DELETE FROM mockOtaOstrovokFormStage WHERE tenantId = ${tenantId}`
			await sql`DELETE FROM mockOtaOstrovokBooking WHERE tenantId = ${tenantId}`
		},

		async __listBookHashes(tenantId) {
			const [rows = []] = await sql<{ bookHash: string; contextJson: unknown }[]>`
				SELECT bookHash, contextJson
				FROM mockOtaOstrovokBookHash
				WHERE tenantId = ${tenantId}
			`
			return rows
				.filter((r) => r.contextJson != null)
				.map((r) => ({ bookHash: r.bookHash, context: r.contextJson as BookHashContext }))
		},

		async __listFormStages(tenantId) {
			const [rows = []] = await sql<{ contextJson: unknown }[]>`
				SELECT contextJson
				FROM mockOtaOstrovokFormStage
				WHERE tenantId = ${tenantId}
			`
			return rows.filter((r) => r.contextJson != null).map((r) => r.contextJson as FormStageContext)
		},

		async __listBookings(tenantId) {
			const [rows = []] = await sql<{ bookingJson: unknown }[]>`
				SELECT bookingJson
				FROM mockOtaOstrovokBooking
				WHERE tenantId = ${tenantId}
			`
			return rows.filter((r) => r.bookingJson != null).map((r) => r.bookingJson as FinalizedBooking)
		},
	}
}
