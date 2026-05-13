import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { type ApiError, errorFromResponse } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'
import type { DaDataParty } from '../lib/dadata.ts'

/**
 * Mutation wrapping `POST /api/v1/onboarding/find-by-inn`. Returns the
 * canonical DaDataParty when DaData has a record, `null` for unknown ИНН
 * or fail-soft on the backend (the adapter swallows transient errors and
 * surfaces them as `data: null`).
 *
 * UI contract: caller distinguishes «typed wrong ИНН» (`data === null`)
 * from «service down» — but here both shapes collapse into `data: null`
 * because the backend's fail-soft posture is deliberate. The wizard copy
 * for both cases is the same: «не нашли — заполните вручную».
 */
export function useFindByInn() {
	return useMutation<DaDataParty | null, ApiError, { inn: string }>({
		mutationFn: async ({ inn }) => {
			const res = await api.api.v1.onboarding['find-by-inn'].$post({ json: { inn } })
			if (!res.ok) throw await errorFromResponse(res)
			const body = (await res.json()) as { data: DaDataParty | null }
			return body.data
		},
		onError: (err) => {
			logger.warn('onboarding.findByInn failed', { code: err.code, message: err.message })
			toast.error(err.message)
		},
	})
}
