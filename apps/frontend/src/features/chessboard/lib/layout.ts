import type { Booking } from '@horeca/shared'
import { diffDays } from './date-range.ts'

/**
 * Sticky row-header column width (px). Single source of truth — consumed by:
 *   - `chessboard.tsx` `gridTemplateColumns` (label track)
 *   - `chessboard.tsx` `scrollPaddingLeft` (Ctrl+Home scroll-into-view padding)
 *   - `useFitWindowDays` default `rowHeaderWidth` (fit-mode math).
 *
 * Pre-G11 v3.3 fix (2026-05-18) all 3 sites duplicated `180` literal. Per
 * `[[no-half-measures]]` DRY canon + agent research recommendation после
 * «По экрану» fit-mode label-wrap bug — extract.
 *
 * NOTE: track-sizing uses `minmax(180px, 180px)` (not bare `180px`) so the
 * Chrome 130+ + `@container` query host constrained-context algorithm does
 * not collapse this track to min-content. Per CSS Grid Layout Module Level 2
 * §11 «Track Sizing Algorithm» step 4 — fixed-pixel tracks are treated as
 * flexible minimums when container tight. `minmax(N, N)` is the explicit
 * non-flexible-pin pattern (iShadeed «A Deep Dive Into CSS Grid minmax()»
 * + MDN 2026 canon).
 */
export const ROW_HEADER_WIDTH = 180

/**
 * Day column minimum width (px). 40px floor is the Bnovo/Mews/Apaleo SMB
 * shahmatka canon (operator can still read 2-character date headers «18»
 * + status colour band). `useFitWindowDays` uses this к compute fit-mode
 * column count.
 *
 * NOTE: track-sizing для day columns uses `minmax(0, 1fr)` (NOT
 * `minmax(40px, 1fr)`) per agent research 2026-05-18. The JS fit math
 * (`useFitWindowDays`) already enforces 40px floor by construction —
 * adding а CSS-level 40px minimum was double-defence and counterproductive:
 * sub-pixel rounding could push total above container → 180px track
 * collapsed. Canonical Safari/WebKit 1fr-collapse fix per weblogtrips
 * 2026 «Why Your CSS Grid Layout is Breaking on Mobile Safari».
 */
export const DAY_COLUMN_MIN_WIDTH = 40

/**
 * Compute a booking's band position in the grid.
 *
 * Nights are `[checkIn, checkOut)` — checkout day is FREE (guest leaves
 * morning of checkout, room available same evening). Band covers
 * `checkIn` through `checkOut - 1` inclusive.
 *
 * Returns `null` when booking is fully outside the window or has zero
 * nights (shouldn't happen per backend validation but defensive).
 *
 * `colStart` / `colEnd` are 0-based indices into the date columns
 * (exclusive end), clipped to the window so bands extending beyond
 * `windowTo` are truncated rather than over-rendered.
 */
interface BandPosition {
	readonly colStart: number
	readonly colEnd: number
	readonly truncatedLeft: boolean
	readonly truncatedRight: boolean
}

export function bandPosition(
	booking: Pick<Booking, 'checkIn' | 'checkOut'>,
	windowFrom: string,
	windowTo: string,
): BandPosition | null {
	const lastNight = addDaysIso(booking.checkOut, -1)
	if (lastNight < booking.checkIn) return null
	if (lastNight < windowFrom) return null
	if (booking.checkIn > windowTo) return null

	const clippedStart = booking.checkIn < windowFrom ? windowFrom : booking.checkIn
	const clippedEnd = lastNight > windowTo ? windowTo : lastNight

	return {
		colStart: diffDays(windowFrom, clippedStart),
		colEnd: diffDays(windowFrom, clippedEnd) + 1,
		truncatedLeft: booking.checkIn < windowFrom,
		truncatedRight: lastNight > windowTo,
	}
}

function addDaysIso(iso: string, delta: number): string {
	const d = new Date(`${iso}T12:00:00Z`)
	d.setUTCDate(d.getUTCDate() + delta)
	return d.toISOString().slice(0, 10)
}
