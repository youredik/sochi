/**
 * Rooms — TanStack Query hooks for the inventory admin surface.
 *
 * Endpoints:
 *   - `GET    /api/v1/properties/:propertyId/rooms`    — list, optional ?roomTypeId
 *   - `POST   /api/v1/rooms`                            — create (one)
 *   - `PATCH  /api/v1/rooms/:id`                        — update
 *   - `DELETE /api/v1/rooms/:id`                        — delete
 *
 * Bulk-add (range «201..210») is a sequence of POST /rooms calls — backend
 * has no /bulk endpoint for rooms. The frontend hook fires them concurrently
 * (Promise.all) and reports partial failures so the operator knows если
 * room «207» was taken by an existing record (RoomNumberTakenError surfaces
 * как HTTP 409). Order of attempts is preserved in the result array.
 */
import type { Room, RoomCreateInput } from '@horeca/shared'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export const roomsQueryKey = (propertyId: string) => ['inventory', 'rooms', { propertyId }] as const

export const roomsQueryOptions = (propertyId: string) =>
	queryOptions({
		queryKey: roomsQueryKey(propertyId),
		queryFn: async (): Promise<Room[]> => {
			const res = await api.api.v1.properties[':propertyId'].rooms.$get({
				param: { propertyId },
				query: { includeInactive: 'false' },
			})
			if (!res.ok) throw new Error(`rooms.list HTTP ${res.status}`)
			const body = (await res.json()) as { data: Room[] }
			return body.data
		},
		staleTime: 30_000,
	})

// Single-room create / update hooks (useCreateRoom, useUpdateRoom) live в
// Phase II.bis when the UI surfaces them. Premature export = knip «unused»
// failure; reintroduce when consumed. Phase II currently goes ONLY through
// `useBulkCreateRooms` (POST /rooms × N fanout for the «201..210» pattern).

export interface BulkRoomCreateInput {
	readonly roomTypeId: string
	/** Inclusive start of the numeric range, e.g. 201 для «201..210». */
	readonly startNumber: number
	/** Inclusive end. */
	readonly endNumber: number
	/** Optional floor (applied to all created rooms). */
	readonly floor?: number
}

export interface BulkRoomCreateResult {
	readonly created: readonly Room[]
	readonly failed: ReadonlyArray<{ number: string; error: string }>
}

/**
 * Bulk-create rooms over a contiguous numeric range. Fires N concurrent
 * POST /rooms calls (one per room number), collects per-room outcomes, and
 * returns a single result with both successes + failures. Total cap of 500
 * mirrors `roomTypeCreateInput.inventoryCount.max(500)` — defensive against
 * accidental e.g. 1..10000 input that would hammer the API.
 */
export function useBulkCreateRooms(propertyId: string) {
	const queryClient = useQueryClient()
	return useMutation<BulkRoomCreateResult, Error, BulkRoomCreateInput>({
		mutationFn: async ({ roomTypeId, startNumber, endNumber, floor }) => {
			if (endNumber < startNumber) {
				throw new Error('endNumber must be ≥ startNumber')
			}
			if (endNumber - startNumber + 1 > 500) {
				throw new Error('Bulk-add range is capped at 500 rooms per call')
			}
			const numbers: string[] = []
			for (let n = startNumber; n <= endNumber; n += 1) numbers.push(String(n))
			const settled = await Promise.allSettled(
				numbers.map((number) => {
					const input: RoomCreateInput =
						floor !== undefined ? { roomTypeId, number, floor } : { roomTypeId, number }
					return api.api.v1.rooms.$post({ json: input }).then(async (res) => {
						if (!res.ok) throw new Error(`HTTP ${res.status}`)
						const body = (await res.json()) as { data: Room }
						return body.data
					})
				}),
			)
			const created: Room[] = []
			const failed: Array<{ number: string; error: string }> = []
			for (let i = 0; i < settled.length; i += 1) {
				const outcome = settled[i]
				const number = numbers[i]
				if (!outcome || !number) continue
				if (outcome.status === 'fulfilled') {
					created.push(outcome.value)
				} else {
					failed.push({
						number,
						error:
							outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
					})
				}
			}
			return { created, failed }
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: roomsQueryKey(propertyId) })
		},
	})
}
