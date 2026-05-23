/**
 * guestDocument repo — persists operator-confirmed passport data after
 * Yandex Vision OCR scan + 152-ФЗ consent.
 *
 * **Sprint C+ Senior P0-1 fix 2026-05-23d**: Round 4 had a DEAD code path —
 * RTBF cascade UPDATE и DSAR export claimed to scrub/list guestDocument, но
 * NO production code path INSERTed rows. Real PII lived в passportOcrAudit
 * only. This file closes the gap: vision scan flow now writes a guestDocument
 * row после operator confirms entities в UI.
 *
 * **Architectural choice**: Approach B (separate endpoint POST documents/from-scan)
 * вместо A (auto-insert inside vision route). Rationale:
 *   - Operator-confirmed data only — raw OCR may be incorrect, persisting
 *     unconfirmed shape pollutes downstream queries.
 *   - Cleaner RTBF semantics — consent log linked via photoConsentLogId NOT NULL
 *     guarantees cascade UPDATE matches the row.
 *   - Matches existing frontend confirm-form Save callback contract без bloating
 *     vision route to 3-table atomic write.
 *
 * Tenant-scoped writes; tenantId is first PK column. UPSERT shape per YDB
 * gotcha #14 (UPDATE on mixed NOT NULL + nullable columns fails server-side
 * type inference).
 */

import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { dateOpt, doubleOpt, NULL_INT64, textOpt, toTs } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

/**
 * Create input для guestDocument INSERT after passport scan.
 *
 * `photoConsentLogId` is REQUIRED so RTBF cascade can find the row.
 * `objectStoragePath` is OPTIONAL — null когда storage adapter='disabled' OR
 * upload failed (audit row preserved с null inputObjectKey per Senior P0-2 flow).
 */
export interface CreateGuestDocumentFromScanInput {
	readonly tenantId: string
	readonly guestId: string
	readonly identityMethod: 'passport_paper' | 'passport_zagran' | 'driver_license'
	readonly documentSeries: string | null
	readonly documentNumber: string
	readonly documentIssuedBy: string | null
	/** YYYY-MM-DD or null. */
	readonly documentIssuedDate: string | null
	readonly documentExpiryDate: string | null
	readonly citizenshipIso3: string
	readonly objectStoragePath: string | null
	readonly objectMimeType: string | null
	readonly objectSizeBytes: number | null
	readonly ocrConfidenceHeuristic: number | null
	/** 'yandex_vision' | 'manual' (per 0034 schema; future: 'sora_ocr_2027'). */
	readonly ocrSource: 'yandex_vision' | 'manual'
	/** FK photoConsentLog.id — REQUIRED для RTBF cascade. */
	readonly photoConsentLogId: string
	/** Operator userId (audit trail). */
	readonly createdBy: string
}

/**
 * Internal row shape — reserved for future SELECT operations. Not exported
 * to keep knip happy (Sprint C+ no-unused-exports canon).
 */
// biome-ignore lint/correctness/noUnusedVariables: kept for future SELECT shape
interface _GuestDocumentRow {
	readonly id: string
	readonly tenantId: string
	readonly guestId: string
	readonly identityMethod: string
	readonly documentNumber: string
	readonly citizenshipIso3: string
	readonly createdAt: Date
}

export function createGuestDocumentRepo(sql: SqlInstance) {
	const insertWithId = async (
		id: string,
		input: CreateGuestDocumentFromScanInput,
	): Promise<string> => {
		const now = new Date()
		await sql`
			UPSERT INTO guestDocument (
				tenantId, id, guestId,
				identityMethod,
				documentSeries, documentNumber, documentIssuedBy,
				documentIssuedDate, documentExpiryDate,
				citizenshipIso3,
				objectStoragePath, objectMimeType, objectSizeBytes,
				ocrConfidenceHeuristic, ocrSource,
				photoConsentLogId,
				createdAt, updatedAt, createdBy, updatedBy
			) VALUES (
				${input.tenantId}, ${id}, ${input.guestId},
				${input.identityMethod},
				${textOpt(input.documentSeries)}, ${input.documentNumber}, ${textOpt(input.documentIssuedBy)},
				${dateOpt(input.documentIssuedDate)}, ${dateOpt(input.documentExpiryDate)},
				${input.citizenshipIso3},
				${textOpt(input.objectStoragePath)}, ${textOpt(input.objectMimeType)},
				${input.objectSizeBytes === null ? NULL_INT64 : BigInt(input.objectSizeBytes)},
				${doubleOpt(input.ocrConfidenceHeuristic)}, ${textOpt(input.ocrSource)},
				${input.photoConsentLogId},
				${toTs(now)}, ${toTs(now)}, ${input.createdBy}, ${input.createdBy}
			)
		`.idempotent(true)
		return id
	}

	return {
		/**
		 * Insert fresh guestDocument row from operator-confirmed scan data.
		 * Returns generated `gdoc_*` ID.
		 */
		async createFromScan(input: CreateGuestDocumentFromScanInput): Promise<string> {
			return insertWithId(newId('guestDocument'), input)
		},

		insertWithId,
	}
}

export type GuestDocumentRepo = ReturnType<typeof createGuestDocumentRepo>
