import type { BookingGuestSnapshot, BookingStatus } from '@horeca/shared'
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
	// G5 amend-stay (2026-05-15): ratePlanId / guestsCount нужны UI для
	// inline edit affordances. Already returned by `GET /bookings/:id`.
	ratePlanId?: string
	guestsCount?: number
	// G8 (2026-05-16) — assignedRoomId needed для unassigned-list filter и
	// «Назначить номер» dialog. Server already serializes на every Booking row.
	assignedRoomId?: string | null
	// G8 — guestSnapshot нужен для UnassignedPanel list 152-ФЗ mask (per
	// G4 canon). Server already serializes на every Booking row.
	guestSnapshot?: BookingGuestSnapshot
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
		// G11 v3 (2026-05-18) — full booking PII (guestSnapshot, document
		// fields). NEVER persisted к IndexedDB per 152-ФЗ. Fresh fetch
		// каждый раз операторе opens edit Sheet.
		meta: { persist: false },
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

// ---------------------------------------------------------------------------
// G5 Apaleo Amend-Stay (2026-05-15) — pre-arrival booking modifications.
//
// Unlike transitions which optimistically update `status` only, amends touch
// multiple fields (dates, rate, count). The mutation invalidates grid + single-
// booking cache на settled — reconciliation pulls full server truth (включая
// updated timeSlices / fees / tax). Optimistic UI deferred: amend is rarer
// than transitions (operator action, not bulk-flow), brief loading state OK.
//
// Error mapping: 409 INVALID_BOOKING_AMEND_STATE + 409 NO_INVENTORY + 404
// surface canonical RU messages. Same Toast notification pattern as transitions.
// ---------------------------------------------------------------------------

interface AmendDeps {
	propertyId: string | null
	windowFrom: string
	windowTo: string
	bookingId: string
}

function amendErrorMessage(err: ApiError, defaultMsg: string): string {
	if (err.code === 'INVALID_BOOKING_AMEND_STATE') {
		return 'Изменение недоступно в текущем статусе брони'
	}
	if (err.code === 'NO_INVENTORY') {
		return 'Нет свободных номеров на новые даты'
	}
	if (err.code === 'NOT_FOUND') {
		return 'Бронь или тариф не найдены'
	}
	return err.message || defaultMsg
}

function useAmendMutation<Vars>(
	deps: AmendDeps,
	successMessage: string,
	defaultErrorMessage: string,
	requestFn: (vars: Vars) => Promise<Response>,
) {
	const queryClient = useQueryClient()
	const bookingKey = ['booking', deps.bookingId] as const

	return useMutation({
		mutationFn: async (vars: Vars) => {
			const res = await requestFn(vars)
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: BookingShape }
			return body.data
		},
		onError: (err: ApiError) => {
			logger.warn('booking.amend failed', { code: err.code, message: err.message })
			toast.error(amendErrorMessage(err, defaultErrorMessage))
		},
		onSettled: async () => {
			// Full re-sync: amends touch many fields (timeSlices / fees / tax)
			// что не fit optimistic single-field update — server truth wins.
			await queryClient.invalidateQueries({ queryKey: ['bookings', deps.propertyId] })
			await queryClient.invalidateQueries({ queryKey: bookingKey })
		},
		onSuccess: () => {
			toast.success(successMessage)
		},
	})
}

export function useMoveDatesBooking(deps: AmendDeps) {
	return useAmendMutation<{ checkIn: string; checkOut: string }>(
		deps,
		'Даты обновлены',
		'Не удалось перенести бронь',
		(vars) =>
			api.api.v1.bookings[':id']['move-dates'].$patch({
				param: { id: deps.bookingId },
				json: { checkIn: vars.checkIn, checkOut: vars.checkOut },
			}),
	)
}

export function useChangeRatePlanBooking(deps: AmendDeps) {
	return useAmendMutation<{ ratePlanId: string }>(
		deps,
		'Тариф обновлён',
		'Не удалось сменить тариф',
		(vars) =>
			api.api.v1.bookings[':id']['change-rate-plan'].$patch({
				param: { id: deps.bookingId },
				json: { ratePlanId: vars.ratePlanId },
			}),
	)
}

