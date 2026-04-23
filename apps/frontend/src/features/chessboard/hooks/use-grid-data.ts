import type { BookingStatus, RoomType } from '@horeca/shared'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

/**
 * Narrow shape of a booking as it arrives from the JSON wire — bigint
 * fields (money micros) come back as strings per BigInt#toJSON patch on
 * the backend (see apps/backend/src/patches.ts). Grid doesn't need the
 * money fields; we only read identity + state + dates.
 */
interface GridBooking {
	id: string
	roomTypeId: string
	status: BookingStatus
	checkIn: string
	checkOut: string
}

/**
 * Data layer for the reservation grid.
 *
 * Fetches:
 *   - first property for the active tenant (single-property assumption for
 *     launch; multi-property switcher is post-launch)
 *   - roomTypes of that property (grid rows)
 *   - bookings for the property in [from, to] window (grid bands)
 *
 * Queries use stable `queryKey` tuples so `invalidateQueries` from booking
 * mutations in M5e cleanly refreshes the grid without re-mounting.
 */

export function useGridData(from: string, to: string) {
	const property = useQuery({
		queryKey: ['properties'] as const,
		queryFn: async () => {
			const res = await api.api.v1.properties.$get({ query: {} })
			if (!res.ok) throw new Error('properties.list failed')
			const body = (await res.json()) as { data: Array<{ id: string; name: string }> }
			return body.data
		},
		staleTime: 30_000,
	})
	const propertyId = property.data?.[0]?.id ?? null

	const roomTypes = useQuery({
		queryKey: ['roomTypes', propertyId] as const,
		queryFn: async () => {
			if (!propertyId) return []
			const res = await api.api.v1.properties[':propertyId']['room-types'].$get({
				param: { propertyId },
				query: {},
			})
			if (!res.ok) throw new Error('roomTypes.list failed')
			const body = (await res.json()) as { data: RoomType[] }
			return body.data
		},
		enabled: Boolean(propertyId),
		staleTime: 30_000,
	})

	const bookings = useQuery({
		queryKey: ['bookings', propertyId, from, to] as const,
		queryFn: async () => {
			if (!propertyId) return []
			const res = await api.api.v1.properties[':propertyId'].bookings.$get({
				param: { propertyId },
				query: { from, to },
			})
			if (!res.ok) throw new Error('bookings.list failed')
			const body = (await res.json()) as { data: GridBooking[] }
			return body.data
		},
		enabled: Boolean(propertyId),
		// Stale quickly so M5e booking create/mutate re-fetches on next paint.
		staleTime: 5_000,
	})

	return {
		propertyId,
		propertyName: property.data?.[0]?.name ?? null,
		roomTypes: roomTypes.data ?? [],
		bookings: bookings.data ?? [],
		isLoading: property.isPending || roomTypes.isPending || bookings.isPending,
		isError: property.isError || roomTypes.isError || bookings.isError,
	}
}
