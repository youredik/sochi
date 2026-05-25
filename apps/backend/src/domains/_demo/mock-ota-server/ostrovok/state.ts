/**
 * In-memory state for the Round 9 Островок / ETG mock-OTA HTTP server.
 *
 * Mirrors the real ETG `api.worldota.net/api/b2b/v3/...` 5-stage flow but
 * lives entirely в `_demo/` (one-way dependency canon: `_demo` can lean on
 * `lib/channel-manager`, but MUST NOT import sibling domains). The Round 8
 * `OstrovokEtgMock` is the behaviour-faithful canon — this HTTP shell mirrors
 * its FSM contract, не зовёт его напрямую (cross-domain import would trip
 * `no-cross-domain` rule in `.dependency-cruiser.mjs`).
 *
 * Three ephemeral maps хранят stage-progression:
 *
 *   1. `bookHashes` — issued by `POST /search/hp/`. The 32-hex token carries
 *      the search context (hid, dates, party, daily prices). 24-hour TTL —
 *      real ETG keeps quoted rates valid for the same window. Consumed by
 *      `POST /hotel/order/booking/form/` (stage 2).
 *
 *   2. `formStages` — created by `POST /hotel/order/booking/form/`. Carries
 *      partner_order_id → order_id mapping plus a 60-min lifetime (matches
 *      ETG's form-window canon, after which finish must restart from search).
 *      Consumed by `POST /hotel/order/booking/finish/` (stage 3) which
 *      promotes the form-stage record into a `bookings` entry.
 *
 *   3. `bookings` — finalized after `finish/`. Status starts `confirmed` →
 *      mutates `cancelled` via `POST /hotel/order/cancel/`. Idempotent cancel:
 *      second call returns `already_cancelled` без duplicate webhook emission.
 *
 * **Token / id shapes** mirror real ETG observed responses:
 *   - `book_hash` — 32-hex character string (`crypto.randomBytes(16).toString('hex')`)
 *   - `order_id` — 12-digit integer (numeric, что и в реальном ETG response shape)
 *   - `item_id` — separate 12-digit integer (real ETG returns both per-form)
 *
 * **TTL**: lazy expiry — checked at lookup time (`getBookHash` / `getFormStage`)
 * and stale entries deleted on read. No background sweep: demo state pool is
 * small + deploy restart is daily anyway. Phase-2 — move к `mockOtaReservation_demo`
 * YDB table с native 24h TTL per
 * `feedback_native_yc_services_first_canon_2026_05_24.md`.
 *
 * **Reset**: `__resetState()` clears all three maps. Used by `beforeEach` в
 * tests + by the (Batch-3) admin reset endpoint. Production code paths never
 * touch these helpers — they live under `_demo/` and депенденcy-cruiser
 * blocks production runtime от importing them.
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

const bookHashes = new Map<string, BookHashContext>()
const formStages = new Map<string, FormStageContext>() // keyed by partnerOrderId
const bookings = new Map<string, FinalizedBooking>() // keyed by partnerOrderId

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
	return randomInt(1_000_000_000_00, 1_000_000_000_000)
}

/**
 * Generate a 12-digit positive integer item_id (per-room line item). Same
 * shape as order_id; separate counter so a future multi-room demo can
 * carry distinct ids per inventory line.
 */
export function generateItemId(): number {
	return randomInt(1_000_000_000_00, 1_000_000_000_000)
}

/**
 * Persist a search result so `POST /hotel/order/booking/form/` can validate
 * the book_hash. Caller is responsible for hash generation. `nowMs` injector
 * for test determinism.
 */
export function storeBookHash(input: {
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
}): void {
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
}

/**
 * Resolve a previously-issued book_hash. Returns the context if valid (not
 * expired), null otherwise. Lazy sweep — expired entries deleted on read.
 * Does NOT consume the hash; multiple `form/` calls с same hash могут creates
 * multiple form-stages (each с unique partner_order_id), matching real ETG
 * permissive shape.
 */
