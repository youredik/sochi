import type { PropertyCreateInput, RoomCreateInput, RoomTypeCreateInput } from '@horeca/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { logger } from '../../../lib/logger.ts'

/**
 * Create mutations for the setup wizard. Each invalidates its own list
 * query so the dashboard (and later the chessboard) sees the new entity
 * without a manual reload. `idempotency-key` header omitted here — wizard
 * is a one-shot interactive flow, offline-sync mutations arrive in M5e.
 */

function extractError(raw: unknown): { code?: string; message: string } {
	if (raw && typeof raw === 'object' && 'message' in raw && typeof raw.message === 'string') {
		const code = 'code' in raw && typeof raw.code === 'string' ? raw.code : undefined
		return code ? { code, message: raw.message } : { message: raw.message }
	}
	return { message: String(raw) }
}

export function useCreateProperty() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: PropertyCreateInput) => {
			const res = await api.api.v1.properties.$post({ json: input })
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: unknown } | null
				throw extractError(body?.error ?? { message: `HTTP ${res.status}` })
			}
			const body = (await res.json()) as { data: { id: string; name: string; slug?: string } }
			return body.data
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['properties'] })
			toast.success('Гостиница создана')
		},
		onError: (err: { code?: string; message: string }) => {
			logger.warn('property.create failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}

export function useCreateRoomType(propertyId: string | null) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: RoomTypeCreateInput) => {
			if (!propertyId) throw { message: 'Нет propertyId — шаг гостиницы не завершён' }
			const res = await api.api.v1.properties[':propertyId']['room-types'].$post({
				param: { propertyId },
				json: input,
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: unknown } | null
				throw extractError(body?.error ?? { message: `HTTP ${res.status}` })
			}
			const body = (await res.json()) as { data: { id: string; name: string } }
			return body.data
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['roomTypes', propertyId] })
			toast.success('Тип номеров создан')
		},
		onError: (err: { code?: string; message: string }) => {
			logger.warn('roomType.create failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}

export function useCreateRoom() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: RoomCreateInput) => {
			const res = await api.api.v1.rooms.$post({ json: input })
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: unknown } | null
				throw extractError(body?.error ?? { message: `HTTP ${res.status}` })
			}
			const body = (await res.json()) as { data: { id: string; number: string } }
			return body.data
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['rooms'] })
		},
		onError: (err: { code?: string; message: string }) => {
			logger.warn('room.create failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}
