import type {
	BookingChannelCode,
	BookingGuestSnapshot,
	BookingRegistrationStatus,
	BookingStatus,
	PropertyBlock,
	Room,
	RoomType,
} from '@horeca/shared'
import { isRussianCitizenship } from '@horeca/shared'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'
import { emptyListRefetchInterval } from '../lib/poll-while-empty.ts'
import { maskGuestNameRu } from '../lib/booking-palette.ts'

/**
 * G11 v3 (2026-05-18) — narrow grid row WITHOUT PII fields. Backend list
 * endpoint returns full Booking shape, но queryFn PROJECTS к this narrow
 * shape ДО TanStack caches it. PII (guestSnapshot.{firstName, lastName,
 * middleName, passportSeries, documentNumber, dateOfBirth, citizenship,
 * phone, email}) НИКОГДА не попадает в IndexedDB persister storage.
 *
 * Mask + isForeignCitizen computed client-side ONCE on receive — both
 * derived from PII but не contain it. `guestMask` is the 152-ФЗ default
 * «Иванов И.» display string (already not-PII per Stakhanov 2026 canon
 * — single-letter initial не identifies physical person alone).
 * `isForeignCitizen` is а single bit (RU true/false) — also not PII per
 * 152-ФЗ ст. 3 «определяет физлицо».
 *
 * Per research ≥ 2026-05-18 (TanStack TkDodo offline-react-query +
 * Booking.com Reservations API IDs-first canon + 152-ФЗ ст. 5 ч. 5
 * data-minimization), THIS is the canonical browser-cache PII pattern.
 * Supersedes G11 v2 `stripPiiFromTree` (rejected — lied к TypeScript
 * `string` type, crashed downstream `.trim()` calls).
 *
 * For FULL PII (booking detail edit Sheet), use `useBooking(id)` hook
 * which fetches via `['booking', id]` queryKey marked `meta: { persist:
 * false }` — server-roundtrip every consume, never cached.
 */
export interface GridBooking {
	id: string
	roomTypeId: string
	status: BookingStatus
	checkIn: string
	checkOut: string
	assignedRoomId: string | null
	channelCode?: BookingChannelCode
	registrationStatus?: BookingRegistrationStatus
	tourismTaxMicros?: string | number
	/** Pre-computed «Иванов И.» mask — null если guest snapshot отсутствует. */
	guestMask: string | null
	/** Single bit для МВД badge logic — full citizenship code не cached. */
	isForeignCitizen: boolean
}

/** Wire shape — backend returns full booking с PII. Used ONLY inside
 *  queryFn для projection. NOT exported — никаких downstream consumers
 *  получают raw PII через grid path. */
interface WireBookingRow {
	id: string
	roomTypeId: string
	status: BookingStatus
	checkIn: string
	checkOut: string
	assignedRoomId: string | null
	channelCode?: BookingChannelCode
	registrationStatus?: BookingRegistrationStatus
	tourismTaxMicros?: string | number
	guestSnapshot?: BookingGuestSnapshot
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
		// Self-heal read-after-write lag (2026-05-29). A tenant that reaches the
		// grid ALWAYS has a property (the dashboard guard redirects property-less
		// tenants к /setup). An empty list here means the just-onboarded property
		// write hasn't propagated to the read path yet — Round 14.6 sends the user
		// straight wizard→/demo→grid, so the first fetch can race the commit. Poll
		// until it appears so the operator never gets stuck on an infinite skeleton
		// (without this, the empty result cached for staleTime=30s never refetched).
		refetchInterval: (query) => emptyListRefetchInterval(query.state.data),
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
			const body = (await res.json()) as { data: WireBookingRow[] }
			// G11 v3 (2026-05-18) — PROJECT к narrow shape ДО TanStack caches.
			// PII (guestSnapshot) is function-local; garbage-collected после
			// queryFn returns. TanStack stores только the projected
			// `GridBooking[]` — IndexedDB persister sees no PII.
			// `exactOptionalPropertyTypes: true` requires conditional shape
			// build (omit key vs explicit undefined). Spread pattern.
			return body.data.map<GridBooking>((b) => {
				const row: GridBooking = {
					id: b.id,
					roomTypeId: b.roomTypeId,
					status: b.status,
					checkIn: b.checkIn,
					checkOut: b.checkOut,
					assignedRoomId: b.assignedRoomId,
					guestMask: b.guestSnapshot ? maskGuestNameRu(b.guestSnapshot) : null,
					isForeignCitizen: b.guestSnapshot
						? !isRussianCitizenship(b.guestSnapshot.citizenship)
						: false,
				}
				if (b.channelCode !== undefined) row.channelCode = b.channelCode
				if (b.registrationStatus !== undefined) row.registrationStatus = b.registrationStatus
				if (b.tourismTaxMicros !== undefined) row.tourismTaxMicros = b.tourismTaxMicros
				return row
			})
		},
		enabled: Boolean(propertyId),
		// Stale quickly so M5e booking create/mutate re-fetches on next paint.
		staleTime: 5_000,
	})

	// G9 (2026-05-16): rooms fetch для OOO block→roomType mapping (blocks
	// are per-room, grid is per-roomType row — must resolve roomTypeId on
	// the client to place the grey band correctly). Active rooms only —
	// inactive can never have active blocks.
	const rooms = useQuery({
		queryKey: ['rooms', propertyId, null] as const,
		queryFn: async () => {
			if (!propertyId) return [] as Room[]
			const res = await api.api.v1.properties[':propertyId'].rooms.$get({
				param: { propertyId },
				query: {},
			})
			if (!res.ok) throw new Error('rooms.list failed')
			const body = (await res.json()) as { data: Room[] }
			return body.data
		},
		enabled: Boolean(propertyId),
		staleTime: 30_000,
	})

	// G9 (2026-05-16): property-blocks (OOO/maintenance) for grid render.
	// Server returns per-room blocks; chessboard groups by room.roomTypeId.
	const blocks = useQuery({
		queryKey: ['property-blocks', propertyId, from, to] as const,
		queryFn: async () => {
			if (!propertyId) return [] as PropertyBlock[]
			const res = await api.api.v1.properties[':propertyId'].blocks.$get({
				param: { propertyId },
				query: { from, to },
			})
			if (!res.ok) throw new Error('property-blocks.list failed')
			const body = (await res.json()) as { data: PropertyBlock[] }
			return body.data
		},
		enabled: Boolean(propertyId),
		staleTime: 5_000,
	})

	return {
		propertyId,
		propertyName: property.data?.[0]?.name ?? null,
		roomTypes: roomTypes.data ?? [],
		bookings: bookings.data ?? [],
		rooms: rooms.data ?? [],
		blocks: blocks.data ?? [],
		isLoading:
			property.isPending ||
			roomTypes.isPending ||
			bookings.isPending ||
			rooms.isPending ||
			blocks.isPending,
		isError:
			property.isError || roomTypes.isError || bookings.isError || rooms.isError || blocks.isError,
	}
}
