import type { PropertyMedia, PropertyMediaPatch } from '@horeca/shared'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'

/**
 * Wire shape — backend serializes `fileSizeBytes` as string (BigInt).
 * Hook unwraps so domain code can compare numerically without `BigInt(…)`
 * sprinkled at every call site.
 */
type MediaWire = Omit<PropertyMedia, 'fileSizeBytes'> & { fileSizeBytes: string }

function fromWire(m: MediaWire): PropertyMedia {
	return { ...m, fileSizeBytes: BigInt(m.fileSizeBytes) }
}

export const mediaQueryOptions = (propertyId: string) =>
	queryOptions({
		queryKey: ['property', propertyId, 'media'] as const,
		queryFn: async (): Promise<PropertyMedia[]> => {
			const res = await api.api.v1.properties[':propertyId'].media.$get({
				param: { propertyId },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: MediaWire[] }
			return body.data.map(fromWire)
		},
		staleTime: 30_000,
	})

export function useMediaList(propertyId: string) {
	return useQuery(mediaQueryOptions(propertyId))
}

export interface UploadVars {
	file: File
	altRu: string
	altEn?: string
	kind?: 'photo' | 'photo_360' | 'video_tour'
}

/**
 * Direct multipart upload — backend handles presign + simulateUpload +
 * create + process in one call (dev-friendly route added in M8.A.0.UI).
 * Real prod path will be replaced by browser PUT to Object Storage in M9.
 */
export function useUploadMedia(propertyId: string) {
	const queryClient = useQueryClient()
	const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'
	return useMutation({
		mutationFn: async (
			vars: UploadVars,
		): Promise<{ media: PropertyMedia; variantCount: number; derivedKeys: string[] }> => {
			const fd = new FormData()
			fd.append('file', vars.file)
			fd.append('kind', vars.kind ?? 'photo')
			fd.append('altRu', vars.altRu)
			if (vars.altEn) fd.append('altEn', vars.altEn)
			// hc client doesn't model multipart routes well — fall back to fetch
			// for this single endpoint. Same-origin via vite proxy in dev; with
			// `credentials: include` so the auth cookie ships.
			const res = await fetch(
				`${apiUrl}/api/v1/properties/${encodeURIComponent(propertyId)}/media/upload`,
				{ method: 'POST', body: fd, credentials: 'include' },
			)
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as {
				data: { media: MediaWire; variantCount: number; derivedKeys: string[] }
			}
			return {
				media: fromWire(body.data.media),
				variantCount: body.data.variantCount,
				derivedKeys: body.data.derivedKeys,
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: mediaQueryOptions(propertyId).queryKey })
			toast.success('Файл загружен и обработан')
		},
		onError: (err: ApiError) => {
			logger.warn('media.upload failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}

interface PatchVars {
	mediaId: string
	patch: PropertyMediaPatch
}

export function usePatchMedia(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async ({ mediaId, patch }: PatchVars): Promise<PropertyMedia> => {
			const res = await api.api.v1.properties[':propertyId'].media[':mediaId'].$patch({
				param: { propertyId, mediaId },
				json: patch,
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: MediaWire }
			return fromWire(body.data)
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: mediaQueryOptions(propertyId).queryKey })
			toast.success('Сохранено')
		},
		onError: (err: ApiError) => {
			logger.warn('media.patch failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}

export function useDeleteMedia(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (mediaId: string): Promise<void> => {
			const res = await api.api.v1.properties[':propertyId'].media[':mediaId'].$delete({
				param: { propertyId, mediaId },
			})
			if (!res.ok) throw await errorFromResponse(res)
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: mediaQueryOptions(propertyId).queryKey })
			toast.success('Удалено')
		},
		onError: (err: ApiError) => {
			logger.warn('media.delete failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}

export function useSetHero(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (mediaId: string): Promise<PropertyMedia> => {
			const res = await api.api.v1.properties[':propertyId'].media[':mediaId'].hero.$post({
				param: { propertyId, mediaId },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: MediaWire }
			return fromWire(body.data)
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: mediaQueryOptions(propertyId).queryKey })
			toast.success('Установлено как главное')
		},
		onError: (err: ApiError) => {
			logger.warn('media.hero failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}
