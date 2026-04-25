/**
 * Pure functions for the night-audit (per-night accommodation auto-posting).
 *
 * Кано́н 2026 (Apaleo / Cloudbeds / Mews):
 *   - Accommodation lines posted **once per business date** for each `in_house`
 *     booking, never at check-in (eager) or check-out (lazy). Per-night model
 *     enables clean revenue recognition + mid-stay folio splits.
 *   - **Business date** is the date assigned to operations occurring before the
 *     night-audit cutoff. Sochi default: 03:00 Europe/Moscow. Wall-clock
 *     [00:00, 03:00] MSK is still YESTERDAY's business date.
 *   - **Window**: post for each `date ∈ [checkIn, min(businessDate, checkOut-1)]`.
 *     `checkOut` itself is NEVER charged (the night BEFORE checkout is the last
 *     billable night).
 *   - **Idempotency**: deterministic folioLine ID (`audit_<folioId>_<YYYYMMDD>`)
 *     so re-runs collide on PK / UPSERT same content. Catch-up pass on boot
 *     is safe.
 *
 * MSK is **fixed UTC+3 with no DST** since 2014, so timezone math here uses a
 * static offset — no Intl/timezone DB needed. If we ever expand to a tenant
 * outside MSK, swap to a tz-aware lib (`@date-fns/tz` or `Temporal` once Node
 * ships it stable).
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000 // UTC+3, no DST

/**
 * Compute the current business date for a given wall-clock instant, given a
 * cutoff hour in MSK local time.
 *
 * @example
 *   // 01:30 UTC = 04:30 MSK on 04-26 → after 03:00 cutoff → 04-26.
 *   businessDate(new Date('2026-04-26T01:30:00Z'), 3) === '2026-04-26'
 *
 *   // 23:30 UTC on 04-25 = 02:30 MSK on 04-26 → before 03:00 cutoff → still 04-25.
 *   businessDate(new Date('2026-04-25T23:30:00Z'), 3) === '2026-04-25'
 *
 * Anti-pattern: using server-local time. Use UTC arithmetic + MSK offset.
 */
export function businessDate(now: Date, cutoffHourMsk: number = 3): string {
	if (cutoffHourMsk < 0 || cutoffHourMsk > 23) {
		throw new RangeError(`cutoffHourMsk must be 0–23, got ${cutoffHourMsk}`)
	}
	// Shift wall-clock into MSK so getUTCHours returns MSK hours.
	const msk = new Date(now.getTime() + MSK_OFFSET_MS)
	if (msk.getUTCHours() < cutoffHourMsk) {
		msk.setUTCDate(msk.getUTCDate() - 1)
	}
	return toIsoDate(msk)
}

/**
 * Compute the list of dates for which `accommodation` lines should be posted
 * for a booking, given the audit horizon `upToBusinessDate`.
 *
 * Per Apaleo canon: only when `status === 'in_house'` AND
 *   `checkIn <= date < checkOut` AND `date <= upToBusinessDate`.
 *
 * Returns an EMPTY array (not null) for every "skip" reason:
 *   - status !== 'in_house' (confirmed / cancelled / no_show / checked_out)
 *   - business date is before checkIn
 *   - booking already fully audited (last night already posted)
 *
 * Returned dates are ascending YYYY-MM-DD, no duplicates.
 */
export function nightsToAudit(
	booking: { status: string; checkIn: string; checkOut: string },
	upToBusinessDate: string,
): string[] {
	if (booking.status !== 'in_house') return []
	if (booking.checkIn >= booking.checkOut) return [] // defensive: invalid range
	const horizon =
		upToBusinessDate < booking.checkOut ? upToBusinessDate : addDays(booking.checkOut, -1)
	if (horizon < booking.checkIn) return []
	const dates: string[] = []
	let cursor = booking.checkIn
	while (cursor <= horizon) {
		dates.push(cursor)
		cursor = addDays(cursor, 1)
	}
	return dates
}

/**
 * Deterministic folioLine ID for a given (folioId, businessDate) pair. PK
 * collision = idempotency. Format: `audit_<folioId>_<YYYYMMDD>`. Folio IDs
 * are 30-char prefixed ULIDs (`fol_…`); plus `audit_` prefix + `_` + 8-char
 * date keeps total length within reasonable Utf8 bounds (<64 chars).
 */
export function nightAuditLineId(folioId: string, date: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`nightAuditLineId: date must be YYYY-MM-DD, got "${date}"`)
	}
	return `audit_${folioId}_${date.replace(/-/g, '')}`
}

/**
 * Resolve per-night gross amount in **minor units** (kopecks for RUB) for the
 * given business date by looking it up in the booking's `timeSlices` snapshot.
 *
 * Returns `null` if no slice covers that date — caller should skip the night
 * (corrupt / partial-snapshot booking; flag in logs, не throw).
 *
 * Conversion: stored as `grossMicros` (×10^6 of base currency). Per-night
 * minor = micros / 10_000 (1 RUB = 1_000_000 micros = 100 копеек).
 */
export function priceMinorForDate(
	timeSlices: ReadonlyArray<{ date: string; grossMicros: bigint }>,
	date: string,
): bigint | null {
	const slice = timeSlices.find((s) => s.date === date)
	if (!slice) return null
	return slice.grossMicros / 10_000n
}

/* ----------------------------------------------------------------- helpers */

/** YYYY-MM-DD ↔ Date in UTC. Handles negative deltas + month/year rollover. */
export function addDays(date: string, delta: number): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`addDays: date must be YYYY-MM-DD, got "${date}"`)
	}
	const d = new Date(`${date}T00:00:00Z`)
	d.setUTCDate(d.getUTCDate() + delta)
	return toIsoDate(d)
}

function toIsoDate(d: Date): string {
	return d.toISOString().slice(0, 10)
}
