/**
 * Round 14 self-review #6 — state store for the Round 9 Островок / ETG mock-OTA
 * HTTP server. **YDB-backed primary state** (canon `feedback_p1_means_now_not_later`).
 *
 * History:
 *   - Round 9 → in-memory `Map<string, Context>` (single-instance demo)
 *   - Round 13 → migration 0078 added `mockOtaReservationAudit` (audit trail only)
 *     с explicit design doc «in-memory state.ts remains the PRIMARY state»
 *   - Round 14 self-review #6 (2026-05-27): user trigger «точно уверен?
 *     по всем нашим канонам?» caught Run #112+#114 smoke failures empirically
 *     — YC Serverless scales к multiple instances, in-process Map diverges,
 *     prebook → `rate_not_found`. P1 same-session close: promote к YDB-backed
 *     primary state с migration 0080.
 *
 * Three tables (TTL P1D enforced natively):
 *   - `mockOtaOstrovokBookHash`     — search → bookHash
 *   - `mockOtaOstrovokFormStage`    — prebook → form stage
 *   - `mockOtaOstrovokBooking`      — finish → finalized booking
 *
 * **Store interface** (canonical pattern, mirrors `DcrStore`):
 *   - `createInMemoryOstrovokStore()` — for unit tests (Map-backed, no YDB I/O)
 *   - `createYdbOstrovokStore(sql)`   — for production / integration tests
 *
 * Both implement same `OstrovokStore` interface. All methods async.
 *
 * **Token / id shapes** mirror real ETG observed responses:
 *   - `book_hash` — 32-hex character string (`crypto.randomBytes(16).toString('hex')`)
 *   - `order_id` — 12-digit integer (real ETG response shape)
 *   - `item_id` — separate 12-digit integer (real ETG returns both per-form)
 *
 * **TTL**: native YDB P1D. Defense-in-depth — store methods ALSO check
 * `expiresAtMs < now` before returning (YDB TTL eventually consistent vs
 * app-immediate check).
 *
 * Reserved-test PII shield enforced в routes BEFORE storeBooking — table
 * carries non-real PII shape only (Иванов/Петров + example.com + +7000…).
 */

import { randomBytes, randomInt } from 'node:crypto'
import type { sql as SQL } from '../../../../db/index.ts'
import { timestampOpt, toJson } from '../../../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

const BOOK_HASH_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours per real ETG quote lifetime
const FORM_STAGE_TTL_MS = 60 * 60 * 1000 // 60 minutes per ETG form-window canon
const DEMO_TENANT = 'demo-tenant'

export interface BookHashContext {
	readonly hid: number
	readonly checkin: string // YYYY-MM-DD
	readonly checkout: string // YYYY-MM-DD
	readonly adults: number
	readonly children: ReadonlyArray<number>
	readonly currency: 'RUB'
	readonly dailyPrices: ReadonlyArray<number>
	readonly totalPrice: number
	readonly roomName: string
	readonly mealName: string
	readonly issuedAtMs: number
	readonly expiresAtMs: number
}

export interface FormStageContext {
	readonly partnerOrderId: string
	readonly bookHash: string
	readonly orderId: number
	readonly itemId: number
	readonly currency: 'RUB'
	readonly totalAmount: number
	readonly createdAtMs: number
	readonly expiresAtMs: number
}

export interface FinalizedBooking {
	readonly partnerOrderId: string
	readonly orderId: number
	readonly itemId: number
	readonly hid: number
	readonly checkin: string
	readonly checkout: string
	readonly adults: number
	readonly children: ReadonlyArray<number>
	readonly currency: 'RUB'
	readonly totalAmount: number
	readonly status: 'confirmed' | 'cancelled'
	readonly customerEmail: string
	readonly customerPhone: string
	readonly guests: ReadonlyArray<{
		readonly firstName: string
		readonly lastName: string
		readonly isChild: boolean
		readonly age?: number
	}>
	readonly createdAtMs: number
}

