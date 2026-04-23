import type { PropertyCreateInput, RoomCreateInput, RoomTypeCreateInput } from '@horeca/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse, extractApiError } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'
import { buildSeedPayload } from '../lib/seed.ts'

/**
 * Create mutations for the setup wizard. Each invalidates its own list
 * query so the dashboard (and later the chessboard) sees the new entity
 * without a manual reload. `idempotency-key` header omitted here — wizard
 * is a one-shot interactive flow, offline-sync mutations arrive in M5e.
 */

export function useCreateProperty() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: PropertyCreateInput) => {
			const res = await api.api.v1.properties.$post({ json: input })
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: { id: string; name: string; slug?: string } }
			return body.data
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['properties'] })
			toast.success('Гостиница создана')
		},
		onError: (err: ApiError) => {
			logger.warn('property.create failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}

export function useCreateRoomType(propertyId: string | null) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: RoomTypeCreateInput) => {
			if (!propertyId) {
				throw extractApiError({ message: 'Нет propertyId — шаг гостиницы не завершён' })
			}
			const res = await api.api.v1.properties[':propertyId']['room-types'].$post({
				param: { propertyId },
				json: input,
			})
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: { id: string; name: string } }
			return body.data
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['roomTypes', propertyId] })
			toast.success('Тип номеров создан')
		},
		onError: (err: ApiError) => {
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
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: { id: string; number: string } }
			return body.data
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['rooms'] })
		},
		onError: (err: ApiError) => {
			logger.warn('room.create failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}

/**
 * Create the first rate plan + seed 30 days of rate + availability.
 *
 * Booking creation (M5e.1) requires all three: a sellable plan, a price
 * per date (backend `booking.service.create` looks up rate for each
 * night), and an availability row with `allotment >= sold + 1`. Without
 * seeding, the grid has nothing rentable and the user can't create a
 * single booking.
 *
 * 30-day forward window (not 365) — enough for onboarding-demo; admin
 * rate-management UI in a later phase handles real seasonal pricing.
 *
 * Parallel POSTs for rate + availability — independent resources, no
 * ordering constraint on the server side.
 */
export function useCreateRatePlan(roomTypeId: string | null, inventoryCount: number | null) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: { code: string; name: string; nightlyRub: number }) => {
			if (!roomTypeId) {
				throw extractApiError({ message: 'Нет roomTypeId — шаг типа номеров не завершён' })
			}
			if (inventoryCount === null) {
				throw extractApiError({
					code: 'WIZARD_MISSING_INVENTORY',
					message: 'Количество номеров не передано — начните мастер заново.',
				})
			}

			// 1. Create the plan (defaults: refundable, no meals, 24h cancel)
			const planRes = await api.api.v1['rate-plans'].$post({
				json: {
					roomTypeId,
					name: input.name,
					code: input.code,
					isDefault: true,
					isRefundable: true,
					cancellationHours: 24,
					mealsIncluded: 'none',
					minStay: 1,
					maxStay: 365,
				},
			})
			if (!planRes.ok) throw await errorFromResponse(planRes)
			const planBody = (await planRes.json()) as { data: { id: string } }
			const ratePlanId = planBody.data.id

			// 2. Build seeding payload via pure helper (unit-tested: money
			//    precision via BigInt, UTC-anchored dates, consecutive-day
			//    invariant, allotment/days adversarial guards).
			//    `inventoryCount` snapshotted on the wizard store at step 2
			//    — fail-loud above if it's null rather than silent ??1
			//    fallback (which would silently under-seed allotment and
			//    cause mysterious overbooking 422s later).
			const { rates, availability } = buildSeedPayload({
				nightlyRub: input.nightlyRub,
				allotment: inventoryCount,
				days: 30,
			})

			const [rateRes, availRes] = await Promise.all([
				api.api.v1['rate-plans'][':ratePlanId'].rates.$post({
					param: { ratePlanId },
					json: {
						// amount as string-of-bigint to match backend wire convention;
						// `buildSeedPayload` guarantees this shape (see lib/seed.ts).
						rates: rates.map((r) => ({ date: r.date, amount: r.amount, currency: r.currency })),
					},
				}),
				api.api.v1['room-types'][':roomTypeId'].availability.$post({
					param: { roomTypeId },
					json: { rates: availability.map((a) => ({ date: a.date, allotment: a.allotment })) },
				}),
			])
			if (!rateRes.ok || !availRes.ok) {
				// KNOWN-WEAKNESS: partial-seed failure has no compensating
				// rollback (would require DELETE for whichever succeeded).
				// For this wizard flow the failure is rare and owner sees
				// the toast — next attempt can recreate with fresh code
				// suffix. Refactor to tx-wrapping server endpoint is the
				// proper fix; noted in memory.
				throw extractApiError({
					message: 'Не удалось заполнить цены и доступность на 30 дней вперёд',
					code: 'RATE_OR_AVAILABILITY_SEED_FAILED',
				})
			}

			return { id: ratePlanId }
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['ratePlans'] })
			await queryClient.invalidateQueries({ queryKey: ['rates'] })
			await queryClient.invalidateQueries({ queryKey: ['availability'] })
			toast.success('Тариф создан, цены на 30 дней заполнены')
		},
		onError: (err: ApiError) => {
			logger.warn('ratePlan.create failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}
