/**
 * Ostrovok / ETG mock-OTA state store — YDB implementation.
 *
 * Closes multi-instance race (Round 14.5 re-do). YC Serverless container
 * scale-out leaves per-instance Map state inconsistent; YDB-backed store
 * gives globally-consistent reads/writes.
 *
 * Schema: migration `0080_mock_ota_state_tables.sql` creates
 *   - `mockOtaOstrovokBookHash`    (P1D TTL on expiresAt)
 *   - `mockOtaOstrovokFormStage`   (PT1H TTL on expiresAt)
 *   - `mockOtaOstrovokBooking`     (P7D TTL on createdAt)
 *
 * TTL semantics: YDB native TTL DELETES rows after expiry, but sweep is
 * eventual. SELECT queries always include `WHERE expiresAt > $now` (or
 * status check для bookings) to surface only valid rows even if YDB
 * sweep hasn't run yet — canonical "lazy + native" pattern.
 *
 * Binding canon (per `project_ydb_specifics.md` items 9-11 + ydb-helpers):
 *   - `toJson(value)` — serializes any object as Json column payload
 *     (handles bigint by stringification)
 *   - `toTs(date)` — JS Date → YDB Timestamp (µs precision)
 *   - Bare `${string}` infers Utf8; bare `${bigint}` infers Int64; we
 *     don't use Optional<...> binds here because columns are NOT NULL
 *     except `contextJson` / `bookingJson` (Json type permits null
 *     server-side, but our codepath always provides non-null payload).
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

/**
 * Create a YDB-backed OstrovokStore. Scoped to a single tenantId — DI
 * wiring (см. `_demo/index.ts`) provides the demo tenant id from env.
 *
 * The SQL tagged-template `sql` is from `@ydbjs/query` — same instance
 * as production repos share via singleton in `apps/backend/src/db/index.ts`.
 */
export function createYdbOstrovokStore(
	sql: ReturnType<typeof query>,
	opts: { tenantId: string },
): OstrovokStore {
	const { tenantId } = opts

	return {
		async storeBookHash(input: StoreBookHashInput): Promise<void> {
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

		async getBookHash(bookHash: string, nowMs?: number): Promise<BookHashContext | null> {
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

		async storeFormStage(input: StoreFormStageInput): Promise<void> {
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

		async getFormStage(partnerOrderId: string, nowMs?: number): Promise<FormStageContext | null> {
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

		async finalizeBooking(input: FinalizeBookingInput): Promise<FinalizedBooking> {
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
			// Two-step: UPSERT booking + DELETE form-stage. Demo state, no
			// transactional guarantee needed (idempotent retries acceptable —
			// duplicate finalize would replace the same partnerOrderId row,
			// no double-billing risk because state is presentation-only).
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

		async getBooking(partnerOrderId: string): Promise<FinalizedBooking | null> {
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

		async cancelBooking(partnerOrderId: string): Promise<CancelOutcome> {
			// Read-modify-write: select current status, check, write if needed.
			// Demo wow-effect doesn't model concurrent cancel — sequential
			// presenter actions only, no lost-update risk.
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

		async __reset(): Promise<void> {
			// Tenant-scoped wipe — used by `_demo/admin/reset` endpoint.
			// Never called in production paths (depcruise blocks the import).
			await sql`DELETE FROM mockOtaOstrovokBookHash WHERE tenantId = ${tenantId}`
			await sql`DELETE FROM mockOtaOstrovokFormStage WHERE tenantId = ${tenantId}`
			await sql`DELETE FROM mockOtaOstrovokBooking WHERE tenantId = ${tenantId}`
		},

		async __listBookHashes() {
			const [rows = []] = await sql<{ bookHash: string; contextJson: unknown }[]>`
				SELECT bookHash, contextJson
				FROM mockOtaOstrovokBookHash
				WHERE tenantId = ${tenantId}
			`
			return rows
				.filter((r) => r.contextJson != null)
				.map((r) => ({
					bookHash: r.bookHash,
					context: r.contextJson as BookHashContext,
				}))
		},

		async __listFormStages() {
			const [rows = []] = await sql<{ contextJson: unknown }[]>`
				SELECT contextJson
				FROM mockOtaOstrovokFormStage
				WHERE tenantId = ${tenantId}
			`
			return rows.filter((r) => r.contextJson != null).map((r) => r.contextJson as FormStageContext)
		},

		async __listBookings() {
			const [rows = []] = await sql<{ bookingJson: unknown }[]>`
				SELECT bookingJson
				FROM mockOtaOstrovokBooking
				WHERE tenantId = ${tenantId}
			`
			return rows.filter((r) => r.bookingJson != null).map((r) => r.bookingJson as FinalizedBooking)
		},
	}
}
