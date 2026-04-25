/**
 * Receivables dashboard queries — TanStack Query 5.100 canonical patterns
 * per memory `project_m6_7_frontend_research.md`.
 *
 * **Query keys:**
 *   - `['properties']` — список properties tenant-а (используется и в route guard)
 *   - `['receivables', { propertyId }]` — список фолио с balanceMinor > 0
 *
 * **Stale strategy:**
 *   - properties: `staleTime: 30_000` (редко меняются)
 *   - receivables: `staleTime: 0` + `refetchOnWindowFocus: true` +
 *     `refetchInterval: 30_000` — балансы меняются от платежей/refunds.
 *     Polling 30s достаточно (не критическая real-time витрина).
 */
import type { Folio, Property } from '@horeca/shared'
import { queryOptions } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export const propertiesQueryOptions = queryOptions({
	queryKey: ['properties'] as const,
	queryFn: async (): Promise<Property[]> => {
		const res = await api.api.v1.properties.$get({ query: {} })
		if (!res.ok) throw new Error(`properties.list HTTP ${res.status}`)
		const body = (await res.json()) as { data: Property[] }
		return body.data
	},
	staleTime: 30_000,
})

export const receivablesQueryOptions = (propertyId: string) =>
	queryOptions({
		queryKey: ['receivables', { propertyId }] as const,
		queryFn: async (): Promise<Folio[]> => {
			const res = await api.api.v1.properties[':propertyId'].folios.receivables.$get({
				param: { propertyId },
			})
			if (!res.ok) throw new Error(`receivables.list HTTP ${res.status}`)
			const body = (await res.json()) as { data: Folio[] }
			return body.data
		},
		staleTime: 0,
		refetchOnWindowFocus: true,
		refetchInterval: 30_000,
	})
