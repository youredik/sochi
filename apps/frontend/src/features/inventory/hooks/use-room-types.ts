/**
 * Room-types — TanStack Query hooks for the inventory admin surface.
 *
 * Endpoints:
 *   - `GET    /api/v1/properties/:propertyId/room-types` — list
 *   - `POST   /api/v1/properties/:propertyId/room-types` — create
 *   - `PATCH  /api/v1/room-types/:id`                     — update
 *   - `DELETE /api/v1/room-types/:id`                     — delete
 *
 * `propertiesQueryOptions` (in `features/receivables`) handles the property
 * list; this module owns roomTypes within a chosen property.
 */
import type { RoomType, RoomTypeCreateInput, RoomTypeUpdateInput } from '@horeca/shared'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export const roomTypesQueryKey = (propertyId: string) =>
	['inventory', 'room-types', { propertyId }] as const

export const roomTypesQueryOptions = (propertyId: string) =>
	queryOptions({
		queryKey: roomTypesQueryKey(propertyId),
		queryFn: async (): Promise<RoomType[]> => {
			const res = await api.api.v1.properties[':propertyId']['room-types'].$get({
				param: { propertyId },
				query: { includeInactive: 'false' },
			})
			if (!res.ok) throw new Error(`room-types.list HTTP ${res.status}`)
			const body = (await res.json()) as { data: RoomType[] }
			return body.data
		},
		staleTime: 30_000,
	})

export function useCreateRoomType(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation<RoomType, Error, RoomTypeCreateInput>({
		mutationFn: async (input) => {
			const res = await api.api.v1.properties[':propertyId']['room-types'].$post({
				param: { propertyId },
				json: input,
			})
			if (!res.ok) throw new Error(`room-types.create HTTP ${res.status}`)
			const body = (await res.json()) as { data: RoomType }
			return body.data
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: roomTypesQueryKey(propertyId) })
		},
	})
}

export function useUpdateRoomType(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation<RoomType, Error, { id: string; patch: RoomTypeUpdateInput }>({
		mutationFn: async ({ id, patch }) => {
			const res = await api.api.v1['room-types'][':id'].$patch({
				param: { id },
				json: patch,
			})
			if (!res.ok) throw new Error(`room-types.update HTTP ${res.status}`)
			const body = (await res.json()) as { data: RoomType }
			return body.data
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: roomTypesQueryKey(propertyId) })
		},
	})
}

export function useDeleteRoomType(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation<{ success: boolean }, Error, { id: string }>({
		mutationFn: async ({ id }) => {
			const res = await api.api.v1['room-types'][':id'].$delete({ param: { id } })
			if (!res.ok) throw new Error(`room-types.delete HTTP ${res.status}`)
			const body = (await res.json()) as { data: { success: boolean } }
			return body.data
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: roomTypesQueryKey(propertyId) })
		},
	})
}
