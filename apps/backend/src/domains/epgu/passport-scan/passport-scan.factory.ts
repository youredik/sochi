/**
 * Passport scan factory — composition root для consent + audit + storage repos.
 *
 * Sprint C 2026-05-23: extracts `sql` import от routes так что depcruise
 * `no-routes-to-db` rule passes. Routes (consent-revoke / data-export /
 * vision) receive built repos через PassportScanFactory type instead of
 * raw sql.
 *
 * Pattern aligned с `booking.factory.ts`, `room.factory.ts`, etc. (15+
 * existing factory call sites в codebase).
 *
 * Self-review Round 2 (2026-05-23 evening) — closes Senior P0-1, Senior P0-2,
 * Legal P0-1, Legal P0-2, Legal P0-4:
 *   - **objectKeys inside cascade tx** — was: route fetched keys outside tx,
 *     allowing concurrent scan to write fresh inputObjectKey мы missed.
 *     Now: tx returns canonical key set от same snapshot.
 *   - **`recordConsentAndAuditAtomic` no longer swallows errors** — caller gets
 *     err.message в result. 152-ФЗ ст.21 ч.4 forensic trail preserved.
 *   - **guestDocument cascade** — RTBF now nullifies guestDocument PII
 *     (was only audit + consent → stranded ст.20 violation).
 *   - **guestDocument list для DSAR** — list helper added на factory.
 *
 * Self-review Sprint C fix 2026-05-23 (Y3 + H3 + H5):
 *   - ID generation HOISTED outside `sql.begin({idempotent:true})` — idempotent
 *     retry replays the callback; in-callback `newId()` would mint fresh IDs
 *     per retry → duplicate consent + audit rows on retryable error. Pre-gen
 *     ID outside tx + pass IN guarantees same ID across retries.
 *   - Revoke timestamp generated ONCE outside repo helpers, reused для both
 *     UPDATE clock и route response → no drift between operator API response
 *     and DSAR export.
 *   - cascadeRtbfRevoke returns explicit { revokedAt, alreadyRevoked } —
 *     truthful state (canonical fix vs old `{revoked:true}` always-lie).
 */

import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../../db/index.ts'
import { dateOpt, textOpt, toTs } from '../../../db/ydb-helpers.ts'
import {
	createPassportOcrAuditRepo,
	type PassportOcrAuditRepo,
} from './audit/passport-ocr-audit.repo.ts'
import {
	createPhotoConsentLogRepo,
	type PhotoConsentLogRepo,
} from './consent/photo-consent-log.repo.ts'

/**
 * Slim guestDocument shape для DSAR export.
 *
 * **HONESTY GAP (Sprint C+ Senior P0-1 audit 2026-05-23d, deferred to M9)**:
 * NO production code path currently INSERTs into guestDocument. Vision scan route
 * writes consent + audit only (lines 100-110 are real PII storage); guestDocument
 * insertion is deferred к M9 booking integration. Senior expert confirmed:
 *   - `INSERT INTO guestDocument` grep returns only seed + tests + migration-
 *     registration-enqueuer SELECT (search-only, never writes).
 *   - migration-registration-detail-sheet.tsx:291-293 explicitly says
 *     «Persistence в guestDocument deferred до M9 booking integration».
 *   - Therefore: this DSAR field returns `[]` always, and the RTBF cascade UPDATE
 *     on guestDocument matches 0 rows (no-op).
 *
 * **Why we keep the cascade + DSAR code defensive**: when M9 lands and starts
 * writing guestDocument rows linked via photoConsentLogId, the cascade + DSAR
 * will immediately start working — no code changes required at that boundary.
 * Current behavior is HONEST: DSAR returns empty documents array (no PII to leak),
 * RTBF cascade scrubs whatever exists (currently nothing).
 *
 * Real PII for passport scan lives in `passportOcrAudit.surname/name/middleName/...`
 * which IS scrubbed by `auditRepo.nullifyEntitiesByConsentId`.
 */
export interface GuestDocumentExportRow {
	readonly id: string
	readonly identityMethod: string
	readonly documentSeries: string | null
	readonly documentNumber: string
	readonly documentIssuedBy: string | null
	readonly documentIssuedDate: Date | null
	readonly documentExpiryDate: Date | null
	readonly citizenshipIso3: string
	readonly objectStoragePath: string | null
	readonly createdAt: Date
	readonly entitiesAnonymizedAt: Date | null
}

interface GuestDocumentDbRow {
	id: string
	identityMethod: string
	documentSeries: string | null
	documentNumber: string
	documentIssuedBy: string | null
	documentIssuedDate: Date | null
	documentExpiryDate: Date | null
	citizenshipIso3: string
	objectStoragePath: string | null
	createdAt: Date
	entitiesAnonymizedAt: Date | null
}

