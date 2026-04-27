import type { Addon, AddonCreateInput, AddonPatch } from '@horeca/shared'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'

/**
 * Wire shape — `priceMicros` serialized as string (BigInt). Hook unwraps
 * to bigint so domain code can math on it; submit re-serializes.
 */
type AddonWire = Omit<Addon, 'priceMicros'> & { priceMicros: string }

function fromWire(a: AddonWire): Addon {
	return { ...a, priceMicros: BigInt(a.priceMicros) }
}

type AddonCreateWire = Omit<AddonCreateInput, 'priceMicros'> & { priceMicros: string }
type AddonPatchWire = Omit<AddonPatch, 'priceMicros'> & { priceMicros?: string }

function createToWire(input: AddonCreateInput): AddonCreateWire {
	return { ...input, priceMicros: input.priceMicros.toString() }
}

function patchToWire(input: AddonPatch): AddonPatchWire {
	const { priceMicros, ...rest } = input
	if (priceMicros === undefined) return rest
	return { ...rest, priceMicros: priceMicros.toString() }
}

export const addonsQueryOptions = (propertyId: string) =>
	queryOptions({
		queryKey: ['property', propertyId, 'addons'] as const,
		queryFn: async (): Promise<Addon[]> => {
			const res = await api.api.v1.properties[':propertyId'].addons.$get({
				param: { propertyId },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: AddonWire[] }
			return body.data.map(fromWire)
		},
		staleTime: 30_000,
	})

export function useAddons(propertyId: string) {
	return useQuery(addonsQueryOptions(propertyId))
}

export function useCreateAddon(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: AddonCreateInput): Promise<Addon> => {
			const res = await api.api.v1.properties[':propertyId'].addons.$post({
				param: { propertyId },
				// Backend's `int64WireSchema` accepts string|bigint and coerces.
				// hc client types reflect the bigint side; we send string.
				json: createToWire(input) as unknown as AddonCreateInput,
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: AddonWire }
			return fromWire(body.data)
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: addonsQueryOptions(propertyId).queryKey })
			toast.success('Услуга создана')
		},
		onError: (err: ApiError) => {
			logger.warn('addon.create failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}

interface PatchVars {
	addonId: string
	patch: AddonPatch
}

export function usePatchAddon(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async ({ addonId, patch }: PatchVars): Promise<Addon> => {
			const res = await api.api.v1.properties[':propertyId'].addons[':addonId'].$patch({
				param: { propertyId, addonId },
				json: patchToWire(patch) as unknown as AddonPatch,
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: AddonWire }
			return fromWire(body.data)
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: addonsQueryOptions(propertyId).queryKey })
			toast.success('Услуга обновлена')
		},
		onError: (err: ApiError) => {
			logger.warn('addon.patch failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}

export function useDeleteAddon(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (addonId: string): Promise<void> => {
			const res = await api.api.v1.properties[':propertyId'].addons[':addonId'].$delete({
				param: { propertyId, addonId },
			})
			if (!res.ok) throw await errorFromResponse(res)
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: addonsQueryOptions(propertyId).queryKey })
			toast.success('Услуга удалена')
		},
		onError: (err: ApiError) => {
			logger.warn('addon.delete failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}
