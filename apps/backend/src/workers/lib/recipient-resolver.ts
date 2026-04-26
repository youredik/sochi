/**
 * Recipient email resolver for the notification dispatcher (M7.fix.1).
 *
 * Per research synthesis 2026-04-26 §7 + §9 anti-pattern checklist:
 *   "Hardcoded recipient instead of resolved from booking.guest at dispatch
 *    time" — guest may change email between outbox-write and send. Resolve
 *    at dispatch.
 *
 * Resolution chains by `sourceObjectType`:
 *   - 'booking'  → booking.primaryGuestId → guest.email
 *   - 'payment'  → payment.bookingId → booking.primaryGuestId → guest.email
 *   - 'receipt'  → receipt.paymentId → payment.bookingId → booking.primaryGuestId → guest.email
 *
 * Indexes (added in migration 0024):
 *   - booking.ixBookingId GLOBAL SYNC ON (id)        — pre-existing (0004)
 *   - payment.ixPaymentId GLOBAL SYNC ON (id)        — added 0024
 *   - receipt.ixReceiptId GLOBAL SYNC ON (id)        — added 0024
 *
 * Result types:
 *   - { kind: 'resolved', email }      — guest.email is non-null + non-empty
 *   - { kind: 'no_email' }             — guest exists but email is NULL/empty
 *   - { kind: 'not_found' }            — chain breaks (deleted booking, etc.)
 *
 * V1 scope: resolves **guest email only** for guest-facing kinds. For ops
 * alerts (payment_failed / receipt_failed) caller still passes the
 * placeholder; ops resolution lands in M9 alongside Telegram bot integration.
 */

import type { sql as SQL } from '../../db/index.ts'

type SqlInstance = typeof SQL

export type RecipientSource = 'booking' | 'payment' | 'receipt'

export type ResolveResult =
	| { kind: 'resolved'; email: string }
	| { kind: 'no_email'; reason: string }
	| { kind: 'not_found'; reason: string }

/**
 * Resolve guest recipient email by tracing CDC source object → guest.
 *
 * Inline SQL with VIEW hints — each lookup is a single-row index scan.
 * For 'booking' source: 2 lookups. For 'payment': 3. For 'receipt': 4.
 * Within SMB scale (<10 emails/min throughput) negligible.
 */
export async function resolveRecipientEmail(
	sql: SqlInstance,
	source: RecipientSource,
	tenantId: string,
	sourceObjectId: string,
): Promise<ResolveResult> {
	let bookingId: string
	if (source === 'booking') {
		bookingId = sourceObjectId
	} else if (source === 'payment') {
		const found = await loadPaymentBookingId(sql, tenantId, sourceObjectId)
		if (found === null) {
			return { kind: 'not_found', reason: `payment ${sourceObjectId} not found` }
		}
		bookingId = found
	} else if (source === 'receipt') {
		const paymentId = await loadReceiptPaymentId(sql, tenantId, sourceObjectId)
		if (paymentId === null) {
			return { kind: 'not_found', reason: `receipt ${sourceObjectId} not found` }
		}
		const found = await loadPaymentBookingId(sql, tenantId, paymentId)
		if (found === null) {
			return { kind: 'not_found', reason: `payment ${paymentId} not found (from receipt)` }
		}
		bookingId = found
	} else {
		// Exhaustive guard — TS errors if a new source is added without a case.
		const _exhaustive: never = source
		throw new Error(`resolveRecipientEmail: unhandled source ${String(_exhaustive)}`)
	}

	const guestId = await loadBookingGuestId(sql, tenantId, bookingId)
	if (guestId === null) {
		return { kind: 'not_found', reason: `booking ${bookingId} not found` }
	}

	const email = await loadGuestEmail(sql, tenantId, guestId)
	if (email === null) {
		return { kind: 'not_found', reason: `guest ${guestId} not found` }
	}
	if (email.length === 0) {
		return { kind: 'no_email', reason: `guest ${guestId} has no email on file` }
	}
	return { kind: 'resolved', email }
}

/* ----------------------------------------------------------------- lookups */

async function loadPaymentBookingId(
	sql: SqlInstance,
	tenantId: string,
	paymentId: string,
): Promise<string | null> {
	const [rows = []] = await sql<{ bookingId: string }[]>`
		SELECT bookingId FROM payment VIEW ixPaymentId
		WHERE tenantId = ${tenantId} AND id = ${paymentId}
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows[0]?.bookingId ?? null
}

async function loadReceiptPaymentId(
	sql: SqlInstance,
	tenantId: string,
	receiptId: string,
): Promise<string | null> {
	const [rows = []] = await sql<{ paymentId: string }[]>`
		SELECT paymentId FROM receipt VIEW ixReceiptId
		WHERE tenantId = ${tenantId} AND id = ${receiptId}
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows[0]?.paymentId ?? null
}

async function loadBookingGuestId(
	sql: SqlInstance,
	tenantId: string,
	bookingId: string,
): Promise<string | null> {
	const [rows = []] = await sql<{ primaryGuestId: string }[]>`
		SELECT primaryGuestId FROM booking VIEW ixBookingId
		WHERE tenantId = ${tenantId} AND id = ${bookingId}
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows[0]?.primaryGuestId ?? null
}

async function loadGuestEmail(
	sql: SqlInstance,
	tenantId: string,
	guestId: string,
): Promise<string | null> {
	// guest PK is (tenantId, id) — direct lookup, no VIEW needed.
	// Returns empty string if email column is empty; null if email is NULL or
	// guest row missing.
	const [rows = []] = await sql<{ email: string | null }[]>`
		SELECT email FROM guest
		WHERE tenantId = ${tenantId} AND id = ${guestId}
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	const row = rows[0]
	if (!row) return null
	return row.email ?? ''
}
