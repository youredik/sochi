import type { City } from '@horeca/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'
import { userMessageFor } from '../../../lib/user-message.ts'

export interface BulkInventoryInput {
	property: {
		name: string
		address: string
		city: City
		timezone?: string
		tourismTaxRateBps?: number | null
	}
	rooms: number
	avgPriceRub: number
}

export interface BulkInventoryResult {
	propertyId: string
	roomTypeId: string
	ratePlanId: string
	roomIds: string[]
	avgPriceRub: number
}

/**
 * Mutation wrapping `POST /api/v1/onboarding/inventory` — the single-tx
 * bulk-create that lands property + roomType + N rooms + ratePlan in one
 * round-trip. On success invalidates the `properties` query so the dashboard
 * route guard at `/o/$orgSlug/` no longer redirects back into the wizard,
 * AND the `roomTypes` / `rooms` / `ratePlans` queries so Шахматка opens with
 * a fully-populated calendar skeleton.
 *
 * No `Idempotency-Key` header — the wizard is an interactive one-shot flow
 * and double-submit protection comes from the submit-button disabled state
 * while `isPending`. CI scripts that re-run the bulk endpoint в hot loops
 * should pass their own key.
 */
export function useBulkInventory() {
	const queryClient = useQueryClient()
	return useMutation<BulkInventoryResult, ApiError, BulkInventoryInput>({
		mutationFn: async (input) => {
			const res = await api.api.v1.onboarding.inventory.$post({ json: input })
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: BulkInventoryResult }
			return body.data
		},
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ['properties'] }),
				queryClient.invalidateQueries({ queryKey: ['roomTypes'] }),
				queryClient.invalidateQueries({ queryKey: ['rooms'] }),
				queryClient.invalidateQueries({ queryKey: ['ratePlans'] }),
			])
			toast.success('Гостиница и номера созданы')
		},
		onError: (err) => {
			logger.warn('onboarding.inventory failed', { code: err.code, message: err.message })
			toast.error(userMessageFor(err, 'Не удалось сохранить инвентарь'))
		},
	})
}
