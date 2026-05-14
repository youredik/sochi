/**
 * Rate-plans — TanStack Query hooks for the inventory admin surface.
 *
 * Endpoints:
 *   - `GET    /api/v1/properties/:propertyId/rate-plans` — list, optional ?roomTypeId
 *   - `POST   /api/v1/rate-plans`                         — create (roomTypeId в body)
 *   - `PATCH  /api/v1/rate-plans/:id`                     — update
 *   - `DELETE /api/v1/rate-plans/:id`                     — delete
 *
 * Schema canon: `ratePlanCreateInput` enforces «refundable → cancellationHours
 * obligatory» + «code uppercase ASCII + dash/underscore». UI mirrors both:
 * cancellationHours field appears когда `isRefundable=true`, и code input
 * upper-cases on blur.
 */
import type { RatePlan, RatePlanCreateInput } from '@horeca/shared'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export const ratePlansQueryKey = (propertyId: string) =>
	['inventory', 'rate-plans', { propertyId }] as const

export const ratePlansQueryOptions = (propertyId: string) =>
	queryOptions({
		queryKey: ratePlansQueryKey(propertyId),
		queryFn: async (): Promise<RatePlan[]> => {
			const res = await api.api.v1.properties[':propertyId']['rate-plans'].$get({
				param: { propertyId },
				query: { includeInactive: 'false' },
			})
			if (!res.ok) throw new Error(`rate-plans.list HTTP ${res.status}`)
			const body = (await res.json()) as { data: RatePlan[] }
			return body.data
		},
		staleTime: 30_000,
	})

export function useCreateRatePlan(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation<RatePlan, Error, RatePlanCreateInput>({
		mutationFn: async (input) => {
			const res = await api.api.v1['rate-plans'].$post({ json: input })
			if (!res.ok) throw new Error(`rate-plans.create HTTP ${res.status}`)
			const body = (await res.json()) as { data: RatePlan }
			return body.data
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ratePlansQueryKey(propertyId) })
		},
	})
}

// Edit / delete / set-default hooks live в Phase III.bis when the UI
// surfaces them (knip «no premature exports» canon).
