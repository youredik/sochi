import type { BookingGuestSnapshot, GuestCreateInput } from '@horeca/shared'
import { addDays, diffDays } from '../../chessboard/lib/date-range.ts'

/**
 * Pure helpers for booking-create flow. Extracted from the mutation +
 * dialog so money-adjacent discipline (idempotency-key stability,
 * guest-snapshot immutable subset, night-count) is unit-testable
 * without mocking TanStack Query or fetch.
 *
 * Booking-create discipline:
 *   - `primaryGuestId` must be a freshly-created guest row; server
 *     validates the ID + enforces (tenantId) scoping.
 *   - `guestSnapshot` — 6 fields frozen at create time; the server
 *     stores these alongside the live guest row so МВД reporting sees
 *     the doc as it was at reservation, not a later profile edit.
 *   - `Idempotency-Key` — stable for the lifetime of the dialog; if
 *     the user re-clicks submit after a network hiccup, the server
 *     replays the first response instead of double-creating.
 *   - `channelCode` defaults to `walkIn` for dialog-initiated bookings
 *     (front-desk origin); OTA/CM flows populate it via channel code
 *     on import (not wired yet).
 */

export type BookingCreateDialogInput = {
	roomTypeId: string
	ratePlanId: string
	checkIn: string // YYYY-MM-DD
	checkOut: string // YYYY-MM-DD
	guestsCount: number
	primaryGuestId: string
	primaryGuest: {
		firstName: string
		lastName: string
		middleName?: string | null
		citizenship: string
		documentType: string
		documentNumber: string
	}
	channelCode?: 'direct' | 'walkIn'
	notes?: string
}

/**
 * Narrow the full Guest row to the 6-field immutable snapshot the
 * booking carries. Explicit to keep future Guest additions (passport
 * series, email …) from silently widening the snapshot — any new
 * field requires deliberate reconsideration of the МВД-reporting
 * contract.
 */
export function buildGuestSnapshot(
	guest: BookingCreateDialogInput['primaryGuest'],
): BookingGuestSnapshot {
	const snapshot: BookingGuestSnapshot = {
		firstName: guest.firstName,
		lastName: guest.lastName,
		citizenship: guest.citizenship,
		documentType: guest.documentType,
		documentNumber: guest.documentNumber,
	}
	if (guest.middleName) {
		snapshot.middleName = guest.middleName
	}
	return snapshot
}

/**
 * Build the POST /properties/:propertyId/bookings body. All keys the
 * server's `bookingCreateInput` Zod schema marks required are
 * populated; optional keys (`externalId`, `externalReferences`) are
 * deliberately omitted rather than nulled for clarity.
 */
export function buildBookingCreateBody(input: BookingCreateDialogInput) {
	if (input.checkIn >= input.checkOut) {
		throw new Error(
			`buildBookingCreateBody: checkIn must be strictly before checkOut (got ${input.checkIn} → ${input.checkOut})`,
		)
	}
	if (!Number.isInteger(input.guestsCount) || input.guestsCount < 1 || input.guestsCount > 20) {
		throw new Error(
			`buildBookingCreateBody: guestsCount must be integer 1..20, got ${input.guestsCount}`,
		)
	}
	const body: {
		roomTypeId: string
		ratePlanId: string
		checkIn: string
		checkOut: string
		guestsCount: number
		primaryGuestId: string
		guestSnapshot: BookingGuestSnapshot
		channelCode: 'direct' | 'walkIn'
		notes?: string
	} = {
		roomTypeId: input.roomTypeId,
		ratePlanId: input.ratePlanId,
		checkIn: input.checkIn,
		checkOut: input.checkOut,
		guestsCount: input.guestsCount,
		primaryGuestId: input.primaryGuestId,
		guestSnapshot: buildGuestSnapshot(input.primaryGuest),
		channelCode: input.channelCode ?? 'walkIn',
	}
	if (input.notes) body.notes = input.notes
	return body
}

/**
 * Build the POST /guests body. Required: lastName, firstName,
 * citizenship, documentType, documentNumber. RU default citizenship
 * because non-RU triggers МВД registrationStatus=pending — we ask
 * the user explicitly (via dialog) rather than guess.
 */
export function buildGuestCreateBody(guest: {
	firstName: string
	lastName: string
	middleName?: string
	citizenship: string
	documentType: string
	documentNumber: string
}): GuestCreateInput {
	const trimFirst = guest.firstName.trim()
	const trimLast = guest.lastName.trim()
	const trimDoc = guest.documentNumber.trim()
	if (!trimFirst) throw new Error('buildGuestCreateBody: firstName required')
	if (!trimLast) throw new Error('buildGuestCreateBody: lastName required')
	if (!trimDoc) throw new Error('buildGuestCreateBody: documentNumber required')
	const body: GuestCreateInput = {
		firstName: trimFirst,
		lastName: trimLast,
		citizenship: guest.citizenship,
		documentType: guest.documentType,
		documentNumber: trimDoc,
	}
	if (guest.middleName?.trim()) {
		body.middleName = guest.middleName.trim()
	}
	return body
}

/**
 * Inclusive-exclusive nights count (checkIn .. checkOut-1). Used for
 * dialog affordance ("3 ночи") and optimistic-band width sanity.
 */
export function nightsCount(checkIn: string, checkOut: string): number {
	return diffDays(checkIn, checkOut)
}

/**
 * Default checkOut = checkIn + 1 night. Safe default for click-to-
 * create — user always adjusts but we never start with a zero-night
 * (invalid) or 7-night (too-confident) guess.
 */
export function defaultCheckOut(checkIn: string): string {
	return addDays(checkIn, 1)
}

/**
 * Generate a fresh idempotency key. Wrapped around `crypto.randomUUID`
 * so tests can assert shape (UUIDv4) without depending on randomness;
 * caller holds the key stable for the lifetime of one dialog instance.
 */
export function generateIdempotencyKey(): string {
	return crypto.randomUUID()
}