interface GuestDocumentObjectKeyRow {
	objectStoragePath: string | null
}

export interface PassportScanFactory {
	readonly consentRepo: PhotoConsentLogRepo
	readonly auditRepo: PassportOcrAuditRepo
	/** Helper для transactional consent+audit write — used by vision.routes. */
	readonly recordConsentAndAuditAtomic: (input: AtomicWriteInput) => Promise<AtomicWriteResult>
	/** RTBF cascade — used by consent-revoke routes. nullify audit + revoke consent. */
	readonly cascadeRtbfRevoke: (input: RtbfRevokeInput) => Promise<RtbfRevokeResult>
	/** DSAR helper — guestDocument list. Round 2 P0-1 fix. */
	readonly listGuestDocumentsForExport: (
		tenantId: string,
		guestId: string,
	) => Promise<readonly GuestDocumentExportRow[]>
}

interface AtomicWriteInput {
	/** Consent insert payload (id generated by factory outside tx). */
	readonly consent: Parameters<PhotoConsentLogRepo['insertWithId']>[1]
	/** Audit insert payload, photoConsentLogId stitched by factory. */
	readonly audit: Omit<Parameters<PassportOcrAuditRepo['insertWithId']>[1], 'photoConsentLogId'>
}

interface AtomicWriteResult {
	readonly success: boolean
	readonly consentId: string | null
	/**
	 * Sprint C+ Senior P0-2 fix: audit row ID exposed so caller can PATCH
	 * `inputObjectKey` after S3 upload completes (reverse-order flow — see
	 * vision.routes.ts upload sequencing comment). Null when atomic write failed.
	 */
	readonly auditId: string | null
	/** Round 2 P0-2 fix: error name surfaced для forensic logging. Empty when success. */
	readonly errName: string | null
}

interface RtbfRevokeInput {
	readonly tenantId: string
	readonly consentId: string
	readonly reason: string
}

export interface RtbfRevokeResult {
	/** Server-clock timestamp когда revoke applied (canonical для DSAR + response). */
	readonly revokedAt: Date
	/** False — мы just revoked; true — был уже revoked before our call. */
	readonly alreadyRevoked: boolean
	/** Server-stored reason verbatim (нашу call's reason ИЛИ pre-existing one). */
	readonly revokedReason: string
	/**
	 * Round 2 P0-1 fix: object keys гарантированно captured INSIDE the tx
	 * (was: route fetched outside tx → race window allowed concurrent scan
	 * write новый inputObjectKey untracked). Caller uses этот list для S3 delete.
	 */
	readonly objectKeysToDelete: readonly string[]
}

