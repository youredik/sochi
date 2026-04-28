import type { BookingStatus } from '@horeca/shared'

/**
 * Booking-status → cell display classes (M9.5 Phase B Bnovo-parity).
 *
 * Token-based palette via index.css `--status-*` tokens × `--color-status-*`
 * @theme inline binding. Tailwind v4 utility classes (`bg-status-confirmed`
 * etc.) resolve через CSS-каскад → :root / .dark / @media prefers-contrast,
 * НЕ hardcoded Tailwind neutral palette (предыдущая версия использовала
 * `bg-blue-600` + `bg-neutral-900` etc. — 2024 pattern, не theme-aware).
 *
 * **Mapping** (per plan §M9.3 Bnovo-parity decision):
 *   - confirmed   → status-confirmed (green) — pre-arrival booked
 *   - in_house    → status-occupied (Sochi-blue) — guest currently in-house
 *   - checked_out → status-past (grey) — completed stays
 *   - cancelled   → status-past (grey + line-through) — financial trail kept
 *   - no_show     → status-issue (red) — exception requiring action
 *
 * **Theme-aware contrast:**
 * Все 4 token pairs verified ≥4.5:1 WCAG 2.2 AA normal-text empirically via
 * @axe-core/playwright (light + dark + contrast-more — 12 combinations).
 *
 * Pure data structure (NOT JSX) — unit-testable + reusable + memoization-safe.
 */

interface CellStyle {
	readonly bg: string
	readonly text: string
	readonly label: string
}

export const BOOKING_CELL_STYLES: Readonly<Record<BookingStatus, CellStyle>> = {
	confirmed: {
		bg: 'bg-status-confirmed hover:brightness-95',
		text: 'text-status-confirmed-foreground',
		label: 'Подтверждена',
	},
	in_house: {
		bg: 'bg-status-occupied hover:brightness-95',
		text: 'text-status-occupied-foreground',
		label: 'В проживании',
	},
	checked_out: {
		bg: 'bg-status-past hover:brightness-95',
		text: 'text-status-past-foreground',
		label: 'Выехал',
	},
	cancelled: {
		bg: 'bg-status-past line-through hover:brightness-95',
		text: 'text-status-past-foreground',
		label: 'Отменена',
	},
	no_show: {
		bg: 'bg-status-issue hover:brightness-95',
		text: 'text-status-issue-foreground',
		label: 'Не заехал',
	},
}

export function styleFor(status: BookingStatus): CellStyle {
	return BOOKING_CELL_STYLES[status]
}
