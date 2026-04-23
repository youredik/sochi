/**
 * Pure date-range helpers for the reservation grid.
 *
 * ISO `YYYY-MM-DD` strings throughout — matches backend `dateSchema`
 * (@horeca/shared) byte-for-byte and avoids Date-TZ mishaps when
 * iterating across DST boundaries. All operations are UTC-anchored;
 * timezones are presentation-layer only (property.timezone decides
 * "what day is it now" in user copy, never in grid indexing).
 */

const MS_PER_DAY = 86_400_000

export function parseDate(iso: string): Date {
	// Anchor at UTC noon to avoid TZ edge cases (e.g. DST shift creating
	// a 23-hour day in local time → iteration skips a day).
	return new Date(`${iso}T12:00:00Z`)
}

function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
	const d = parseDate(iso)
	d.setUTCDate(d.getUTCDate() + days)
	return formatDate(d)
}

export function diffDays(fromIso: string, toIso: string): number {
	return Math.round((parseDate(toIso).getTime() - parseDate(fromIso).getTime()) / MS_PER_DAY)
}

/**
 * Inclusive range [from, to] expanded to array. Max 365 days guard
 * mirrors the server's availabilityBulkUpsertInput cap — any caller
 * passing wider needs to chunk, not silently truncate.
 */
export function iterateDates(fromIso: string, toIso: string): string[] {
	const count = diffDays(fromIso, toIso) + 1
	if (count < 1) return []
	if (count > 365) {
		throw new Error(`iterateDates: range too wide (${count} days, max 365)`)
	}
	const out: string[] = []
	for (let i = 0; i < count; i++) out.push(addDays(fromIso, i))
	return out
}

export function todayIso(): string {
	return formatDate(new Date())
}

/** Check if `iso` is strictly before / equal / after today (UTC). */
export function compareToToday(iso: string): 'past' | 'today' | 'future' {
	const t = todayIso()
	if (iso < t) return 'past'
	if (iso > t) return 'future'
	return 'today'
}
