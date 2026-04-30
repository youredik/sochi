/**
 * `useAddons` — TanStack Query hook для Screen 2 (Extras / Addons).
 *
 * Per `plans/m9_widget_canonical.md` §3:
 *   - staleTime 5min — addon catalog меняется редко (operator updates rare).
 *   - 404 → null (UI shows graceful empty-state).
 *   - Backend pre-filters isActive/isMandatory/inventoryMode (Round 2 verified).
 */
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { fetchAddons, type PublicWidgetAddonsView } from '../lib/widget-api.ts'

export interface UseAddonsOptions {
	readonly enabled?: boolean
}

export function useAddons(
	tenantSlug: string,
	propertyId: string,
	options: UseAddonsOptions = {},
): UseQueryResult<PublicWidgetAddonsView | null, Error> {
	return useQuery({
		queryKey: ['public-widget', 'addons', tenantSlug, propertyId],
		queryFn: () => fetchAddons(tenantSlug, propertyId),
		staleTime: 5 * 60_000,
		gcTime: 30 * 60_000,
		refetchOnWindowFocus: false,
		retry: 1,
		enabled: options.enabled ?? true,
	})
}
