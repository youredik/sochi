import type { PropertyAmenityInput, PropertyAmenityRow } from '@horeca/shared'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'

export const amenitiesQueryOptions = (propertyId: string) =>
	queryOptions({
		queryKey: ['property', propertyId, 'amenities'] as const,
		queryFn: async (): Promise<PropertyAmenityRow[]> => {
			const res = await api.api.v1.properties[':propertyId'].amenities.$get({
				param: { propertyId },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: PropertyAmenityRow[] }
			return body.data
		},
		staleTime: 30_000,
	})

export function useAmenities(propertyId: string) {
	return useQuery(amenitiesQueryOptions(propertyId))
}

/**
 * Bulk replace — backend's PUT semantics. Server diffs against current set
 * and emits a single audit event. Conflict-free: passing the same payload
 * twice is a no-op.
 */
export function useSetAmenities(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (items: PropertyAmenityInput[]): Promise<PropertyAmenityRow[]> => {
			const res = await api.api.v1.properties[':propertyId'].amenities.$put({
				param: { propertyId },
				json: { items },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: PropertyAmenityRow[] }
			return body.data
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: amenitiesQueryOptions(propertyId).queryKey,
			})
			toast.success('Удобства сохранены')
		},
		onError: (err: ApiError) => {
			logger.warn('amenities.set failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}