export interface StoreBookHashInput {
	readonly bookHash: string
	readonly hid: number
	readonly checkin: string
	readonly checkout: string
	readonly adults: number
	readonly children: ReadonlyArray<number>
	readonly currency: 'RUB'
	readonly dailyPrices: ReadonlyArray<number>
	readonly totalPrice: number
	readonly roomName: string
	readonly mealName: string
	readonly nowMs?: number
}

export interface StoreFormStageInput {
	readonly partnerOrderId: string
	readonly bookHash: string
	readonly orderId: number
	readonly itemId: number
	readonly currency: 'RUB'
	readonly totalAmount: number
	readonly nowMs?: number
}

export interface FinalizeBookingInput {
	readonly form: FormStageContext
	readonly bookHashContext: BookHashContext
	readonly customerEmail: string
	readonly customerPhone: string
	readonly guests: ReadonlyArray<{
		readonly firstName: string
		readonly lastName: string
		readonly isChild: boolean
		readonly age?: number
	}>
	readonly nowMs?: number
}

export interface OstrovokStore {
	storeBookHash(input: StoreBookHashInput): Promise<void>
	getBookHash(bookHash: string, nowMs?: number): Promise<BookHashContext | null>
	storeFormStage(input: StoreFormStageInput): Promise<void>
	getFormStage(partnerOrderId: string, nowMs?: number): Promise<FormStageContext | null>
	finalizeBooking(input: FinalizeBookingInput): Promise<FinalizedBooking>
	getBooking(partnerOrderId: string): Promise<FinalizedBooking | null>
	cancelBooking(partnerOrderId: string): Promise<'cancelled' | 'already_cancelled' | 'not_found'>
	__reset(): Promise<void>
	__listBookHashes(): Promise<ReadonlyArray<{ bookHash: string; context: BookHashContext }>>
	__listFormStages(): Promise<ReadonlyArray<FormStageContext>>
	__listBookings(): Promise<ReadonlyArray<FinalizedBooking>>
}

/**
 * Generate a 32-hex book_hash (16 random bytes → hex). Real ETG returns
 * 32-character hex tokens; we mirror the shape so downstream consumers
 * (Phase-1 frontend + Phase-2 inventory replay) can pattern-match.
 */
export function generateBookHash(): string {
	return randomBytes(16).toString('hex')
}

/**
 * Generate a 12-digit positive integer order_id. Real ETG emits opaque
 * numeric ids (observed range 10^11 .. 10^12).
 */
export function generateOrderId(): number {
	return randomInt(1_000_000_000_00, 1_000_000_000_000)
}

/** Generate a 12-digit positive integer item_id (per-room line item). */
export function generateItemId(): number {
	return randomInt(1_000_000_000_00, 1_000_000_000_000)
}

// ─────────────────────────────────────────────────────────────────────────
// In-memory implementation (unit tests + APP_MODE !== sandbox local dev)
// ─────────────────────────────────────────────────────────────────────────

export function createInMemoryOstrovokStore(): OstrovokStore {
	const bookHashes = new Map<string, BookHashContext>()
	const formStages = new Map<string, FormStageContext>()
	const bookings = new Map<string, FinalizedBooking>()

	return {
		async storeBookHash(input) {
			const now = input.nowMs ?? Date.now()
			bookHashes.set(input.bookHash, {
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
				expiresAtMs: now + BOOK_HASH_TTL_MS,
			})
		},
		async getBookHash(bookHash, nowMs) {
			const ctx = bookHashes.get(bookHash)
			if (ctx === undefined) return null
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) {
				bookHashes.delete(bookHash)
				return null
			}
			return ctx
		},
		async storeFormStage(input) {
			const now = input.nowMs ?? Date.now()
			formStages.set(input.partnerOrderId, {
				partnerOrderId: input.partnerOrderId,
				bookHash: input.bookHash,
				orderId: input.orderId,
				itemId: input.itemId,
				currency: input.currency,
				totalAmount: input.totalAmount,
				createdAtMs: now,
				expiresAtMs: now + FORM_STAGE_TTL_MS,
			})
		},
		async getFormStage(partnerOrderId, nowMs) {
			const ctx = formStages.get(partnerOrderId)
			if (ctx === undefined) return null
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) {
				formStages.delete(partnerOrderId)
				return null
			}
			return ctx
		},
		async finalizeBooking(input) {
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
			bookings.set(input.form.partnerOrderId, finalized)
			formStages.delete(input.form.partnerOrderId)
			return finalized
		},
		async getBooking(partnerOrderId) {
			return bookings.get(partnerOrderId) ?? null
		},
		async cancelBooking(partnerOrderId) {
			const existing = bookings.get(partnerOrderId)
			if (existing === undefined) return 'not_found'
			if (existing.status === 'cancelled') return 'already_cancelled'
			bookings.set(partnerOrderId, { ...existing, status: 'cancelled' })
			return 'cancelled'
		},
		async __reset() {
			bookHashes.clear()
			formStages.clear()
			bookings.clear()
		},
		async __listBookHashes() {
			return Array.from(bookHashes.entries()).map(([bookHash, context]) => ({ bookHash, context }))
		},
		async __listFormStages() {
			return Array.from(formStages.values())
		},
		async __listBookings() {
			return Array.from(bookings.values())
		},
	}
}

