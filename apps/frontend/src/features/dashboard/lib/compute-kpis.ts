/**
 * Pure KPI compute helpers for the operator dashboard (A.bis.3).
 *
 * Derives glance-affordance numbers from the raw API rows fetched by
 * `use-dashboard-data.ts`. Pure functions ONLY — no React, no fetch, no Date
 * mutation; all "today" comparisons take an explicit `today` arg so tests can
 * pin time deterministically.
 *
 * Per `feedback_strict_tests.md`:
 *   - Exact-value asserts in tests, NOT `.toBeGreaterThan(0)`
 *   - Empty / null / boundary inputs covered
 *   - Mutation gates: change `<` to `<=` in arrivals filter trips the test
 *
 * Per `project_dashboard_external.md`: ADR / RevPAR / occupancy-trend NOT
 * computed here — those are Yandex DataLens external. This module only
 * surfaces what the operator needs at-a-glance from existing PMS state.
 */
import type { Booking, Folio, Notification } from '@horeca/shared'

/**
 * YYYY-MM-DD in Europe/Moscow timezone — what the booking domain stores
 * for checkIn / checkOut (date-only strings, NOT timestamps).
 *
 * Sochi PMS = Moscow timezone (UTC+3, no DST). Using `toLocaleDateString` с
 * explicit `Europe/Moscow` keeps "today" deterministic across server / CI
 * runners that may be in different TZs (CI containers usually UTC).
 *
 * `en-CA` locale because its date format is ISO-style "YYYY-MM-DD" — same
 * shape as booking.checkIn / booking.checkOut from the API.
 */
export function todayInMoscow(now: Date = new Date()): string {
	return now.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })
}

/**
 * Count bookings whose `checkIn === today` AND status is "still-arriving"
 * (i.e. `confirmed` or `in_house` — the latter covers same-day check-ins
 * that have already arrived). `cancelled`, `no_show`, `checked_out` excluded
 * because they're not arrivals from the operator's glance perspective.
 */
export function countArrivalsToday(bookings: readonly Booking[], today: string): number {
	return bookings.filter(
		(b) => b.checkIn === today && (b.status === 'confirmed' || b.status === 'in_house'),
	).length
}

/**
 * Count bookings currently `in_house` (state-machine status, not a date
 * computation). Source of truth IS the status field — confirmed bookings
 * that should be in_house but haven't been checked-in yet are explicitly
 * NOT counted (they show up in arrivals-today instead).
 */
export function countInHouseNow(bookings: readonly Booking[]): number {
	return bookings.filter((b) => b.status === 'in_house').length
}

/**
 * Sum of `balanceMinor` across receivables — Int64 minor units (kopecks).
 *
 * `Folio.balanceMinor` is shipped as a JSON string (decimal-serialized bigint
 * per backend convention — YDB lacks Decimal so amounts are Int64 in micros
 * / kopecks and stringified for JSON). We `BigInt(s)` each row before adding
 * to keep precision intact at any scale (cumulative balances can exceed
 * Number.MAX_SAFE_INTEGER at small-fleet scale × long horizon).
 *
 * Adversarial: empty array returns exact `0n` (NOT undefined / NaN).
 */
export function sumOpenBalanceMinor(receivables: readonly Folio[]): bigint {
	return receivables.reduce((acc, f) => acc + BigInt(f.balanceMinor), 0n)
}

/**
 * Count notifications с status === 'failed'. Surfaces in two places:
 *   - "Письма со сбоем" KPI card (operator at-a-glance count)
 *   - Alerts panel (each row clickable to /admin/notifications)
 *
 * Server endpoint `/api/admin/notifications?status=failed` already filters,
 * but we re-filter defensively (caller may pass list from different source).
 */
export function countFailedNotifications(notifications: readonly Notification[]): number {
	return notifications.filter((n) => n.status === 'failed').length
}
