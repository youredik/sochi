import type { BookingStatus } from '@horeca/shared'

/**
 * Pure state machine for booking transitions (M5e.2).
 *
 * Single source of truth for the frontend:
 *   - which transitions are valid from a given status
 *   - which statuses are terminal (no actions remain)
 *   - human-facing labels for each transition
 *
 * Mirrors backend exactly (verified 2026-04-24 against
 * apps/backend/src/domains/booking/booking.repo.ts:509-652):
 *
 *   cancel       ← { confirmed, in_house }   → cancelled
 *   checkIn      ← { confirmed }             → in_house
 *   checkOut     ← { in_house }              → checked_out
 *   markNoShow   ← { confirmed }             → no_show
 *
 * Terminal states (no outgoing transitions): cancelled, checked_out, no_show.
 *
 * Enum-guard strategy (NOT trust-server-409): we hide disabled actions
 * from the UI so users see only valid next steps. Backend 409
 * INVALID_BOOKING_TRANSITION remains authoritative for race conditions
 * (two tabs flipping the same booking).
 */

export type BookingTransition = 'checkIn' | 'checkOut' | 'cancel' | 'noShow'

const TERMINAL_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
	'cancelled',
	'checked_out',
	'no_show',
])

const TRANSITIONS_BY_STATUS: Readonly<Record<BookingStatus, readonly BookingTransition[]>> = {
	confirmed: ['checkIn', 'cancel', 'noShow'],
	in_house: ['checkOut', 'cancel'],
	cancelled: [],
	checked_out: [],
	no_show: [],
}

/**
 * Russian action labels (button + toast copy).
 * Kept as exact-value map so renames land in one place and tests
 * catch any drift in the UI copy.
 */
const TRANSITION_LABELS: Readonly<Record<BookingTransition, string>> = {
	checkIn: 'Заезд',
	checkOut: 'Выезд',
	cancel: 'Отменить бронь',
	noShow: 'Не заехал',
}

/**
 * Russian localized labels for each booking status — used by
 * read-only terminal-state dialog header. Exact-value; must match
 * palette labels in chessboard/lib/booking-palette.ts.
 */
const STATUS_LABELS: Readonly<Record<BookingStatus, string>> = {
	confirmed: 'Подтверждена',
	in_house: 'В проживании',
	checked_out: 'Выехал',
	cancelled: 'Отменена',
	no_show: 'Не заехал',
}

export function isTerminal(status: BookingStatus): boolean {
	return TERMINAL_STATUSES.has(status)
}

export function availableTransitions(status: BookingStatus): readonly BookingTransition[] {
	return TRANSITIONS_BY_STATUS[status]
}

export function labelForTransition(t: BookingTransition): string {
	return TRANSITION_LABELS[t]
}

export function labelForStatus(s: BookingStatus): string {
	return STATUS_LABELS[s]
}

/**
 * Resulting status after a successful transition. Used by optimistic
 * UI to update the grid cache without waiting for the server reply.
 * Pure + total — each (status, transition) either maps to a status
 * or throws (caller is expected to check availableTransitions first).
 */
export function nextStatus(status: BookingStatus, transition: BookingTransition): BookingStatus {
	if (!availableTransitions(status).includes(transition)) {
		throw new Error(`nextStatus: transition "${transition}" is not valid from status "${status}"`)
	}
	switch (transition) {
		case 'checkIn':
			return 'in_house'
		case 'checkOut':
			return 'checked_out'
		case 'cancel':
			return 'cancelled'
		case 'noShow':
			return 'no_show'
	}
}
