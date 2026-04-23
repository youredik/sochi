import type { BookingStatus } from '@horeca/shared'

/**
 * Booking-status → cell display classes.
 *
 * Mews 2026 palette (converged standard from 2026 research): action-blue
 * for today's arrivals/departures, in-house-black for occupied, grey for
 * past/cancelled, yellow for no-show. Bnovo's red-background for negative
 * availability is applied separately in the grid when allotment-sold < 0.
 *
 * Kept as a pure data structure (not JSX) so it's:
 *   - unit-testable (exact-value mapping per status, immutable table)
 *   - re-usable across chessboard + future list/filter UIs
 *   - safe under React Compiler memoization (referentially stable)
 */

interface CellStyle {
	readonly bg: string
	readonly text: string
	readonly label: string
}

export const BOOKING_CELL_STYLES: Readonly<Record<BookingStatus, CellStyle>> = {
	confirmed: {
		bg: 'bg-blue-500 hover:bg-blue-600',
		text: 'text-white',
		label: 'Подтверждена',
	},
	in_house: {
		bg: 'bg-neutral-900 hover:bg-neutral-800',
		text: 'text-neutral-100',
		label: 'В проживании',
	},
	checked_out: {
		bg: 'bg-neutral-300 hover:bg-neutral-400',
		text: 'text-neutral-700',
		label: 'Выехал',
	},
	cancelled: {
		bg: 'bg-neutral-200 line-through hover:bg-neutral-300',
		text: 'text-neutral-500',
		label: 'Отменена',
	},
	no_show: {
		bg: 'bg-yellow-500 hover:bg-yellow-600',
		text: 'text-yellow-950',
		label: 'Не заехал',
	},
}

export function styleFor(status: BookingStatus): CellStyle {
	return BOOKING_CELL_STYLES[status]
}
