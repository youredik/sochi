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
	// All combinations verified ≥4.5:1 WCAG 2.2 AA normal-text (empirically
	// via @axe-core/playwright 2026-04-24). bg-blue-500 / text-white was
	// 3.76:1 (fail); bg-neutral-200 / text-neutral-500 was 3.5:1 (fail).
	// Both bumped to AA-compliant variants below.
	confirmed: {
		bg: 'bg-blue-600 hover:bg-blue-700', // blue-600 #155dfc / white = 5.43:1 ✓
		text: 'text-white',
		label: 'Подтверждена',
	},
	in_house: {
		bg: 'bg-neutral-900 hover:bg-neutral-800', // ~16:1 ✓
		text: 'text-neutral-100',
		label: 'В проживании',
	},
	checked_out: {
		bg: 'bg-neutral-300 hover:bg-neutral-400', // ~5.5:1 ✓
		text: 'text-neutral-700',
		label: 'Выехал',
	},
	cancelled: {
		bg: 'bg-neutral-200 line-through hover:bg-neutral-300',
		text: 'text-neutral-700', // neutral-700 #404040 on neutral-200 #e5e5e5 = 7:1 ✓
		label: 'Отменена',
	},
	no_show: {
		bg: 'bg-yellow-500 hover:bg-yellow-600',
		text: 'text-yellow-950', // yellow-950 on yellow-500 ~6:1 ✓
		label: 'Не заехал',
	},
}

export function styleFor(status: BookingStatus): CellStyle {
	return BOOKING_CELL_STYLES[status]
}
