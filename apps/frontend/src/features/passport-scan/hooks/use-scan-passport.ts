/**
 * Passport scan mutation hook — POST /api/v1/passport/scan.
 *
 * Per `project_m8_a_6_ui_canonical.md`:
 *   - 152-ФЗ consent gate: caller MUST set consent152fzAccepted=true
 *   - Returns RecognizePassportResponse с per-field confidence + outcome
 *   - Error mapping: 403 RBAC, 400 validation
 */
import type { RecognizePassportResponse } from '@horeca/shared'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export interface ScanPassportInput {
	imageBase64: string
	mimeType: 'image/jpeg' | 'image/png' | 'image/heic' | 'application/pdf'
	countryHint?: string | null
	consent152fzAccepted: true
}

export function useScanPassport() {
	return useMutation({
		mutationFn: async (input: ScanPassportInput): Promise<RecognizePassportResponse> => {
			const res = await api.api.v1.passport.scan.$post({
				json: input,
			})
			if (!res.ok) {
				const status = (res as Response).status
				const body = (await res.json().catch(() => ({}))) as {
					error?: { code?: string; message?: string }
				}
				const msg = body.error?.message ?? `Сканирование не удалось (HTTP ${status})`
				if (status === 403) throw new Error('Недостаточно прав для сканирования паспорта')
				if (status === 400) throw new Error(msg)
				throw new Error(msg)
			}
			const body = (await res.json()) as { data: RecognizePassportResponse }
			return body.data
		},
	})
}