export function createPassportScanFactory(sql: typeof SQL): PassportScanFactory {
	const consentRepo = createPhotoConsentLogRepo(sql)
	const auditRepo = createPassportOcrAuditRepo(sql)

	const recordConsentAndAuditAtomic = async (
		input: AtomicWriteInput,
	): Promise<AtomicWriteResult> => {
		// Self-review Y3 fix: pre-generate IDs OUTSIDE sql.begin. `idempotent:true`
		// causes YDB driver to replay callback on retryable errors; in-callback
		// newId() would mint NEW UUIDs per attempt → duplicate rows committed
		// (best-effort dedup в repo via UPSERT не covers different IDs).
		const consentId = newId('consent')
		const auditId = newId('passportOcrAudit')
		try {
			await sql.begin({ idempotent: true }, async (tx) => {
				// `tx` has the tagged-template interface compatible с repos;
				// cast разрешает sub-type (no `begin`/`do` on tx — мы не nesting).
				const consentRepoTx = createPhotoConsentLogRepo(tx as unknown as typeof SQL)
				const auditRepoTx = createPassportOcrAuditRepo(tx as unknown as typeof SQL)
				await consentRepoTx.insertWithId(consentId, input.consent)
				await auditRepoTx.insertWithId(auditId, {
					...input.audit,
					photoConsentLogId: consentId,
				})
			})
			return { success: true, consentId, auditId, errName: null }
		} catch (err) {
			// Round 2 P0-2 fix: surface error name к caller для forensic logging.
			// 152-ФЗ ст.21 ч.4 demands «возможность установления содержания» —
			// silent failure = forensic blackout.
			const errName = err instanceof Error ? err.name : 'UnknownError'
			return { success: false, consentId: null, auditId: null, errName }
		}
	}

	const cascadeRtbfRevoke = async (input: RtbfRevokeInput): Promise<RtbfRevokeResult> => {
		// Self-review H3 fix: single canonical timestamp shared across tx,
		// DSAR export, и operator API response — no clock-drift между repo
		// UPDATE и response body.
		const revokedAt = new Date()
		// Self-review H5: lookup ДО tx to determine alreadyRevoked truth-state.
		// Route's findById guard handles cross-tenant + missing — мы здесь
		// re-fetch к detect pre-revoked при concurrent calls (TOCTOU race window).
		const existing = await consentRepo.findById(input.tenantId, input.consentId)
		if (existing === null) {
			// Shouldn't reach — route filters. Defensive throw catches misuse.
			throw new Error(`cascadeRtbfRevoke: consent ${input.consentId} not found`)
		}
		if (existing.revokedAt !== null) {
			return {
				revokedAt: existing.revokedAt,
				alreadyRevoked: true,
				revokedReason: existing.revokedReason ?? '',
				objectKeysToDelete: [],
			}
		}
		// Round 2 P0-1 fix: collect object keys INSIDE tx (was: route fetched
		// outside → race window). Audit + guestDocument both contribute.
		// Round 2 Legal P0-2: guestDocument cascade — nullify PII + scrub.
		let objectKeysToDelete: readonly string[] = []
		await sql.begin({ idempotent: true }, async (tx) => {
			const txSql = tx as unknown as typeof SQL
			const auditRepoTx = createPassportOcrAuditRepo(txSql)
			const consentRepoTx = createPhotoConsentLogRepo(txSql)
			// 1) Collect inputObjectKey from audit table BEFORE nullify.
			const auditKeys = await auditRepoTx.findObjectKeysByConsentId(input.tenantId, input.consentId)
			// 2) Collect objectStoragePath from guestDocument linked via photoConsentLogId.
			const [docRows = []] = await txSql<GuestDocumentObjectKeyRow[]>`
				SELECT objectStoragePath FROM guestDocument
				WHERE tenantId = ${input.tenantId}
				  AND photoConsentLogId = ${input.consentId}
				  AND objectStoragePath IS NOT NULL
			`.idempotent(true)
			const docKeys = docRows
				.map((row) => row.objectStoragePath)
				.filter((path): path is string => path !== null)
			objectKeysToDelete = [...auditKeys, ...docKeys]

			// 3) Nullify audit PII.
			await auditRepoTx.nullifyEntitiesByConsentId(input.tenantId, input.consentId)
			// 4) Nullify guestDocument PII (Round 2 Legal P0-2). All structured PII
			//    columns → NULL except (tenantId, id, identityMethod, citizenshipIso3,
			//    createdAt) which stay для accountability trail. Mark entitiesAnonymizedAt.
			//    NB: documentNumber NOT NULL в schema — wipe to placeholder вместо NULL.
			//    citizenshipIso3 NOT NULL аналогично — keep как proof of ст.10 ч.2 basis.
			await txSql`
				UPDATE guestDocument
				SET documentSeries = ${textOpt(null)},
				    documentNumber = '[scrubbed-rtbf]',
				    documentIssuedBy = ${textOpt(null)},
				    documentIssuedDate = ${dateOpt(null)},
				    documentExpiryDate = ${dateOpt(null)},
				    objectStoragePath = ${textOpt(null)},
				    objectMimeType = ${textOpt(null)},
				    entitiesAnonymizedAt = ${toTs(revokedAt)}
				WHERE tenantId = ${input.tenantId}
				  AND photoConsentLogId = ${input.consentId}
			`
			// 5) Revoke consent with shared timestamp.
			await consentRepoTx.revokeAt(input.tenantId, input.consentId, input.reason, revokedAt)
		})
		return {
			revokedAt,
			alreadyRevoked: false,
			revokedReason: input.reason,
			objectKeysToDelete,
		}
	}

	const listGuestDocumentsForExport = async (
		tenantId: string,
		guestId: string,
	): Promise<readonly GuestDocumentExportRow[]> => {
		const [rows = []] = await sql<GuestDocumentDbRow[]>`
			SELECT id, identityMethod, documentSeries, documentNumber,
			       documentIssuedBy, documentIssuedDate, documentExpiryDate,
			       citizenshipIso3, objectStoragePath, createdAt, entitiesAnonymizedAt
			FROM guestDocument
			WHERE tenantId = ${tenantId} AND guestId = ${guestId}
			ORDER BY createdAt DESC
			LIMIT 1000
		`.idempotent(true)
		return rows.map((row) => ({
			id: row.id,
			identityMethod: row.identityMethod,
			documentSeries: row.documentSeries,
			documentNumber: row.documentNumber,
			documentIssuedBy: row.documentIssuedBy,
			documentIssuedDate: row.documentIssuedDate,
			documentExpiryDate: row.documentExpiryDate,
			citizenshipIso3: row.citizenshipIso3,
			objectStoragePath: row.objectStoragePath,
			createdAt: row.createdAt,
			entitiesAnonymizedAt: row.entitiesAnonymizedAt,
		}))
	}

	return {
		consentRepo,
		auditRepo,
		recordConsentAndAuditAtomic,
		cascadeRtbfRevoke,
		listGuestDocumentsForExport,
	}
}
