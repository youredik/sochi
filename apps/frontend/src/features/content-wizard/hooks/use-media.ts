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
	idempotencyKey: string
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file)
		const img = new Image()
		img.onload = () => {
			URL.revokeObjectURL(url)
			resolve({ width: img.naturalWidth, height: img.naturalHeight })
		}
		img.onerror = () => {
			URL.revokeObjectURL(url)
			reject(new Error('Не удалось определить размер изображения'))
		}
		img.src = url
	})
}

/**
 * M9.7 — adaptive media upload hook.
 *
 * **Production path (Yandex Object Storage):** split-flow
 *   1. POST /media/sign → presigned PUT URL + mediaId/originalKey
 *   2. PUT direct к Object Storage (bypass backend body limit)
 *   3. Browser Image() → dimensions
 *   4. POST /media (register row) + POST /media/:id/process (sharp)
 *
 * **Sandbox/dev path:** legacy multipart /media/upload (backend Stub adapter
 * cannot accept real PUT). Detection: presigned URL hostname matches
 * `stub.media.local` → bytes go through multipart route instead.
 *
 * Single exported hook for media-step consumer — runtime adaptation,
 * zero-config switching между sandbox + production.
 */
export function useUploadMedia(propertyId: string) {
	const queryClient = useQueryClient()
	const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

	const runSplitFlow = async (
		vars: UploadVars,
	): Promise<{ media: PropertyMedia; variantCount: number; derivedKeys: string[] }> => {
		// 1. Sign — get presigned PUT URL + mediaId.
		const signRes = await fetch(
			`${apiUrl}/api/v1/properties/${encodeURIComponent(propertyId)}/media/sign`,
			{
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					kind: vars.kind ?? 'photo',
					mimeType: vars.file.type,
					sizeBytes: vars.file.size,
				}),
			},
		)
		if (!signRes.ok) throw await errorFromResponse(signRes)
		const signBody = (await signRes.json()) as {
			data: {
				mediaId: string
				originalKey: string
				presignedUrl: string
				headers: Record<string, string>
				expiresAt: string
			}
		}
		const { mediaId, originalKey, presignedUrl, headers } = signBody.data

		// Sandbox detection: Stub adapter returns `http://stub.media.local/...`
		// — browser cannot PUT to that URL. Fall back к legacy /upload route.
		if (presignedUrl.includes('stub.media.local')) {
			throw new SandboxFallback(originalKey)
		}

		// 2. Direct PUT к Object Storage.
		const putRes = await fetch(presignedUrl, {
			method: 'PUT',
			body: vars.file,
			headers,
		})
		if (!putRes.ok) {
			throw new Error(`PUT ${presignedUrl} HTTP ${putRes.status}: ${await putRes.text()}`)
		}

		// 3. Read dimensions via browser Image().
		const dims = await readImageDimensions(vars.file)

		// 4. Register media row.
		const createRes = await fetch(
			`${apiUrl}/api/v1/properties/${encodeURIComponent(propertyId)}/media`,
			{
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json',
					'Idempotency-Key': vars.idempotencyKey,
				},
				body: JSON.stringify({
					roomTypeId: null,
					kind: vars.kind ?? 'photo',
					originalKey,
					mimeType: vars.file.type,
					widthPx: dims.width,
					heightPx: dims.height,
					fileSizeBytes: vars.file.size.toString(),
					altRu: vars.altRu,
					altEn: vars.altEn ?? null,
					captionRu: null,
					captionEn: null,
				}),
			},
		)
		if (!createRes.ok) throw await errorFromResponse(createRes)

		// 5. Trigger sharp pipeline.
		const processRes = await fetch(
			`${apiUrl}/api/v1/properties/${encodeURIComponent(propertyId)}/media/${encodeURIComponent(mediaId)}/process`,
			{ method: 'POST', credentials: 'include' },
		)
		if (!processRes.ok) throw await errorFromResponse(processRes)
		const processBody = (await processRes.json()) as {
			data: { media: MediaWire; variantCount: number; derivedKeys: string[] }
		}
		return {
			media: fromWire(processBody.data.media),
			variantCount: processBody.data.variantCount,
			derivedKeys: processBody.data.derivedKeys,
		}
	}

	const runMultipart = async (
		vars: UploadVars,
	): Promise<{ media: PropertyMedia; variantCount: number; derivedKeys: string[] }> => {
		const fd = new FormData()
		fd.append('file', vars.file)
		fd.append('kind', vars.kind ?? 'photo')
		fd.append('altRu', vars.altRu)
		if (vars.altEn) fd.append('altEn', vars.altEn)
		const res = await fetch(
			`${apiUrl}/api/v1/properties/${encodeURIComponent(propertyId)}/media/upload`,
			{
				method: 'POST',
				body: fd,
				credentials: 'include',
				headers: { 'Idempotency-Key': vars.idempotencyKey },
			},
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
	}

	return useMutation({
		mutationFn: async (vars: UploadVars) => {
			try {
				return await runSplitFlow(vars)
			} catch (err) {
				if (err instanceof SandboxFallback) {
					return await runMultipart(vars)
				}
				throw err
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

class SandboxFallback extends Error {
	readonly originalKey: string
	constructor(originalKey: string) {
		super('sandbox-fallback')
		this.originalKey = originalKey
	}
}

export interface PatchMediaVars {
	mediaId: string
	patch: PropertyMediaPatch
	idempotencyKey: string
}

export function usePatchMedia(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (vars: PatchMediaVars): Promise<PropertyMedia> => {
			const res = await api.api.v1.properties[':propertyId'].media[':mediaId'].$patch(
				{
					param: { propertyId, mediaId: vars.mediaId },
					json: vars.patch,
				},
				{ headers: { 'Idempotency-Key': vars.idempotencyKey } },
			)
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

export interface DeleteMediaVars {
	mediaId: string
	idempotencyKey: string
}

export function useDeleteMedia(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (vars: DeleteMediaVars): Promise<void> => {
			const res = await api.api.v1.properties[':propertyId'].media[':mediaId'].$delete(
				{ param: { propertyId, mediaId: vars.mediaId } },
				{ headers: { 'Idempotency-Key': vars.idempotencyKey } },
			)
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

export interface SetHeroVars {
	mediaId: string
	idempotencyKey: string
}

export function useSetHero(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (vars: SetHeroVars): Promise<PropertyMedia> => {
			const res = await api.api.v1.properties[':propertyId'].media[':mediaId'].hero.$post(
				{ param: { propertyId, mediaId: vars.mediaId } },
				{ headers: { 'Idempotency-Key': vars.idempotencyKey } },
			)
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
