/**
 * Passport preview-scan mutation hook — POST /api/v1/passport/preview-scan.
 *
 * Отличие от `useScanPassport` (use-scan-passport.ts): это OCR-only
 * автозаполнение для формы СОЗДАНИЯ брони, когда гостя ещё нет. НЕТ
 * guestId/consent/idempotency — backend ничего не сохраняет (152-ФЗ transient:
 * изображение уходит в Yandex Vision, у нас не хранится). Биометрическое
 * согласие ст.11 + photo storage + guestDocument INSERT происходят на ЗАЕЗДЕ
 * через полный `useScanPassport` + POST /guests/:id/documents/from-scan.
 *
 * Возвращает извлечённые entities для подстановки в поля формы. Оператор
 * проверяет/правит → submit создаёт гостя с реальными данными (general ПДн
 * ст.6 — тот же правовой базис, что ручной ввод).
 */
import type { IdentityMethod, RecognizePassportResponse } from '@horeca/shared'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export interface PreviewScanInput {
	imageBase64: string
	mimeType: 'image/jpeg' | 'image/png' | 'application/pdf'
	countryHint?: string | null
	identityMethod?: IdentityMethod
}

/** Подмножество RecognizePassportResponse, возвращаемое preview-route (без persist-полей). */
export interface PreviewScanResult {
	readonly entities: RecognizePassportResponse['entities']
	readonly detectedCountryIso3: string | null
	readonly isCountryWhitelisted: boolean
	readonly confidenceHeuristic: number
	readonly outcome: RecognizePassportResponse['outcome']
}

export function useScanPassportPreview() {
	return useMutation({
		mutationFn: async (input: PreviewScanInput): Promise<PreviewScanResult> => {
			// Hyphenated path segment → bracket-access на typed RPC client.
			const res = await api.api.v1.passport['preview-scan'].$post({ json: input })
			if (!res.ok) {
				const status = (res as Response).status
				const body = (await res.json().catch(() => ({}))) as {
					error?: { code?: string; message?: string }
				}
				const msg = body.error?.message ?? `Распознавание не удалось (HTTP ${status})`
				// Status→RU mapping (как в use-scan-passport). Сообщения trusted (RU),
				// caller показывает их напрямую — backend error.message не светится.
				if (status === 403) throw new Error('Недостаточно прав для сканирования паспорта')
				if (status === 413) throw new Error('Файл слишком большой — попробуйте меньшее фото')
				if (status === 429) throw new Error('Слишком много сканов — подождите минуту')
				if (status === 400) throw new Error(msg)
				if (status === 500) throw new Error('Сервис распознавания временно недоступен')
				throw new Error(msg)
			}
			const body = (await res.json()) as { data: PreviewScanResult }
			return body.data
		},
	})
}
