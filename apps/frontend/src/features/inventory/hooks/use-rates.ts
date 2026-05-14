/**
 * Rates — TanStack Query hooks for the inventory pricing surface.
 *
 * Endpoints:
 *   - `GET    /api/v1/rate-plans/:ratePlanId/rates?from&to` — list range
 *   - `POST   /api/v1/rate-plans/:ratePlanId/rates`          — bulk upsert
 *
 * Pricing UX uses a fixed 90-day display window (today..+89), matching the
 * onboarding seed window (`106bf63 RATE_SEED_DAYS`). Operator can scroll
 * forward later but v1 ships single-window view per «golden middle» canon.
 */
import type { Rate, RateBulkUpsertInput } from '@horeca/shared'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export const ratesQueryKey = (ratePlanId: string, from: string, to: string) =>
	['inventory', 'rates', { ratePlanId, from, to }] as const

export const ratesRangeQueryOptions = (ratePlanId: string, from: string, to: string) =>
	queryOptions({
		queryKey: ratesQueryKey(ratePlanId, from, to),
		queryFn: async (): Promise<Rate[]> => {
			const res = await api.api.v1['rate-plans'][':ratePlanId'].rates.$get({
				param: { ratePlanId },
				query: { from, to },
			})
			if (!res.ok) throw new Error(`rates.list HTTP ${res.status}`)
			const body = (await res.json()) as { data: Rate[] }
			return body.data
		},
		staleTime: 30_000,
	})

export function useBulkUpsertRates() {
	const queryClient = useQueryClient()
	return useMutation<Rate[], Error, { ratePlanId: string; input: RateBulkUpsertInput }>({
		mutationFn: async ({ ratePlanId, input }) => {
			const res = await api.api.v1['rate-plans'][':ratePlanId'].rates.$post({
				param: { ratePlanId },
				json: input,
			})
			if (!res.ok) throw new Error(`rates.bulkUpsert HTTP ${res.status}`)
			const body = (await res.json()) as { data: Rate[] }
			return body.data
		},
		onSuccess: () => {
			// Invalidate all rate-window caches; the Шахматка / inventory page
			// both reread via the same prefix.
			void queryClient.invalidateQueries({ queryKey: ['inventory', 'rates'] })
		},
	})
}

/** Build YYYY-MM-DD for `today + offset` days (local TZ, MSK для Сочи). */
export function isoDateOffset(offset: number): string {
	const d = new Date()
	d.setHours(0, 0, 0, 0)
	d.setDate(d.getDate() + offset)
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}

/**
 * Generate ALL ISO dates в [from..to] inclusive whose JS `getDay()` is в
 * the allowed set. JS `getDay()`: 0=Sun, 1=Mon, ..., 6=Sat. RU canon
 * displays Monday first so caller maps 0..6 → ПН..ВС before passing here.
 */
export function generateDatesInRange(
	from: string,
	to: string,
	allowedDow: ReadonlySet<number>,
): string[] {
	const out: string[] = []
	const start = new Date(`${from}T00:00:00`)
	const end = new Date(`${to}T00:00:00`)
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out
	for (let d = new Date(start); d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
		if (allowedDow.has(d.getDay())) {
			const y = d.getFullYear()
			const m = String(d.getMonth() + 1).padStart(2, '0')
			const day = String(d.getDate()).padStart(2, '0')
			out.push(`${y}-${m}-${day}`)
		}
	}
	return out
}
