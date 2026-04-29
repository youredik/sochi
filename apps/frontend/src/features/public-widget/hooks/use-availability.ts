/**
 * `useAvailability` — TanStack Query hook for Screen 1 search-and-pick.
 *
 * Per plan §M9.widget.2 + cache canon §3.4: staleTime 30s — fresh enough for
 * 5-min booking-flow window, no constant refetch flooding backend.
 *
 * Returns null cleanly when API returns 404 (unknown tenant/property).
 * Throws WidgetApiInputError on 422 (invalid date range / out-of-bounds guests)
 * — caller renders that как user-facing message.
 */
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import {
	type AvailabilityQuery,
	fetchAvailability,
	type PublicAvailabilityResponse,
} from '../lib/widget-api.ts'

export interface UseAvailabilityOptions {
	readonly enabled?: boolean
}

export function useAvailability(
	q: AvailabilityQuery,
	options: UseAvailabilityOptions = {},
): UseQueryResult<PublicAvailabilityResponse | null, Error> {
	return useQuery({
		queryKey: [
			'public-widget',
			'availability',
			q.tenantSlug,
			q.propertyId,
			q.checkIn,
			q.checkOut,
			q.adults,
			q.children,
		],
		queryFn: () => fetchAvailability(q),
		staleTime: 30_000,
		gcTime: 5 * 60_000,
		// Don't auto-refetch on window focus — booking flow shouldn't reset
		// search-results на caps lock-style triggers. М9.widget.4 commits will
		// re-fetch availability как part of stale-cache mismatch detection.
		refetchOnWindowFocus: false,
		retry: 1,
		enabled: options.enabled ?? true,
	})
}
