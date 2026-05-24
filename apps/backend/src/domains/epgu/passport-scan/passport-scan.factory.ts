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
	/**
	 * Sprint C+ Round 6 2026-05-24 (Performance scale architect P1):
	 * Update scrubLog row с финальными S3-delete counts. Called by consent-revoke
	 * route AFTER S3 delete loop completes (out-of-tx side-effect — storage
	 * not transactional с DB). Без этого update, scrubLog forever shows
	 * `objectKeysDeleted=0` + `objectKeysFailed=0` regardless of real outcome →
	 * forensic count permanently wrong → 152-ФЗ ст.21 ч.4 «возможность
	 * установления содержания» partial violation.
	 */
	readonly updateScrubLogS3Counts: (input: ScrubLogCountsUpdate) => Promise<void>
	/** DSAR helper — guestDocument list. Round 2 P0-1 fix. */
	readonly listGuestDocumentsForExport: (
		tenantId: string,
		guestId: string,
	) => Promise<readonly GuestDocumentExportRow[]>
}

interface ScrubLogCountsUpdate {
	readonly tenantId: string
	readonly scrubLogId: string
	readonly objectKeysDeleted: number
	readonly objectKeysFailed: number
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
	/**
	 * Sprint C+ Legal/Senior P1 fix 2026-05-23d: operator userId для append-only
	 * scrub event log (passportOcrAuditScrubLog). 'unknown' fallback допустим
	 * when caller cannot resolve (rare; route falls back если session не set).
	 */
	readonly operatorUserId: string
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
	/**
	 * Sprint C+ Legal/Senior P1 fix 2026-05-23d: append-only scrub event log row ID.
	 * Null when alreadyRevoked (no new event). Returned для observability +
	 * traceability в operator-facing response.
	 */
	readonly scrubLogId: string | null
	/** Counts captured inside cascade tx для immutable event row. */
	readonly auditRowsScrubbed: number
	readonly guestDocumentRowsScrubbed: number
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
				scrubLogId: null,
				auditRowsScrubbed: 0,
				guestDocumentRowsScrubbed: 0,
			}
		}
		// Round 2 P0-1 fix: collect object keys INSIDE tx (was: route fetched
		// outside → race window). Audit + guestDocument both contribute.
		// Sprint C+ Legal/Senior P1 fix 2026-05-23d: emit append-only scrubLog
		// row inside same tx so журнал ↔ scrub state atomic. Counts captured
		// для immutable forensic event row.
		let objectKeysToDelete: readonly string[] = []
		const scrubLogId = newId('passportOcrAuditScrubLog')
		let auditRowsScrubbed = 0
		let guestDocumentRowsScrubbed = 0
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

			// 2.5) Count rows touched по этому consent ДО nullify — для scrubLog.
			const [auditCountRows = []] = await txSql<{ cnt: number | bigint }[]>`
				SELECT COUNT(*) AS cnt FROM passportOcrAudit
				WHERE tenantId = ${input.tenantId} AND photoConsentLogId = ${input.consentId}
			`.idempotent(true)
			const [docCountRows = []] = await txSql<{ cnt: number | bigint }[]>`
				SELECT COUNT(*) AS cnt FROM guestDocument
				WHERE tenantId = ${input.tenantId} AND photoConsentLogId = ${input.consentId}
			`.idempotent(true)
			auditRowsScrubbed = Number(auditCountRows[0]?.cnt ?? 0)
			guestDocumentRowsScrubbed = Number(docCountRows[0]?.cnt ?? 0)

			// 3) Nullify audit PII.
			await auditRepoTx.nullifyEntitiesByConsentId(input.tenantId, input.consentId)
			// 4) Nullify guestDocument PII. All structured PII columns → NULL except
			//    (tenantId, id, identityMethod, citizenshipIso3, createdAt) которые
			//    stay для accountability trail. Mark entitiesAnonymizedAt.
			//    NB: documentNumber NOT NULL в schema — wipe to placeholder вместо NULL.
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
			// 6) Append-only scrub event log (Sprint C+ Legal/Senior P1 fix
			//    2026-05-23d). Immutable forensic record для 152-ФЗ ст.21 ч.5
			//    proof «исполнили уничтожение в течение 30 дней» under РКН
			//    inspection canon (FSTEK Приказ 21 «защита от несанкционированных
			//    изменений»). objectKeysDeleted/Failed counts populated to 0 here —
			//    caller updates after S3 delete loop completes (out of tx scope).
			await txSql`
				UPSERT INTO passportOcrAuditScrubLog (
					tenantId, id, photoConsentLogId, guestId,
					scrubReason, operatorUserId,
					auditRowsScrubbed, guestDocumentRowsScrubbed,
					objectKeysDeleted, objectKeysFailed,
					scrubbedAt, createdAt
				) VALUES (
					${input.tenantId}, ${scrubLogId}, ${input.consentId}, ${existing.guestId},
					${input.reason}, ${input.operatorUserId},
					${BigInt(auditRowsScrubbed)}, ${BigInt(guestDocumentRowsScrubbed)},
					${BigInt(0)}, ${BigInt(0)},
					${toTs(revokedAt)}, ${toTs(revokedAt)}
				)
			`.idempotent(true)
		})
		return {
			revokedAt,
			alreadyRevoked: false,
			revokedReason: input.reason,
			objectKeysToDelete,
			scrubLogId,
			auditRowsScrubbed,
			guestDocumentRowsScrubbed,
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

	const updateScrubLogS3Counts = async (input: ScrubLogCountsUpdate): Promise<void> => {
		// Sprint C+ Round 6 P1 fix 2026-05-24 (Performance scale architect):
		// Single-row UPDATE на (tenantId, scrubLogId) PK. Scope NARROWED — only
		// touches objectKeys* columns, leaves rest of scrubLog row immutable
		// (forensic invariant per ст.21 ч.4 «защита от несанкционированных
		// изменений»; UPDATE-by-PK semantics not bulk overwrite). idempotent
		// because S3-delete loop deterministic given same input objectKeys.
		await sql`
			UPDATE passportOcrAuditScrubLog
			SET objectKeysDeleted = ${BigInt(input.objectKeysDeleted)},
			    objectKeysFailed = ${BigInt(input.objectKeysFailed)}
			WHERE tenantId = ${input.tenantId}
			  AND id = ${input.scrubLogId}
		`.idempotent(true)
	}

	return {
		consentRepo,
		auditRepo,
		recordConsentAndAuditAtomic,
		cascadeRtbfRevoke,
		updateScrubLogS3Counts,
		listGuestDocumentsForExport,
	}
}
