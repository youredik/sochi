/**
 * Persist guestDocument from a confirmed passport scan.
 *
 * **Sprint C+ Senior P0-1 fix 2026-05-23d**: closes dead-code gap exposed by
 * 5-parallel-expert audit. Round 4 had no production path that INSERTed
 * guestDocument rows, so RTBF cascade UPDATE matched 0 rows and DSAR documents
 * array was always empty. This hook closes that gap.
 *
 * Flow:
 *   1. Operator scans passport → useScanPassport returns ScanPassportResult
 *      with `photoConsentLogId` (created in vision route atomic write).
 *   2. Operator confirms/edits extracted entities в confirm-form.
 *   3. Operator clicks Save → caller invokes useSaveDocumentFromScan with
 *      the operator-confirmed shape + photoConsentLogId.
 *   4. Backend INSERTs guestDocument linked through photoConsentLogId — RTBF
 *      cascade now has a real row to scrub when consent is revoked.
 */

import type { PassportEntities } from '@horeca/shared'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

export interface SaveDocumentFromScanInput {
	guestId: string
	identityMethod: 'passport_paper' | 'passport_zagran' | 'driver_license'
	/** Operator-confirmed entities (may have edits over raw OCR). */
	entities: PassportEntities
	/** From scan response data.photoConsentLogId — links new row для RTBF cascade. */
	photoConsentLogId: string
	/** OCR confidence (passed-through from scan response). */
	ocrConfidenceHeuristic: number
	/**
	 * Object Storage path if photo upload succeeded. Sprint C+ Senior P0-2
	 * reverse-order vision flow may leave this null on upload failure — что
	 * означает audit-only-no-image scenario (lifecycle backstop applies).
	 *
	 * Not surfaced through current scan response shape — null pass-through is
	 * defensible default until vision response exposes the stored objectKey
	 * (M9 enhancement).
	 */
	objectStoragePath: string | null
	objectMimeType: 'image/jpeg' | 'image/png' | 'application/pdf' | null
	objectSizeBytes: number | null
}

export interface SaveDocumentFromScanResult {
	documentId: string
}

export function useSaveDocumentFromScan() {
	return useMutation({
		mutationFn: async (input: SaveDocumentFromScanInput): Promise<SaveDocumentFromScanResult> => {
			// Map PassportEntities → from-scan request body. RU паспорт обычно
			// серия+номер = '<4 digits> <6 digits>' — extract series if pattern matches,
			// otherwise leave documentSeries null.
			const docRaw = (input.entities.documentNumber ?? '').trim()
			const splitMatch = docRaw.match(/^(\d{4})\s+(\d{6})$/)
			const documentSeries: string | null = splitMatch?.[1] ?? null
			const documentNumber: string = splitMatch?.[2] ?? docRaw
			if (documentNumber.length === 0) {
				throw new Error('Номер документа обязателен для сохранения guestDocument')
			}
			// Citizenship fallback — 'rus' для passport_paper (RU internal), else error.
			const citizenshipIso3 =
				(input.entities.citizenshipIso3 ?? '').trim().toLowerCase() ||
				(input.identityMethod === 'passport_paper' ? 'rus' : '')
			if (!/^[a-z]{3}$/.test(citizenshipIso3)) {
				throw new Error('citizenshipIso3 (3-буквенный ISO 3166-1) обязателен')
			}
			const res = await api.api.v1.guests[':guestId'].documents['from-scan'].$post({
				param: { guestId: input.guestId },
				json: {
					identityMethod: input.identityMethod,
					documentSeries,
					documentNumber,
					documentIssuedBy: null,
					documentIssuedDate: input.entities.issueDate ?? null,
					documentExpiryDate: input.entities.expirationDate ?? null,
					citizenshipIso3,
					objectStoragePath: input.objectStoragePath,
					objectMimeType: input.objectMimeType,
					objectSizeBytes: input.objectSizeBytes,
					ocrConfidenceHeuristic: input.ocrConfidenceHeuristic,
					ocrSource: 'yandex_vision',
					photoConsentLogId: input.photoConsentLogId,
				},
			})
			if (!res.ok) {
				const status = (res as Response).status
				const body = (await res.json().catch(() => ({}))) as {
					error?: { code?: string; message?: string }
				}
				const msg = body.error?.message ?? `Сохранение документа не удалось (HTTP ${status})`
				if (status === 403) throw new Error('Недостаточно прав для сохранения документа гостя')
				if (status === 404) throw new Error('Гость не найден в текущем тенант-контексте')
				if (status === 400) throw new Error(msg)
				throw new Error(msg)
			}
			const body = (await res.json()) as { data: SaveDocumentFromScanResult }
			return body.data
		},
	})
}
