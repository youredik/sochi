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
export function useCreateRatePlan(propertyId: string | null, roomTypeId: string | null) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: { code: string; name: string; nightlyRub: number }) => {
			if (!roomTypeId || !propertyId)
				throw { message: 'Нет roomTypeId — шаг типа номеров не завершён' }

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
			if (!planRes.ok) {
				const body = (await planRes.json().catch(() => null)) as { error?: unknown } | null
				throw extractError(body?.error ?? { message: `HTTP ${planRes.status}` })
			}
			const planBody = (await planRes.json()) as { data: { id: string } }
			const ratePlanId = planBody.data.id

			// 2. Seed 30-day forward rate + availability in parallel
			const today = new Date()
			const rates = Array.from({ length: 30 }, (_, i) => {
				const d = new Date(today)
				d.setUTCDate(today.getUTCDate() + i)
				return {
					date: d.toISOString().slice(0, 10),
					amount: String(BigInt(input.nightlyRub) * 1_000_000n), // RUB → micros
					currency: 'RUB' as const,
				}
			})
			// Pull inventoryCount from the freshly-created roomType cache if available;
			// fall back to 1 which matches our wizard default and is a safe
			// lower bound (cannot accidentally over-allocate).
			const cachedRoomType = queryClient
				.getQueryData<Array<{ id: string; inventoryCount: number }>>(['roomTypes', propertyId])
				?.find((rt) => rt.id === roomTypeId)
			const allotment = cachedRoomType?.inventoryCount ?? 1
			const availability = rates.map((r) => ({ date: r.date, allotment }))

			const [rateRes, availRes] = await Promise.all([
				api.api.v1['rate-plans'][':ratePlanId'].rates.$post({
					param: { ratePlanId },
					json: { rates },
				}),
				api.api.v1['room-types'][':roomTypeId'].availability.$post({
					param: { roomTypeId },
					json: { rates: availability },
				}),
			])
			if (!rateRes.ok || !availRes.ok) {
				throw {
					message: 'Не удалось заполнить цены и доступность на 30 дней вперёд',
					code: 'RATE_OR_AVAILABILITY_SEED_FAILED',
				}
			}

			return { id: ratePlanId }
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['ratePlans'] })
			await queryClient.invalidateQueries({ queryKey: ['rates'] })
			await queryClient.invalidateQueries({ queryKey: ['availability'] })
			toast.success('Тариф создан, цены на 30 дней заполнены')
		},
		onError: (err: { code?: string; message: string }) => {
			logger.warn('ratePlan.create failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}