export function useChangeGuestsCountBooking(deps: AmendDeps) {
	return useAmendMutation<{ guestsCount: number }>(
		deps,
		'Количество гостей обновлено',
		'Не удалось изменить число гостей',
		(vars) =>
			api.api.v1.bookings[':id']['change-guests-count'].$patch({
				param: { id: deps.bookingId },
				json: { guestsCount: vars.guestsCount },
			}),
	)
}

/**
 * G7 (2026-05-16) — move band к different roomType row.
 * Drag-move target gesture OR pointer-alternative ActionView dialog.
 *
 * Backend auto-picks default active ratePlan для new roomType (drag UX
 * simplicity — operator only changes the row). Same dates → atomic
 * inventory swap. Errors mapped к canonical RU messages:
 *   - 409 NO_INVENTORY → «Нет свободных номеров в выбранной категории»
 *   - 409 INVALID_BOOKING_AMEND_STATE → «Изменение недоступно...»
 *   - 404 NOT_FOUND → «Бронь или категория не найдены»
 */
export function useChangeRoomTypeBooking(deps: AmendDeps) {
	return useAmendMutation<{ roomTypeId: string }>(
		deps,
		'Бронь перемещена в новую категорию',
		'Не удалось переместить бронь',
		(vars) =>
			api.api.v1.bookings[':id']['change-room-type'].$patch({
				param: { id: deps.bookingId },
				json: { roomTypeId: vars.roomTypeId },
			}),
	)
}

/**
 * G7 (2026-05-16) — grid-level drag-move mutation.
 *
 * Unlike `useChangeRoomTypeBooking` (per-booking, used в edit-sheet
 * ActionView), this hook is constructed ONCE per grid render и accepts
 * `bookingId` at mutateAsync time. Suitable для Pragmatic DnD onDrop
 * handler где target booking determined dynamically.
 *
 * Cache invalidation на settled: grid bookings list (window-scoped) +
 * single-booking cache when applicable.
 */
export function useGridDragMoveRoomType(
	propertyId: string | null,
	_windowFrom: string,
	_windowTo: string,
) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (vars: { bookingId: string; roomTypeId: string }) => {
			const res = await api.api.v1.bookings[':id']['change-room-type'].$patch({
				param: { id: vars.bookingId },
				json: { roomTypeId: vars.roomTypeId },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: BookingShape }
			return body.data
		},
		onError: (err: ApiError) => {
			logger.warn('booking.dragMoveRoomType failed', {
				code: err.code,
				message: err.message,
			})
			toast.error(amendErrorMessage(err, 'Не удалось переместить бронь'))
		},
		onSettled: async (_data, _err, vars) => {
			await queryClient.invalidateQueries({ queryKey: ['bookings', propertyId] })
			await queryClient.invalidateQueries({ queryKey: ['booking', vars.bookingId] })
		},
		onSuccess: () => {
			toast.success('Бронь перемещена в новую категорию')
		},
	})
}

// ---------------------------------------------------------------------------
// G8 Unassigned Reservations panel + auto-assign (2026-05-16).
//
// Per Cloudbeds canon + Kleinberg-Tardos Interval-Partition Greedy algorithm
// (verified 2026-05-16 research):
//   - useAssignRoom: per-booking pin specific roomId (idempotent same-room)
//   - useAutoAssignUnassigned: mass-assign via backend Interval-Partition
//     algorithm; partial-success canon — returns { assigned, skipped }
//   - useUnassignedBookings: list + count via polling (refetchInterval 5s)
//     для panel badge real-time refresh
// ---------------------------------------------------------------------------