// ─────────────────────────────────────────────────────────────────────────
// YDB implementation — production primary state
// ─────────────────────────────────────────────────────────────────────────

interface YdbBookHashRow {
	bookHash: string
	hid: number | bigint
	checkin: string
	checkout: string
	adults: number
	childrenJson: string | unknown | null
	currency: string
	dailyPricesJson: string | unknown
	totalPrice: number | bigint
	roomName: string
	mealName: string
	issuedAt: Date
	expiresAt: Date
}

interface YdbFormStageRow {
	partnerOrderId: string
	bookHash: string
	orderId: number | bigint
	itemId: number | bigint
	currency: string
	totalAmount: number | bigint
	createdAt: Date
	expiresAt: Date
}

interface YdbBookingRow {
	partnerOrderId: string
	orderId: number | bigint
	itemId: number | bigint
	hid: number | bigint
	checkin: string
	checkout: string
	adults: number
	childrenJson: string | unknown | null
	currency: string
	totalAmount: number | bigint
	status: string
	customerEmail: string
	customerPhone: string
	guestsJson: string | unknown
	createdAt: Date
}

function parseYdbJson<T>(value: unknown): T {
	if (typeof value === 'string') return JSON.parse(value) as T
	return value as T
}

function toNum(v: number | bigint): number {
	return typeof v === 'bigint' ? Number(v) : v
}

function rowToBookHashContext(row: YdbBookHashRow): BookHashContext {
	const children =
		row.childrenJson === null ? [] : parseYdbJson<ReadonlyArray<number>>(row.childrenJson)
	return {
		hid: toNum(row.hid),
		checkin: row.checkin,
		checkout: row.checkout,
		adults: row.adults,
		children,
		currency: row.currency as 'RUB',
		dailyPrices: parseYdbJson<ReadonlyArray<number>>(row.dailyPricesJson),
		totalPrice: toNum(row.totalPrice),
		roomName: row.roomName,
		mealName: row.mealName,
		issuedAtMs: row.issuedAt.getTime(),
		expiresAtMs: row.expiresAt.getTime(),
	}
}

function rowToFormStage(row: YdbFormStageRow): FormStageContext {
	return {
		partnerOrderId: row.partnerOrderId,
		bookHash: row.bookHash,
		orderId: toNum(row.orderId),
		itemId: toNum(row.itemId),
		currency: row.currency as 'RUB',
		totalAmount: toNum(row.totalAmount),
		createdAtMs: row.createdAt.getTime(),
		expiresAtMs: row.expiresAt.getTime(),
	}
}

function rowToBooking(row: YdbBookingRow): FinalizedBooking {
	const children =
		row.childrenJson === null ? [] : parseYdbJson<ReadonlyArray<number>>(row.childrenJson)
	const guests = parseYdbJson<FinalizedBooking['guests']>(row.guestsJson)
	return {
		partnerOrderId: row.partnerOrderId,
		orderId: toNum(row.orderId),
		itemId: toNum(row.itemId),
		hid: toNum(row.hid),
		checkin: row.checkin,
		checkout: row.checkout,
		adults: row.adults,
		children,
		currency: row.currency as 'RUB',
		totalAmount: toNum(row.totalAmount),
		status: row.status as 'confirmed' | 'cancelled',
		customerEmail: row.customerEmail,
		customerPhone: row.customerPhone,
		guests,
		createdAtMs: row.createdAt.getTime(),
	}
}

