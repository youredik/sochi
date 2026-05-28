/**
 * Ostrovok / ETG mock-OTA state store — interface + in-memory implementation.
 *
 * Round 14.5 re-do — replaces `state.ts` module-scoped `Map<>`s с DI Store
 * pattern. Closes pre-existing multi-instance race (ETG-SMOKE / R12-11 /
 * R13-9) where YC Serverless container scale-out left routes on different
 * instances seeing stale book_hash / form_stage maps. YDB-backed Store
 * (см. `store.ydb.ts`) gives globally-consistent state.
 *
 * Three FSM stages mirrored across implementations:
 *   1. `bookHashes`  — search-result tokens (24h TTL)
 *   2. `formStages`  — pre-book stage (60min TTL)
 *   3. `bookings`    — finalized confirmed/cancelled bookings (no TTL —
 *                       terminal, presenter может inspect history)
 *
 * Interface methods mirror the old `state.ts` exports 1:1 BUT async — so
 * the YDB impl can do real I/O без forcing the in-memory impl into sync-
 * adapter contortions. In-memory impl returns `Promise.resolve(...)` —
 * still O(1), still fast, no event-loop hop because we resolve synchronously
 * inside an `async` function.
 *
 * Reset / list helpers retain the `__` prefix (test / admin only — never
 * production traffic). depcruise enforces `_demo/` one-way isolation.
 *
 * Canon refs:
 *   - `feedback_round_14_self_review_6_rollback_lessons_2026_05_27.md`
 *     (Round 14 re-do prerequisites — mandatory local `pnpm test:db`)
 *   - `feedback_deploy_as_debug_antipattern_2026_05_19.md` (local YDB Docker
 *     validation BEFORE push)
 *   - `feedback_native_yc_services_first_canon_2026_05_24.md` (YDB native TTL
 *     instead of application sweep cron)
 */

import { randomBytes, randomInt } from 'node:crypto'

const BOOK_HASH_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours per real ETG quote lifetime
const FORM_STAGE_TTL_MS = 60 * 60 * 1000 // 60 minutes per ETG form-window canon

export interface BookHashContext {
	readonly hid: number
	readonly checkin: string // YYYY-MM-DD
	readonly checkout: string // YYYY-MM-DD
	readonly adults: number
	readonly children: ReadonlyArray<number> // ages of child guests
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

export type CancelOutcome = 'cancelled' | 'already_cancelled' | 'not_found'

/**
 * Store contract — abstracted to enable swap between in-memory (tests, dev)
 * and YDB (production multi-instance) without touching route handlers. All
 * methods async для I/O symmetry — in-memory just returns resolved promises.
 */
export interface OstrovokStore {
	storeBookHash(input: StoreBookHashInput): Promise<void>
	getBookHash(bookHash: string, nowMs?: number): Promise<BookHashContext | null>
	storeFormStage(input: StoreFormStageInput): Promise<void>
	getFormStage(partnerOrderId: string, nowMs?: number): Promise<FormStageContext | null>
	finalizeBooking(input: FinalizeBookingInput): Promise<FinalizedBooking>
	getBooking(partnerOrderId: string): Promise<FinalizedBooking | null>
	cancelBooking(partnerOrderId: string): Promise<CancelOutcome>

	// Test / admin helpers — depcruise blocks production runtime imports.
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
 * numeric ids (observed range 10^11 .. 10^12). We use `randomInt(1e11, 1e12)`
 * to stay within the same shape без collision risk for demo throughput.
 */
export function generateOrderId(): number {
	return randomInt(100_000_000_000, 1_000_000_000_000)
}

/**
 * Generate a 12-digit positive integer item_id (per-room line item). Same
 * shape as order_id; separate counter so a future multi-room demo can
 * carry distinct ids per inventory line.
 */
export function generateItemId(): number {
	return randomInt(100_000_000_000, 1_000_000_000_000)
}

/**
 * In-memory implementation — preserves Phase-1 behaviour bit-for-bit.
 * Used by:
 *   - Unit tests (`*.routes.test.ts` — fast, isolated)
 *   - Local dev when YDB Docker not available
 *   - Single-instance dev/test environments where multi-instance race
 *     doesn't apply
 *
 * NOT used in production (`APP_MODE !== 'production'` для demo, но wired
 * to YDB store via `app.ts` DI selector — single-instance fallback only).
 */
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
			return Array.from(bookHashes.entries()).map(([bookHash, context]) => ({
				bookHash,
				context,
			}))
		},

		async __listFormStages() {
			return Array.from(formStages.values())
		},

		async __listBookings() {
			return Array.from(bookings.values())
		},
	}
}