export function getBookHash(bookHash: string, nowMs?: number): BookHashContext | null {
	const ctx = bookHashes.get(bookHash)
	if (ctx === undefined) return null
	const now = nowMs ?? Date.now()
	if (ctx.expiresAtMs < now) {
		bookHashes.delete(bookHash)
		return null
	}
	return ctx
}

/**
 * Persist a freshly-created form stage. Caller validates the partner_order_id
 * shape (UUIDv4 3-256 chars per real ETG contract) AND that no existing
 * form/booking is associated с this id (idempotency window).
 */
export function storeFormStage(input: {
	readonly partnerOrderId: string
	readonly bookHash: string
	readonly orderId: number
	readonly itemId: number
	readonly currency: 'RUB'
	readonly totalAmount: number
	readonly nowMs?: number
}): void {
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
}

/**
 * Look up a form-stage record by partner_order_id. Returns null if missing OR
 * expired (lazy sweep). Used by `finish/` to validate the prebook chain.
 */
export function getFormStage(partnerOrderId: string, nowMs?: number): FormStageContext | null {
	const ctx = formStages.get(partnerOrderId)
	if (ctx === undefined) return null
	const now = nowMs ?? Date.now()
	if (ctx.expiresAtMs < now) {
		formStages.delete(partnerOrderId)
		return null
	}
	return ctx
}

/**
 * Promote a form-stage record into a finalized booking. Caller passes guest
 * data + status='confirmed'. Removes the form-stage record на finalization —
 * subsequent `form/` lookups by the same partner_order_id resolve through
 * `getBooking`, not `getFormStage`.
 */
export function finalizeBooking(input: {
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
}): FinalizedBooking {
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
}

/**
 * Look up a finalized booking by partner_order_id. Used by `finish/status/`
 * and `cancel/` for status routing.
 */
export function getBooking(partnerOrderId: string): FinalizedBooking | null {
	return bookings.get(partnerOrderId) ?? null
}

/**
 * Mark a booking as cancelled. Monotonic: `confirmed → cancelled` is one-way.
 *
 *   - `'cancelled'` — first cancel, mutation applied, caller should emit webhook
 *   - `'already_cancelled'` — booking already в cancelled state, no-op (idempotent
 *     contract; caller MUST NOT emit duplicate webhook)
 *   - `'not_found'` — no booking with this partner_order_id
 */
export function cancelBooking(
	partnerOrderId: string,
): 'cancelled' | 'already_cancelled' | 'not_found' {
	const existing = bookings.get(partnerOrderId)
	if (existing === undefined) return 'not_found'
	if (existing.status === 'cancelled') return 'already_cancelled'
	bookings.set(partnerOrderId, { ...existing, status: 'cancelled' })
	return 'cancelled'
}

/**
 * Test / admin reset helper. Drops every book_hash + form-stage + booking.
 * Called by `beforeEach` в tests + by `POST /api/_mock-ota/admin/reset`.
 * Production code paths must never call this — depcruise + one-way `_demo`
 * boundary enforce.
 */
export function __resetState(): void {
	bookHashes.clear()
	formStages.clear()
	bookings.clear()
}

/**
 * Read-only snapshot accessors для tests + admin panel introspection.
 * NOT exposed через HTTP routes directly — assertions in `*.routes.test.ts`
 * use these to inspect post-condition without going through public API.
 */
export function __listBookHashes(): ReadonlyArray<{
	readonly bookHash: string
	readonly context: BookHashContext
}> {
	return Array.from(bookHashes.entries()).map(([bookHash, context]) => ({
		bookHash,
		context,
	}))
}

export function __listFormStages(): ReadonlyArray<FormStageContext> {
	return Array.from(formStages.values())
}

export function __listBookings(): ReadonlyArray<FinalizedBooking> {
	return Array.from(bookings.values())
}
