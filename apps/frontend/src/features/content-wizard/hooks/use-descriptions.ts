import type {
	PropertyDescription,
	PropertyDescriptionInput,
	PropertyDescriptionLocale,
} from '@horeca/shared'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'

export const descriptionsQueryOptions = (propertyId: string) =>
	queryOptions({
		queryKey: ['property', propertyId, 'descriptions'] as const,
		queryFn: async (): Promise<PropertyDescription[]> => {
			const res = await api.api.v1.properties[':propertyId'].descriptions.$get({
				param: { propertyId },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: PropertyDescription[] }
			return body.data
		},
		staleTime: 30_000,
	})

export function useDescriptions(propertyId: string) {
	return useQuery(descriptionsQueryOptions(propertyId))
}

export interface UpsertDescriptionVars {
	locale: PropertyDescriptionLocale
	input: PropertyDescriptionInput
	idempotencyKey: string
}

export function useUpsertDescription(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (vars: UpsertDescriptionVars): Promise<PropertyDescription> => {
			const res = await api.api.v1.properties[':propertyId'].descriptions[':locale'].$put(
				{
					param: { propertyId, locale: vars.locale },
					json: vars.input,
				},
				{ headers: { 'Idempotency-Key': vars.idempotencyKey } },
			)
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: PropertyDescription }
			return body.data
		},
		onSuccess: async (_data, vars) => {
			await queryClient.invalidateQueries({
				queryKey: descriptionsQueryOptions(propertyId).queryKey,
			})
			toast.success(`Описание (${vars.locale}) сохранено`)
		},
		onError: (err: ApiError) => {
			logger.warn('description.upsert failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}
