import type { BookingStatus } from '@horeca/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'
import {
	applyOptimisticStatusUpdate,
	type BookingTransition,
	nextStatus,
} from '../lib/booking-transitions.ts'

/**
 * Read + 4 PATCH state-transition mutations for M5e.2 edit dialog.
 *
 * Wire contracts (verified 2026-04-24 against booking.routes.ts:63-110):
 *   GET   /api/v1/bookings/:id                  → { data: Booking }
 *   PATCH /api/v1/bookings/:id/check-in  body { assignedRoomId?: string|null }
 *   PATCH /api/v1/bookings/:id/check-out body (none)
 *   PATCH /api/v1/bookings/:id/cancel    body { reason: string 1..500 }
 *   PATCH /api/v1/bookings/:id/no-show   body { reason?: string|null 1..500 }
 *
 * Error surface (all 4): 404 if not found (cross-tenant probe included);
 * 409 INVALID_BOOKING_TRANSITION if status disallows (race condition —
 * UI enum-guard already hides the action, but a second tab can still
 * flip status between fetch and submit).
 *
 * Optimistic UI: onMutate updates `status` field in the grid cache so
 * the band palette flips immediately; onError rolls back to the
 * snapshot; onSettled invalidates both the grid list and the single-
 * booking query to reconcile with server truth.
 */

type BookingShape = {
	id: string
	roomTypeId: string
	status: BookingStatus
	checkIn: string
	checkOut: string
	propertyId?: string
	cancelReason?: string | null
	cancelledAt?: string | null
	checkedInAt?: string | null
	checkedOutAt?: string | null
	noShowAt?: string | null
}

/**
 * Fetch a single booking by id. Used by the edit dialog to pull audit
 * fields (cancelReason, checkedInAt, noShowAt …) that the grid's
 * narrow GridBooking doesn't carry.
 */
export function useBooking(id: string | null) {
	return useQuery({
		queryKey: ['booking', id] as const,
		queryFn: async () => {
			if (!id) return null
			const res = await api.api.v1.bookings[':id'].$get({ param: { id } })
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: BookingShape }
			return body.data
		},
		enabled: Boolean(id),
		staleTime: 5_000,
	})
}

interface TransitionDeps {
	propertyId: string | null
	windowFrom: string
	windowTo: string
	bookingId: string
	currentStatus: BookingStatus
}

/**
 * Build the optimistic/rollback/invalidate triplet for one transition.
 * `requestFn` receives the mutation vars + returns the Response; the
 * rest (cancelQueries, setQueryData, rollback, invalidate) is uniform
 * across all 4 transitions.
 */
function useTransitionMutation<Vars>(
	deps: TransitionDeps,
	transition: BookingTransition,
	successMessage: string,
	requestFn: (vars: Vars) => Promise<Response>,
) {
	const queryClient = useQueryClient()
	const gridKey = ['bookings', deps.propertyId, deps.windowFrom, deps.windowTo] as const
	const bookingKey = ['booking', deps.bookingId] as const

	return useMutation({
		mutationFn: async (vars: Vars) => {
			const res = await requestFn(vars)
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: BookingShape }
			return body.data
		},
		onMutate: async () => {
			await queryClient.cancelQueries({ queryKey: gridKey })
			await queryClient.cancelQueries({ queryKey: bookingKey })
			const prevGrid = queryClient.getQueryData<BookingShape[]>(gridKey) ?? []
			const prevBooking = queryClient.getQueryData<BookingShape>(bookingKey)

			const targetStatus = nextStatus(deps.currentStatus, transition)
			queryClient.setQueryData<BookingShape[]>(
				gridKey,
				applyOptimisticStatusUpdate(prevGrid, deps.bookingId, targetStatus),
			)
			if (prevBooking) {
				queryClient.setQueryData<BookingShape>(bookingKey, {
					...prevBooking,
					status: targetStatus,
				})
			}
			return { prevGrid, prevBooking }
		},
		onError: (err: ApiError, _vars, ctx) => {
			if (ctx?.prevGrid) queryClient.setQueryData(gridKey, ctx.prevGrid)
			if (ctx?.prevBooking) queryClient.setQueryData(bookingKey, ctx.prevBooking)
			logger.warn('booking.transition failed', {
				transition,
				code: err.code,
				message: err.message,
			})
			const msg =
				err.code === 'INVALID_BOOKING_TRANSITION'
					? 'Это действие недоступно в текущем статусе брони'
					: err.message
			toast.error(msg)
		},
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ['bookings', deps.propertyId] })
			await queryClient.invalidateQueries({ queryKey: bookingKey })
		},
		onSuccess: () => {
			toast.success(successMessage)
		},
	})
}

export function useCheckInBooking(deps: TransitionDeps) {
	return useTransitionMutation<void>(deps, 'checkIn', 'Гость заселён', () =>
		// `assignedRoomId` is deferred to later UI; server accepts empty body
		// since the field is nullable+optional.
		api.api.v1.bookings[':id']['check-in'].$patch({
			param: { id: deps.bookingId },
			json: {},
		}),
	)
}

export function useCheckOutBooking(deps: TransitionDeps) {
	return useTransitionMutation<void>(deps, 'checkOut', 'Гость выселен', () =>
		api.api.v1.bookings[':id']['check-out'].$patch({ param: { id: deps.bookingId } }),
	)
}

export function useCancelBooking(deps: TransitionDeps) {
	return useTransitionMutation<{ reason: string }>(deps, 'cancel', 'Бронь отменена', (vars) =>
		api.api.v1.bookings[':id'].cancel.$patch({
			param: { id: deps.bookingId },
			json: { reason: vars.reason },
		}),
	)
}

export function useMarkNoShowBooking(deps: TransitionDeps) {
	return useTransitionMutation<{ reason?: string }>(
		deps,
		'noShow',
		'Отмечено: гость не заехал',
		(vars) => {
			const trimmed = vars.reason?.trim()
			return api.api.v1.bookings[':id']['no-show'].$patch({
				param: { id: deps.bookingId },
				json: trimmed ? { reason: trimmed } : {},
			})
		},
	)
}