/**
 * Build YDB-backed Ostrovok store. Implements same `OstrovokStore` interface
 * as `createInMemoryOstrovokStore` — swap-compatible. State persisted в YDB
 * со native TTL P1D (migration 0080).
 */
export function createYdbOstrovokStore(sql: SqlInstance): OstrovokStore {
	void timestampOpt // re-export from helpers — used implicitly by sql tag template

	return {
		async storeBookHash(input) {
			const now = input.nowMs ?? Date.now()
			const issuedAt = new Date(now)
			const expiresAt = new Date(now + BOOK_HASH_TTL_MS)
			await sql`
				UPSERT INTO mockOtaOstrovokBookHash (
					\`tenantId\`, \`bookHash\`, \`hid\`, \`checkin\`, \`checkout\`,
					\`adults\`, \`childrenJson\`, \`currency\`, \`dailyPricesJson\`,
					\`totalPrice\`, \`roomName\`, \`mealName\`, \`issuedAt\`, \`expiresAt\`
				) VALUES (
					${DEMO_TENANT}, ${input.bookHash}, ${BigInt(input.hid)}, ${input.checkin}, ${input.checkout},
					${input.adults}, ${toJson(input.children)}, ${input.currency}, ${toJson(input.dailyPrices)},
					${BigInt(input.totalPrice)}, ${input.roomName}, ${input.mealName}, ${issuedAt}, ${expiresAt}
				)
			`
		},
		async getBookHash(bookHash, nowMs) {
			const [rows = []] = await sql<YdbBookHashRow[]>`
				SELECT bookHash, hid, checkin, checkout, adults, childrenJson, currency,
					dailyPricesJson, totalPrice, roomName, mealName, issuedAt, expiresAt
				FROM mockOtaOstrovokBookHash
				WHERE tenantId = ${DEMO_TENANT} AND bookHash = ${bookHash}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (row === undefined) return null
			const ctx = rowToBookHashContext(row)
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) return null // TTL eventually consistent; app-immediate check
			return ctx
		},
		async storeFormStage(input) {
			const now = input.nowMs ?? Date.now()
			const createdAt = new Date(now)
			const expiresAt = new Date(now + FORM_STAGE_TTL_MS)
			await sql`
				UPSERT INTO mockOtaOstrovokFormStage (
					\`tenantId\`, \`partnerOrderId\`, \`bookHash\`, \`orderId\`, \`itemId\`,
					\`currency\`, \`totalAmount\`, \`createdAt\`, \`expiresAt\`
				) VALUES (
					${DEMO_TENANT}, ${input.partnerOrderId}, ${input.bookHash}, ${BigInt(input.orderId)},
					${BigInt(input.itemId)}, ${input.currency}, ${BigInt(input.totalAmount)},
					${createdAt}, ${expiresAt}
				)
			`
		},
		async getFormStage(partnerOrderId, nowMs) {
			const [rows = []] = await sql<YdbFormStageRow[]>`
				SELECT partnerOrderId, bookHash, orderId, itemId, currency, totalAmount, createdAt, expiresAt
				FROM mockOtaOstrovokFormStage
				WHERE tenantId = ${DEMO_TENANT} AND partnerOrderId = ${partnerOrderId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (row === undefined) return null
			const ctx = rowToFormStage(row)
			const now = nowMs ?? Date.now()
			if (ctx.expiresAtMs < now) return null
			return ctx
		},
		async finalizeBooking(input) {
			const now = input.nowMs ?? Date.now()
			const createdAt = new Date(now)
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
				UPSERT INTO mockOtaOstrovokBooking (
					\`tenantId\`, \`partnerOrderId\`, \`orderId\`, \`itemId\`, \`hid\`,
					\`checkin\`, \`checkout\`, \`adults\`, \`childrenJson\`, \`currency\`,
					\`totalAmount\`, \`status\`, \`customerEmail\`, \`customerPhone\`,
					\`guestsJson\`, \`createdAt\`
				) VALUES (
					${DEMO_TENANT}, ${finalized.partnerOrderId}, ${BigInt(finalized.orderId)},
					${BigInt(finalized.itemId)}, ${BigInt(finalized.hid)}, ${finalized.checkin},
					${finalized.checkout}, ${finalized.adults}, ${toJson(finalized.children)},
					${finalized.currency}, ${BigInt(finalized.totalAmount)}, ${finalized.status},
					${finalized.customerEmail}, ${finalized.customerPhone}, ${toJson(finalized.guests)},
					${createdAt}
				)
			`
			// Best-effort delete of the form-stage row (matches in-memory behavior).
			await sql`
				DELETE FROM mockOtaOstrovokFormStage
				WHERE tenantId = ${DEMO_TENANT} AND partnerOrderId = ${finalized.partnerOrderId}
			`
			return finalized
		},
		async getBooking(partnerOrderId) {
			const [rows = []] = await sql<YdbBookingRow[]>`
				SELECT partnerOrderId, orderId, itemId, hid, checkin, checkout, adults, childrenJson,
					currency, totalAmount, status, customerEmail, customerPhone, guestsJson, createdAt
				FROM mockOtaOstrovokBooking
				WHERE tenantId = ${DEMO_TENANT} AND partnerOrderId = ${partnerOrderId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (row === undefined) return null
			return rowToBooking(row)
		},
		async cancelBooking(partnerOrderId) {
			const [rows = []] = await sql<YdbBookingRow[]>`
				SELECT partnerOrderId, orderId, itemId, hid, checkin, checkout, adults, childrenJson,
					currency, totalAmount, status, customerEmail, customerPhone, guestsJson, createdAt
				FROM mockOtaOstrovokBooking
				WHERE tenantId = ${DEMO_TENANT} AND partnerOrderId = ${partnerOrderId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (row === undefined) return 'not_found'
			if (row.status === 'cancelled') return 'already_cancelled'
			await sql`
				UPDATE mockOtaOstrovokBooking
				SET \`status\` = ${'cancelled'}
				WHERE tenantId = ${DEMO_TENANT} AND partnerOrderId = ${partnerOrderId}
			`
			return 'cancelled'
		},
		async __reset() {
			// Production safety: reset only the demo tenant rows. Admin endpoint
			// has session-token gate (Round 11 P1-B2) layered on top.
			await sql`DELETE FROM mockOtaOstrovokBookHash WHERE tenantId = ${DEMO_TENANT}`
			await sql`DELETE FROM mockOtaOstrovokFormStage WHERE tenantId = ${DEMO_TENANT}`
			await sql`DELETE FROM mockOtaOstrovokBooking WHERE tenantId = ${DEMO_TENANT}`
		},
		async __listBookHashes() {
			const [rows = []] = await sql<YdbBookHashRow[]>`
				SELECT bookHash, hid, checkin, checkout, adults, childrenJson, currency,
					dailyPricesJson, totalPrice, roomName, mealName, issuedAt, expiresAt
				FROM mockOtaOstrovokBookHash
				WHERE tenantId = ${DEMO_TENANT}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map((r) => ({ bookHash: r.bookHash, context: rowToBookHashContext(r) }))
		},
		async __listFormStages() {
			const [rows = []] = await sql<YdbFormStageRow[]>`
				SELECT partnerOrderId, bookHash, orderId, itemId, currency, totalAmount, createdAt, expiresAt
				FROM mockOtaOstrovokFormStage
				WHERE tenantId = ${DEMO_TENANT}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToFormStage)
		},
		async __listBookings() {
			const [rows = []] = await sql<YdbBookingRow[]>`
				SELECT partnerOrderId, orderId, itemId, hid, checkin, checkout, adults, childrenJson,
					currency, totalAmount, status, customerEmail, customerPhone, guestsJson, createdAt
				FROM mockOtaOstrovokBooking
				WHERE tenantId = ${DEMO_TENANT}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToBooking)
		},
	}
}
