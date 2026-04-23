import type { BookingStatus, Guest, RatePlan } from '@horeca/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse, extractApiError } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'
import {
	applyOptimisticBand,
	type BookingCreateDialogInput,
	buildBookingCreateBody,
	buildGuestCreateBody,
	buildOptimisticBand,
	type OptimisticBand,
} from '../lib/booking-create.ts'

/**
 * Data + mutations for the booking-create dialog on the reservation
 * grid (M5e.1).
 *
 * Two write paths, sequenced because the server requires a real
 * `primaryGuestId` on the booking body (no inline guest embed):
 *   1. POST /guests — creates the guest row, returns id
 *   2. POST /properties/:propertyId/bookings with `Idempotency-Key`
 *
 * Optimistic UI:
 *   - `onMutate` stamps a `pending` band into the `['bookings', ...]`
 *     cache so the grid reflects the click immediately
 *   - `onError` rolls back to the prior cache state (overbooking 409,
 *     idempotency conflict 422, validation 400 — all treated the same
 *     from the UI's PoV: user sees toast + optimistic band vanishes)
 *   - `onSettled` invalidates to reconcile with the server truth
 *
 * The grid's active window (`from, to`) is passed in so we write to
 * the exact cache key it reads. Mismatched window → optimistic write
 * lands in a stale cache entry and the user sees "band flicker"; we
 * prevent this by threading the window from Chessboard.
 */

export function useRatePlans(propertyId: string | null, roomTypeId: string | null) {
	return useQuery({
		queryKey: ['ratePlans', propertyId, roomTypeId] as const,
		queryFn: async () => {
			if (!propertyId) return [] as RatePlan[]
			const res = await api.api.v1.properties[':propertyId']['rate-plans'].$get({
				param: { propertyId },
				query: roomTypeId ? { roomTypeId } : {},
			})
			if (!res.ok) throw new Error('ratePlans.list failed')
			const body = (await res.json()) as { data: RatePlan[] }
			return body.data
		},
		enabled: Boolean(propertyId),
		staleTime: 30_000,
	})
}

export function useCreateGuest() {
	return useMutation({
		mutationFn: async (input: Parameters<typeof buildGuestCreateBody>[0]): Promise<Guest> => {
			const body = buildGuestCreateBody(input)
			const res = await api.api.v1.guests.$post({ json: body })
			if (!res.ok) throw await errorFromResponse(res)
			const payload = (await res.json()) as { data: Guest }
			return payload.data
		},
		onError: (err: ApiError) => {
			logger.warn('guest.create failed', { code: err.code, message: err.message })
		},
	})
}

/**
 * Create a booking with Stripe-style idempotency.
 *
 * The caller owns the idempotency key — typically generated once per
 * dialog mount and held stable across submit retries. If the first
 * request actually landed but the response was lost (network flap,
 * user reload), a second submit with the SAME key replays the cached
 * response instead of double-booking the room.
 *
 * Error surface:
 *   409 NO_INVENTORY           — allotment exhausted (overbooking)
 *   409 BOOKING_EXTERNAL_ID_TAKEN — dupe externalId in property scope
 *   409 ROOM_TYPE_NOT_FOUND / RATE_PLAN_NOT_FOUND — stale ids
 *   422 IDEMPOTENCY_KEY_CONFLICT — same key, different body (client bug)
 *   400 VALIDATION_ERROR       — schema mismatch
 */
export function useCreateBooking(propertyId: string | null, windowFrom: string, windowTo: string) {
	const queryClient = useQueryClient()
	const bookingsKey = ['bookings', propertyId, windowFrom, windowTo] as const

	return useMutation({
		mutationFn: async (args: { input: BookingCreateDialogInput; idempotencyKey: string }) => {
			if (!propertyId) {
				throw extractApiError({ message: 'Нет propertyId — перезайдите на страницу гостиницы' })
			}
			const body = buildBookingCreateBody(args.input)
			const res = await api.api.v1.properties[':propertyId'].bookings.$post(
				{ param: { propertyId }, json: body },
				{ headers: { 'Idempotency-Key': args.idempotencyKey } },
			)
			if (!res.ok) throw await errorFromResponse(res)
			// Narrow response — Booking carries bigint money fields that arrive
			// as decimal strings on the wire (see patches.ts BigInt#toJSON); the
			// grid band reads only the subset we destructure here.
			const payload = (await res.json()) as {
				data: {
					id: string
					status: BookingStatus
					checkIn: string
					checkOut: string
					roomTypeId: string
				}
			}
			return payload.data
		},
		onMutate: async (args) => {
			// Cancel any in-flight refetch so our optimistic write isn't
			// overwritten by a stale response landing mid-mutation.
			await queryClient.cancelQueries({ queryKey: bookingsKey })
			const previous = queryClient.getQueryData<OptimisticBand[]>(bookingsKey) ?? []
			const band = buildOptimisticBand({
				idempotencyKey: args.idempotencyKey,
				roomTypeId: args.input.roomTypeId,
				checkIn: args.input.checkIn,
				checkOut: args.input.checkOut,
			})
			queryClient.setQueryData<OptimisticBand[]>(bookingsKey, applyOptimisticBand(previous, band))
			return { previous }
		},
		onError: (err: ApiError, _args, ctx) => {
			// Rollback: restore the snapshot captured in onMutate.
			if (ctx?.previous) queryClient.setQueryData(bookingsKey, ctx.previous)
			logger.warn('booking.create failed', { code: err.code, message: err.message })
			const msg =
				err.code === 'NO_INVENTORY'
					? 'На эти даты нет свободных номеров'
					: err.code === 'IDEMPOTENCY_KEY_CONFLICT'
						? 'Повторный запрос с другими данными — перезагрузите диалог'
						: err.message
			toast.error(msg)
		},
		onSettled: async () => {
			// Reconcile with server truth — replaces optimistic placeholder
			// with the real row (success) or removes it (failure).
			await queryClient.invalidateQueries({ queryKey: ['bookings', propertyId] })
		},
		onSuccess: () => {
			toast.success('Бронирование создано')
		},
	})
}
