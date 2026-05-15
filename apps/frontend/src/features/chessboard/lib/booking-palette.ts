import type { BookingStatus } from '@horeca/shared'

/**
 * Booking-status → cell display classes (M9.5 Phase B Bnovo-parity + G2
 * TravelLine 8-color canon extension 2026-05-15).
 *
 * Token-based palette via index.css `--status-*` tokens × `--color-status-*`
 * @theme inline binding. Tailwind v4 utility classes (`bg-status-confirmed`
 * etc.) resolve через CSS-каскад → :root / .dark / @media prefers-contrast,
 * НЕ hardcoded Tailwind neutral palette.
 *
 * **Mapping** (5 domain statuses + 2 UI-derived):
 *   - confirmed   → status-confirmed (green) — pre-arrival booked
 *   - in_house    → status-occupied (Sochi-blue) — guest currently in-house
 *   - checked_out → status-past (grey) — completed stays
 *   - cancelled   → status-past (grey + line-through) — financial trail kept
 *   - no_show     → status-issue (red) — exception requiring action
 *
 * **UI-derived states (computed in `paletteFor()`, NOT domain enum)**:
 *   - overdue     → status-issue (red) + label «Просрочена» — `checkIn <
 *                   today AND status='confirmed'`. Operator must check-in
 *                   ASAP OR mark no-show.
 *   - unassigned  → status-unassigned (turquoise/teal) — `assignedRoomId
 *                   === null AND status='confirmed'`. Operator must assign
 *                   a specific room ДО check-in.
 *
 * **TravelLine 8-color canon** (research май 2026 — RU staff trained on
 * this palette): Green direct / Yellow OTA / Purple in-house / Orange
 * checked-out / Red overdue / Turquoise unassigned / Grey OOO / Light-grey
 * filtered. Our mapping condenses domain semantically:
 *   - Direct + manual + OTA: same `confirmed` until check-in (channel-color
 *     differentiation deferred к G2.bis — separate visual layer, не bg)
 *   - Purple in-house = our occupied (blue) — Сочи-brand variant of in-house
 *   - Orange checked-out = our past — RU operators tolerate grey
 *   - Grey OOO maintenance = separate domain (G9 deferred — needs backend)
 *   - Light-grey filtered = UI filter state (separate concern)
 *
 * **Precedence rule (UI-derived ↓ domain)**: terminal statuses (cancelled /
 * checked_out / no_show) ALWAYS win — historical correctness over urgency
 * cues. For `confirmed`, overdue takes priority over unassigned (operator
 * action: check-in first, then assign room). For `in_house`, no derived
 * overrides — guest already in-house.
 *
 * **Theme-aware contrast** verified ≥4.5:1 WCAG 2.2 AA empirically via
 * @axe-core/playwright (light + dark + contrast-more — 12 combinations).
 * status-unassigned token added 2026-05-15 with same canon (4.5:1 AA
 * normal-text per `index.css` L=0.45 light / L=0.7 dark / L=0.4 + L=0.78
 * для contrast-more).
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

/**
 * UI-derived styles (NOT in domain BookingStatus enum). Same shape as
 * BOOKING_CELL_STYLES so `paletteFor()` returns a uniform CellStyle.
 *   - overdue reuses status-issue red token (semantically «action required»
 *     overlaps с no_show) — label distinguishes domain context.
 *   - unassigned uses new status-unassigned turquoise token (G2 addition).
 */
export const DERIVED_BOOKING_CELL_STYLES: Readonly<Record<'overdue' | 'unassigned', CellStyle>> = {
	overdue: {
		bg: 'bg-status-issue hover:brightness-95',
		text: 'text-status-issue-foreground',
		label: 'Просрочена',
	},
	unassigned: {
		bg: 'bg-status-unassigned hover:brightness-95',
		text: 'text-status-unassigned-foreground',
		label: 'Не распределена',
	},
}

export function styleFor(status: BookingStatus): CellStyle {
	return BOOKING_CELL_STYLES[status]
}

/**
 * `paletteFor` — derived palette computation. Combines domain status с
 * UI-derived overlays (overdue / unassigned) per TravelLine 8-color canon.
 *
 * Precedence (top-down — first match wins):
 *   1. Terminal status (cancelled / checked_out / no_show) → domain palette.
 *      Historical correctness over urgency cues.
 *   2. confirmed + checkIn < today → overdue (red) — operator urgency #1.
 *   3. confirmed + assignedRoomId == null → unassigned (turquoise) —
 *      operator urgency #2.
 *   4. confirmed (assigned, on-time) → domain palette (green).
 *   5. in_house → domain palette (blue). No derived overlay — guest already
 *      checked in, both checks irrelevant.
 *
 * Pure function — caller passes `todayIso` для testable date-comparison.
 */
export function paletteFor(ctx: {
	booking: {
		status: BookingStatus
		checkIn: string
		assignedRoomId?: string | null
	}
	todayIso: string
}): CellStyle {
	const { booking, todayIso } = ctx

	// Terminal statuses always win — domain correctness over UI urgency.
	if (
		booking.status === 'cancelled' ||
		booking.status === 'checked_out' ||
		booking.status === 'no_show'
	) {
		return BOOKING_CELL_STYLES[booking.status]
	}

	// In-house has no derived overlays (guest already checked in).
	if (booking.status === 'in_house') {
		return BOOKING_CELL_STYLES.in_house
	}

	// `confirmed` — apply UI-derived overlays (overdue > unassigned).
	if (booking.checkIn < todayIso) {
		return DERIVED_BOOKING_CELL_STYLES.overdue
	}
	if (booking.assignedRoomId == null) {
		return DERIVED_BOOKING_CELL_STYLES.unassigned
	}
	return BOOKING_CELL_STYLES.confirmed
}
