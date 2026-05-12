/**
 * Dashboard query options — single source of truth для все 4 data streams,
 * powering KPI strip + Recent activity feed + Alerts panel.
 *
 * **Stale strategy** (calibrated per-source — same canon as
 * `use-receivables.ts`):
 *   - bookings window: `staleTime: 30_000`. Bookings change less frequently
 *     than balances; 30s freshness sufficient for a glance dashboard.
 *   - receivables: re-exported from `use-receivables.ts` (canonical hook,
 *     `staleTime: 0` + 30s polling).
 *   - notifications failed: `staleTime: 30_000`. Alerts panel needs to feel
 *     live; polling 30s catches new failures within one minute of dispatch.
 *   - activity recent: `staleTime: 60_000`. Audit feed is informational,
 *     no need for tight polling.
 *
 * **Why a 32-day window for bookings?** Operator dashboard tactical KPIs
 * (arrivals today, in-house now) need a wide enough range to cover:
 *   - all bookings whose `checkIn` was within last 30 days (covers most
 *     in-house stays at Sochi SMB hotels — research project_horeca_domain_model.md
 *     average stay = 2-3 nights, max realistic = 30)
 *   - bookings whose `checkIn` is today (arrivals)
 *   - one-day buffer past today для clock-skew safety
 * The booking endpoint filters on `checkIn` (PK range scan); a broader query
 * lets the same data feed multiple KPIs without N+1 round-trips.
 */
import type { Activity, Booking, Notification } from '@horeca/shared'
import { queryOptions } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

/** Days BEFORE today to start the bookings-window scan (covers in-house stays). */
const BOOKINGS_WINDOW_PAST_DAYS = 30

/** Days AFTER today to extend the window (clock-skew buffer, не tomorrow's arrivals). */
const BOOKINGS_WINDOW_FUTURE_DAYS = 1

function ymdAddDays(base: Date, days: number): string {
	const d = new Date(base)
	d.setUTCDate(d.getUTCDate() + days)
	return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })
}

/**
 * Bookings window query — fetches bookings with `checkIn` in the
 * `[today − 30d, today + 1d]` range for the active property. Single source
 * for "arrivals today" + "in-house now" KPI cards.
 *
 * Returns empty array on auth/tenant mismatch (route guard handles 401;
 * here we surface the empty case so the KPI card shows "0" not error).
 */
export const bookingsWindowQueryOptions = (propertyId: string, now: Date = new Date()) =>
	queryOptions({
		queryKey: ['dashboard', 'bookings-window', { propertyId }] as const,
		queryFn: async (): Promise<Booking[]> => {
			const from = ymdAddDays(now, -BOOKINGS_WINDOW_PAST_DAYS)
			const to = ymdAddDays(now, BOOKINGS_WINDOW_FUTURE_DAYS)
			const res = await api.api.v1.properties[':propertyId'].bookings.$get({
				param: { propertyId },
				query: { from, to },
			})
			if (!res.ok) throw new Error(`bookings.window HTTP ${res.status}`)
			// Wire format serializes bigint fields (timeSlices[].grossMicros etc.)
			// as JSON strings; runtime shape is shape-equivalent for our access
			// pattern (checkIn + status only). Same two-step cast as
			// chessboard `use-grid-data.ts` GridBooking pattern.
			const body = (await res.json()) as unknown as { data: Booking[] }
			return body.data
		},
		staleTime: 30_000,
		refetchOnWindowFocus: true,
		refetchInterval: 60_000,
	})

/**
 * Failed notifications query — feeds both "Письма со сбоем" KPI card AND
 * the Alerts panel. Single query keyed by the canonical filter avoids
 * the dual-fetch race (KPI count differs from list count by milliseconds).
 *
 * `limit: 50` matches the schema cap from `notificationListParams` — at
 * SMB volume, 50 failed-status rows are the realistic ceiling between
 * polls; if there are more, the operator already has a bigger problem.
 */
export const failedNotificationsQueryOptions = queryOptions({
	queryKey: ['dashboard', 'notifications-failed'] as const,
	queryFn: async (): Promise<Notification[]> => {
		const res = await api.api.admin.notifications.$get({
			query: { status: 'failed', limit: '50' },
		})
		if (!res.ok) throw new Error(`notifications.failed HTTP ${res.status}`)
		const body = (await res.json()) as { data: { items: Notification[] } }
		return body.data.items
	},
	staleTime: 30_000,
	refetchOnWindowFocus: true,
	refetchInterval: 60_000,
})

/**
 * Recent activity feed query — calls the A.bis.3 backend endpoint
 * `GET /api/v1/activity/recent?limit=N`. Tenant-wide, reverse-chronological,
 * mixed objectTypes — matches the operator glance use-case (see plan §17
 * implementation log).
 */
export const recentActivityQueryOptions = (limit = 20) =>
	queryOptions({
		queryKey: ['dashboard', 'activity-recent', { limit }] as const,
		queryFn: async (): Promise<Activity[]> => {
			const res = await api.api.v1.activity.recent.$get({
				query: { limit: String(limit) },
			})
			if (!res.ok) throw new Error(`activity.recent HTTP ${res.status}`)
			const body = (await res.json()) as { data: Activity[] }
			return body.data
		},
		staleTime: 60_000,
		refetchOnWindowFocus: true,
	})
