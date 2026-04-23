import type { Booking } from '@horeca/shared'
import { diffDays } from './date-range.ts'

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
