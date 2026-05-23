/**
 * Passport scan mutation hook — POST /api/v1/passport/scan.
 *
 * Per `project_m8_a_6_ui_canonical.md`:
 *   - 152-ФЗ consent gate: caller MUST set consent152fzAccepted=true
 *   - Returns RecognizePassportResponse с per-field confidence + outcome
 *   - Error mapping: 403 RBAC, 400 validation
 */
import type { IdentityMethod, RecognizePassportResponse } from '@horeca/shared'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export interface ScanPassportInput {
	imageBase64: string
	mimeType: 'image/jpeg' | 'image/png' | 'application/pdf'
	countryHint?: string | null
	identityMethod?: IdentityMethod
	/** Soft FK guest.id — для photoConsentLog linkage (Sprint B). */
	guestId: string
	/** Версия consent text (frontend snapshot, CONSENT_152FZ_VERSION). */
	consent152fzVersion: string
	/** Sprint C: verbatim consent text shown — tamper-proof proof per 152-ФЗ ст.9 ч.4. */
	consent152fzTextSnapshot: string
	/**
	 * Sprint C+ 2-checkbox state per legal-expert audit 2026-05-23d.
	 * `citizenshipSpecial` was Round 4 mis-labeling of citizenship as ст.10 special
	 * category. Citizenship = country code (ст.6 общие ПДн), не ethnic origin (ст.10).
	 * Backend keeps `citizenshipSpecial` as optional for backward-compat — new
	 * clients omit it; old clients (pre-2026-05-23d deploy) still pass validation.
	 */
	separateConsents: {
		generalPdn: true
		biometricPhoto: true
		citizenshipSpecial?: true
	}
	consent152fzAccepted: true
	/** UUID per click — Stripe-style idempotency. */
	idempotencyKey: string
}

export function useScanPassport() {
	return useMutation({
		mutationFn: async (input: ScanPassportInput): Promise<RecognizePassportResponse> => {
			const { idempotencyKey, ...jsonBody } = input
			const res = await api.api.v1.passport.scan.$post(
				{ json: jsonBody },
				// init.headers — путь для custom HTTP headers через Hono RPC client.
				// `Idempotency-Key` Stripe-style canon — backend dedupes повторные клики.
				{ init: { headers: { 'Idempotency-Key': idempotencyKey } } },
			)
			if (!res.ok) {
				const status = (res as Response).status
				const body = (await res.json().catch(() => ({}))) as {
					error?: { code?: string; message?: string }
				}
				const msg = body.error?.message ?? `Сканирование не удалось (HTTP ${status})`
				if (status === 403) throw new Error('Недостаточно прав для сканирования паспорта')
				if (status === 404) throw new Error('Гость не найден в текущем тенант-контексте')
				if (status === 413) throw new Error('Файл слишком большой — попробуйте меньшее фото')
				if (status === 428) throw new Error('Технический сбой — пожалуйста, обновите страницу')
				if (status === 429) throw new Error('Слишком много сканов — подождите минуту')
				if (status === 400) throw new Error(msg)
				if (status === 500) throw new Error('Сервис распознавания временно недоступен')
				throw new Error(msg)
			}
			const body = (await res.json()) as { data: RecognizePassportResponse }
			return body.data
		},
	})
}
