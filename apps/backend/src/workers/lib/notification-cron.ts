/**
 * Pure helpers for cron-driven notification triggers (M7.B.3).
 *
 * Per research synthesis 2026-04-26 §5 + §6:
 *   - **checkin_reminder**: 24h до checkIn, fires в 18:00 МСК (peak open
 *     time для RU consumer-segment). Apaleo / Cloudbeds canon — single
 *     reminder, не 48+24+2 (annoys guests).
 *   - **review_request**: 24h после checkOut, fires в 11:00 МСК. Skip
 *     для status='cancelled' / 'no_show' (нет визита = нет experience).
 *
 * Both use deterministic dedup key:
 *   `booking:<bookingId>:checkin_reminder`
 *   `booking:<bookingId>:review_request`
 *
 * UNIQUE on `(tenantId, sourceEventDedupKey)` уже даёт idempotency — re-run
 * cron в тот же час не создаст дубль.
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000 // UTC+3, no DST

/**
 * Returns true if the given wall-clock instant is within the firing window
 * for an hourly cron at the specified MSK hour. Window = [hour:00, hour:59].
 *
 * The cron schedule '0 * * * *' fires at the top of each hour; this guard
 * keeps the worker idempotent if the cron fires twice in the same hour
 * (unusual but defensive).
 */
export function isInMskHour(now: Date, hourMsk: number): boolean {
	if (!Number.isInteger(hourMsk) || hourMsk < 0 || hourMsk > 23) {
		throw new RangeError(`hourMsk must be 0–23 integer, got ${hourMsk}`)
	}
	const msk = new Date(now.getTime() + MSK_OFFSET_MS)
	return msk.getUTCHours() === hourMsk
}

/**
 * Compute the YYYY-MM-DD date in MSK that is `daysFromToday` days from the
 * MSK calendar day of `now`. Positive → future, negative → past.
 *
 * Examples (assuming `now = 2026-04-26T15:00:00Z` = 18:00 МСК on 04-26):
 *   `mskDateOffset(now, 1)` → '2026-04-27'  (tomorrow's MSK calendar day)
 *   `mskDateOffset(now, -1)` → '2026-04-25' (yesterday)
 *   `mskDateOffset(now, 0)`  → '2026-04-26'
 */
export function mskDateOffset(now: Date, daysFromToday: number): string {
	if (!Number.isInteger(daysFromToday)) {
		throw new RangeError(`daysFromToday must be integer, got ${daysFromToday}`)
	}
	const msk = new Date(now.getTime() + MSK_OFFSET_MS)
	msk.setUTCDate(msk.getUTCDate() + daysFromToday)
	return msk.toISOString().slice(0, 10)
}

/**
 * Decide whether a booking is eligible for a checkin_reminder notification.
 *
 *   - status MUST be 'confirmed' or 'in_house' (visitor still expected;
 *     cancelled / no_show / checked_out are out of scope)
 *   - checkIn date MUST equal `tomorrowMsk` (24h ahead)
 *   - guest must have an email recipient (caller resolves)
 *
 * Returns true if all conditions met.
 */
export function isCheckinReminderEligible(
	booking: { status: string; checkIn: string },
	tomorrowMsk: string,
): boolean {
	if (booking.status !== 'confirmed' && booking.status !== 'in_house') return false
	return booking.checkIn === tomorrowMsk
}

/**
 * Decide whether a booking is eligible for a review_request notification.
 *
 *   - status MUST be 'checked_out' (visitor completed stay; cancelled /
 *     no_show have NO experience to review — borderline-spam if sent)
 *   - checkOut date MUST equal `yesterdayMsk` (24h after — gives guest
 *     evening time at home to reflect)
 */
export function isReviewRequestEligible(
	booking: { status: string; checkOut: string },
	yesterdayMsk: string,
): boolean {
	if (booking.status !== 'checked_out') return false
	return booking.checkOut === yesterdayMsk
}