function assignErrorMessage(err: ApiError, defaultMsg: string): string {
	if (err.code === 'INVALID_BOOKING_AMEND_STATE') {
		return 'Назначение недоступно в текущем статусе брони'
	}
	if (err.code === 'ROOM_ASSIGNMENT_CONFLICT') {
		return 'Номер не подходит: занят, другой категории, или отключён'
	}
	if (err.code === 'NOT_FOUND') {
		return 'Бронь или номер не найдены'
	}
	return err.message || defaultMsg
}

export function useAssignRoom(deps: AmendDeps) {
	return useAmendMutation<{ roomId: string }>(
		deps,
		'Номер назначен',
		'Не удалось назначить номер',
		(vars) =>
			api.api.v1.bookings[':id']['assign-room'].$patch({
				param: { id: deps.bookingId },
				json: { roomId: vars.roomId },
			}),
	)
}

interface AutoAssignDeps {
	propertyId: string | null
	windowFrom: string
	windowTo: string
}

export function useAutoAssignUnassigned(deps: AutoAssignDeps) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async () => {
			if (!deps.propertyId) throw new Error('propertyId required')
			const res = await api.api.v1.properties[':propertyId'].bookings['auto-assign'].$post({
				param: { propertyId: deps.propertyId },
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as {
				data: {
					assigned: Array<{ bookingId: string; roomId: string }>
					skipped: Array<{ bookingId: string; reason: string }>
				}
			}
			return body.data
		},
		onError: (err: ApiError) => {
			logger.warn('booking.autoAssign failed', { code: err.code, message: err.message })
			toast.error(assignErrorMessage(err, 'Не удалось распределить брони'))
		},
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ['bookings', deps.propertyId] })
			await queryClient.invalidateQueries({ queryKey: ['unassigned', deps.propertyId] })
		},
		onSuccess: (data) => {
			const assignedN = data.assigned.length
			const skippedN = data.skipped.length
			if (assignedN === 0 && skippedN === 0) {
				toast.info('Нет броней для распределения')
			} else if (skippedN === 0) {
				toast.success(`Распределено: ${assignedN}`)
			} else {
				toast.success(`Распределено: ${assignedN}. Пропущено: ${skippedN}`)
			}
		},
	})
}

/**
 * Polled unassigned-bookings list для panel badge + click-list. Per Cloudbeds
 * canon + TanStack 2026 polling docs (refetchInterval 5_000 — verified
 * research 2026-05-16). Cache key independent from grid bookings query —
 * panel survives grid window-shift.
 */
export function useUnassignedBookings(propertyId: string | null) {
	return useQuery({
		queryKey: ['unassigned', propertyId] as const,
		queryFn: async () => {
			if (!propertyId) return [] as BookingShape[]
			// Reuse list endpoint c assignedRoomId=null filter? No such filter
			// в bookingListParams; instead fetch all and filter client-side OR
			// use dedicated endpoint. For MVP: list w/ wide window и filter
			// client-side (SMB scale: ≤200 bookings per property).
			const res = await api.api.v1.properties[':propertyId'].bookings.$get({
				param: { propertyId },
				query: { status: 'confirmed' },
			})
			if (!res.ok) throw new Error('unassigned.list failed')
			const body = (await res.json()) as { data: BookingShape[] }
			return body.data.filter((b) => !b.assignedRoomId)
		},
		enabled: Boolean(propertyId),
		// 2026-05-22: SSE (`use-booking-events-stream.ts`) — primary real-time
		// channel. Polling сохраняем как defensive fallback для случаев SSE
		// disconnect / non-realtime panels. 30s достаточно для unassigned-panel
		// freshness (operator workflow не блокируется задержкой 30s в counter).
		// Default 5s полил backend 12×/min × ~10 operators в production → 7200
		// extra requests/hour для cosmetic counter, при том что SSE invalidates
		// same query на real booking events instantly.
		refetchInterval: 30_000,
		refetchIntervalInBackground: false,
		staleTime: 10_000,
		// G11 v3 (2026-05-18) — PII present (guestSnapshot full). NEVER persist
		// к IndexedDB per 152-ФЗ data-minimization + TanStack TkDodo canon.
		// In-memory only; refetched fresh after page reload.
		meta: { persist: false },
	})
}
