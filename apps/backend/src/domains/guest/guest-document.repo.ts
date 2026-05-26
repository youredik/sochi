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
 * to keep knip happy (Sprint C+ no-unused-exports canon). Underscore-prefix
 * exempts из biome `noUnusedVariables` (Round 12 — stale suppression dropped).
 */
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

	/**
	 * **2026-05-24** — Cross-session lookup для booking-edit-sheet hard-gate
	 * + server-side booking-service mirror (canonical 2026 PMS UX per
	 * Stayntouch / Mews / Cloudbeds: Заезд CTA disabled until passport scan
	 * complete для foreign citizenship per 109-ФЗ ст. 22 ч. 3 + ПП РФ № 9).
	 *
	 * **152-ФЗ ст. 18 minimization (Sprint C+ Round 7 Senior P0)**: returns
	 * pre-masked summary — repo NEVER returns raw documentNumber to handlers
	 * so future caller can't accidentally log full PII. Last-4 char tail
	 * computed внутри SQL projection, full string lives только в DB.
	 *
	 * **RTBF correctness (Sprint C+ Round 7 Senior P0)**: JOIN photoConsentLog
	 * so revoked-but-not-yet-scrubbed rows are filtered out. `entitiesAnonymizedAt`
	 * = downstream cascade marker (set by scrub cron after revoke), `revokedAt`
	 * = immediate source-of-truth. Either active → row excluded.
	 *
	 * **scannedAt = acceptedAt (NOT createdAt)**: ПП РФ № 9 audit canon —
	 * 24-hour countdown starts at consent acceptance moment (operator-clicked
	 * 152-ФЗ согласие), not at our INSERT timestamp. Operator может re-confirm
	 * scan через 2 weeks → DB createdAt = re-confirm, but legal 24h window
	 * fires from original consent.acceptedAt.
	 *
	 * Returns separate `null` (never scanned) vs `revokedAt` (was scanned,
	 * consent revoked) — UI shows different alert wording per 152-ФЗ ст. 20
	 * canon (operator вправе отказать в размещении при отзыве согласия).
	 *
	 * Uses `idxGuestDocumentTenantGuest` (`{tenantId, guestId}` global index,
	 * canonical 0034). ORDER BY createdAt DESC LIMIT 1 — adversarial truth:
	 * NOT covering sort, materializes matching rows then sorts. О(N retries)
	 * for guests с rescan history. Acceptable до N≈10 (production cap).
	 */
	const findActiveForGuest = async (
		tenantId: string,
		guestId: string,
	): Promise<{
		readonly id: string
		readonly identityMethod: 'passport_paper' | 'passport_zagran' | 'driver_license'
		readonly documentNumberMaskedTail: string
		readonly citizenshipIso3: string
		readonly photoConsentLogId: string
		readonly scannedAt: Date
	} | null> => {
		// Two-step: fetch most-recent non-anonymized doc, then verify linked
		// consent not revoked. YDB does NOT support cross-table JOIN-in-WHERE
		// cleanly без подзапросов в same tx; two roundtrips simpler than
		// view-based join, hits same index.
		const [docRows = []] = await sql<
			Array<{
				id: string
				identityMethod: string
				documentNumber: string
				citizenshipIso3: string
				photoConsentLogId: string
			}>
		>`
			SELECT id, identityMethod, documentNumber, citizenshipIso3, photoConsentLogId
			FROM guestDocument VIEW idxGuestDocumentTenantGuest
			WHERE tenantId = ${tenantId}
			  AND guestId = ${guestId}
			  AND entitiesAnonymizedAt IS NULL
			ORDER BY createdAt DESC
			LIMIT 1
		`.idempotent(true)
		const doc = docRows[0]
		if (!doc) return null
		// Verify consent not revoked + fetch canonical acceptedAt for audit.
		const [consentRows = []] = await sql<Array<{ acceptedAt: Date; revokedAt: Date | null }>>`
			SELECT acceptedAt, revokedAt
			FROM photoConsentLog
			WHERE tenantId = ${tenantId} AND id = ${doc.photoConsentLogId}
		`.idempotent(true)
		const consent = consentRows[0]
		if (!consent || consent.revokedAt !== null) return null
		// 152-ФЗ ст.18 mask inside repo — handler никогда не видит raw number.
		const trimmed = doc.documentNumber.replace(/\s+/g, '')
		const documentNumberMaskedTail = trimmed.length >= 4 ? trimmed.slice(-4) : trimmed
		const im = doc.identityMethod as 'passport_paper' | 'passport_zagran' | 'driver_license'
		return {
			id: doc.id,
			identityMethod: im,
			documentNumberMaskedTail,
			citizenshipIso3: doc.citizenshipIso3,
			photoConsentLogId: doc.photoConsentLogId,
			scannedAt: consent.acceptedAt,
		}
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
		findActiveForGuest,
	}
}

export type GuestDocumentRepo = ReturnType<typeof createGuestDocumentRepo>
