/**
 * passportOcrAudit repo (Sprint B, 2026-05-22).
 *
 * 152-ФЗ ст.21 ч.4 — оператор обязан вести «учёт обработки персональных
 * данных». Audit table = такой учёт. Записывается ПОСЛЕ каждого Vision API
 * call — success OR failure path.
 *
 * Table schema = 0037_passport_ocr_audit.sql (already exists since M8.A.1).
 * До Sprint B nothing wrote here → ст.21 ч.4 нарушалось. Этот repo + write
 * в `vision.routes.ts` закрывает gap.
 *
 * Retention: 90 дней (per 0037 doc + ст.21 ч.7 «не дольше необходимого»).
 * Cleanup cron handled separately (P1 в memo project_passport_scan_canon).
 */

import { newId, type PassportEntities } from '@horeca/shared'
import type { sql as SQL } from '../../../../db/index.ts'
import { dateOpt, doubleOpt, textOpt, toJson, toTs } from '../../../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

/** Slim audit row for DSAR export (152-ФЗ ст.14 — guest data access request). */
export interface PassportOcrAuditExportRow {
	readonly id: string
	readonly createdAt: Date
	readonly outcome: string
	readonly apiModel: string
	readonly entities: PassportEntities | null
	readonly confidenceHeuristic: number | null
	readonly entitiesAnonymizedAt: Date | null
}

export type Outcome = 'success' | 'low_confidence' | 'api_error' | 'invalid_document'

export interface PassportOcrAuditInsert {
	readonly tenantId: string
	readonly operatorUserId: string
	/** Soft FK guest.id если scan был для конкретного гостя. */
	readonly guestId: string | null
	/** Soft FK booking.id если scan привязан к брони. */
	readonly bookingId: string | null
	/** Soft FK guestDocument.id если scan сохранён в document. NULL для staging-only scan. */
	readonly documentId: string | null

	/** Scan input metadata */
	readonly inputMimeType: string
	readonly inputSizeBytes: number
	/** Object Storage path если photo был uploaded. NULL для in-memory-only flow (current Phase 1). */
	readonly inputObjectKey: string | null

	/** Yandex Vision API call */
	readonly apiEndpoint: string
	readonly apiModel: string
	readonly httpStatus: number
	readonly latencyMs: number

	/** Extracted entities. Null fields когда API не вернул (low quality / failure). */
	readonly entities: PassportEntities | null

	readonly detectedCountryIso3: string | null
	readonly isCountryWhitelisted: boolean
	readonly apiConfidenceRaw: number | null
	readonly confidenceHeuristic: number | null
	readonly outcome: Outcome

	/** Full raw response (JSON column) — для replay/debug. */
	readonly rawResponseJson: unknown | null

	/** FK photoConsentLog.id — 152-ФЗ proof что consent был записан до scan. */
	readonly photoConsentLogId: string | null
}

interface DbAuditExportRow {
	id: string
	createdAt: Date
	outcome: string
	apiModel: string
	surname: string | null
	name: string | null
	middleName: string | null
	gender: string | null
	citizenshipIso3: string | null
	birthDate: Date | null
	birthPlace: string | null
	documentNumber: string | null
	issueDate: Date | null
	confidenceHeuristic: number | bigint | null
	entitiesAnonymizedAt: Date | null
	/**
	 * Round 4 Senior P0-3 fix: rawResponseJson contains full Vision response
	 * including `expirationDate` which is NOT stored as separate audit column
	 * (per 0037 schema — RU internal паспорт has no expiry). DSAR ст.14
	 * «полный объём» requires expirationDate когда present (загранпаспорт/
	 * driver license).
	 */
	rawResponseJson: string | object | null
}

function extractExpirationDate(raw: string | object | null): string | null {
	if (raw === null) return null
	let parsed: { entities?: { expirationDate?: string | null } }
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw) as { entities?: { expirationDate?: string | null } }
		} catch {
			return null
		}
	} else {
		parsed = raw as { entities?: { expirationDate?: string | null } }
	}
	const date = parsed.entities?.expirationDate
	if (typeof date !== 'string' || date.length === 0) return null
	// YYYY-MM-DD validation — defensive vs adversarial JSON injection
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
	return date
}

function rowToExportEntity(row: DbAuditExportRow): PassportOcrAuditExportRow {
	// Sprint C+ Senior P0-3 fix (2026-05-23 evening): use entitiesAnonymizedAt
	// as CANONICAL scrub check, not field-by-field nullness sniffing. Previous
	// `allFieldsNull` heuristic had two failure modes:
	//   (a) low-quality OCR that returns surname=null but documentNumber set
	//       would be treated as «not scrubbed» → entities leak post-revoke if
	//       partial-write race occurred in cascade.
	//   (b) extractExpirationDate ran regardless of scrub state → leaked
	//       expirationDate from rawResponseJson even when entitiesAnonymizedAt
	//       set (cascade rawResponseJson NULL fixed это, but defense-in-depth
	//       at read layer = belt-and-suspenders per 152-ФЗ ст.20).
	// Canonical check: row.entitiesAnonymizedAt !== null → all PII fields are
	// definitively scrubbed per RTBF cascade contract (factory.cascadeRtbfRevoke).
	const isScrubbed = row.entitiesAnonymizedAt !== null
	const entities: PassportEntities | null = isScrubbed
		? null
		: {
				surname: row.surname,
				name: row.name,
				middleName: row.middleName,
				gender: row.gender as 'male' | 'female' | null,
				citizenshipIso3: row.citizenshipIso3,
				birthDate: row.birthDate?.toISOString().slice(0, 10) ?? null,
				birthPlace: row.birthPlace,
				documentNumber: row.documentNumber,
				issueDate: row.issueDate?.toISOString().slice(0, 10) ?? null,
				// Sprint C+ Senior P0-3: parse expirationDate from rawResponseJson
				// ONLY when not scrubbed. 152-ФЗ ст.14 «полный объём» for active
				// records (загранпаспорт/ВУ have expiry); ст.20 «уничтожение» wins
				// when entitiesAnonymizedAt set — rawResponseJson already NULL'd
				// by cascade, but defensive read-layer guard prevents future regression.
				expirationDate: extractExpirationDate(row.rawResponseJson),
			}
	return {
		id: row.id,
		createdAt: row.createdAt,
		outcome: row.outcome,
		apiModel: row.apiModel,
		entities,
		confidenceHeuristic: row.confidenceHeuristic === null ? null : Number(row.confidenceHeuristic),
		entitiesAnonymizedAt: row.entitiesAnonymizedAt,
	}
}

export function createPassportOcrAuditRepo(sql: SqlInstance) {
	const insertWithId = async (id: string, input: PassportOcrAuditInsert): Promise<string> => {
		const now = new Date()
		const e = input.entities
		await sql`
			UPSERT INTO passportOcrAudit (
				tenantId, id, guestId, documentId, bookingId, operatorUserId,
				inputMimeType, inputSizeBytes, inputObjectKey,
				apiEndpoint, apiModel, httpStatus, latencyMs,
				surname, name, middleName, gender, citizenshipIso3,
				birthDate, birthPlace, documentNumber, issueDate,
				detectedCountryIso3, isCountryWhitelisted,
				apiConfidenceRaw, confidenceHeuristic, outcome,
				rawResponseJson, photoConsentLogId, createdAt
			) VALUES (
				${input.tenantId}, ${id},
				${textOpt(input.guestId)}, ${textOpt(input.documentId)}, ${textOpt(input.bookingId)},
				${input.operatorUserId},
				${input.inputMimeType}, ${BigInt(input.inputSizeBytes)}, ${textOpt(input.inputObjectKey)},
				${input.apiEndpoint}, ${input.apiModel}, ${input.httpStatus}, ${input.latencyMs},
				${textOpt(e?.surname ?? null)}, ${textOpt(e?.name ?? null)}, ${textOpt(e?.middleName ?? null)},
				${textOpt(e?.gender ?? null)}, ${textOpt(e?.citizenshipIso3 ?? null)},
				${dateOpt(e?.birthDate ?? null)}, ${textOpt(e?.birthPlace ?? null)},
				${textOpt(e?.documentNumber ?? null)}, ${dateOpt(e?.issueDate ?? null)},
				${textOpt(input.detectedCountryIso3)}, ${input.isCountryWhitelisted},
				${doubleOpt(input.apiConfidenceRaw)}, ${doubleOpt(input.confidenceHeuristic)},
				${input.outcome},
				${toJson(input.rawResponseJson)},
				${textOpt(input.photoConsentLogId)}, ${toTs(now)}
			)
		`.idempotent(true)
		return id
	}

	return {
		/**
		 * Insert audit row. Returns generated `ocra_*` ID.
		 *
		 * MUST be called после КАЖДОГО vision.recognizePassport — success AND
		 * failure path (152-ФЗ ст.21 ч.4). Caller обёрнут в try-finally чтобы
		 * audit write не throw'ил из-за main flow error.
		 *
		 * Self-review Sprint C Y3 fix: factory's recordConsentAndAuditAtomic
		 * uses insertWithId(id, ...) within sql.begin idempotent retry boundary
		 * чтобы prevent duplicate-row insert on retryable-error replay.
		 */
		async insert(input: PassportOcrAuditInsert): Promise<string> {
			return insertWithId(newId('passportOcrAudit'), input)
		},

		insertWithId,

		/**
		 * DSAR — list scans for guest (152-ФЗ ст.14, 30-day SLA).
		 * Returns slim shape без raw API response / consent IDs / operator IDs
		 * (those are оператора internal data, не subject's data).
		 */
		async findByGuestId(tenantId: string, guestId: string): Promise<PassportOcrAuditExportRow[]> {
			// Round 4 Senior P0-3 fix: SELECT rawResponseJson too — exporter
			// parses expirationDate из этого column. 152-ФЗ ст.14 requires
			// «полный объём обрабатываемых ПДн» — expirationDate IS processed.
			const [rows = []] = await sql<DbAuditExportRow[]>`
				SELECT id, createdAt, outcome, apiModel,
				       surname, name, middleName, gender, citizenshipIso3,
				       birthDate, birthPlace, documentNumber, issueDate,
				       confidenceHeuristic, entitiesAnonymizedAt, rawResponseJson
				FROM passportOcrAudit
				WHERE tenantId = ${tenantId} AND guestId = ${guestId}
				ORDER BY createdAt DESC
				LIMIT 1000
			`.idempotent(true)
			return rows.map(rowToExportEntity)
		},

		/**
		 * RTBF cascade — nullify PII fields в всех audit rows для consent (152-ФЗ ст.20).
		 *
		 * Audit row sам остаётся (5y TTL — proof что scan existed для оператора
		 * accountability per ст.21 ч.4), но все PII fields → NULL + entitiesAnonymizedAt
		 * = now. Roskomnadzor inspection: «покажите как scrub PII после revoke» = answer есть.
		 */
		async nullifyEntitiesByConsentId(tenantId: string, consentId: string): Promise<void> {
			const now = new Date()
			// Round 2 self-review Batch 9 (InfoSec P2-7): also nullify side-channel
			// technical metadata. Без этого: inputMimeType + inputSizeBytes + httpStatus
			// + latencyMs persist post-revoke → adversarial DBA reconstructs «какой
			// документ был» по mime+size hash + timing fingerprint. Schema columns
			// NOT NULL (Utf8/Int32/Int64) — cannot set NULL, use sentinel values:
			//   - inputMimeType → 'scrubbed'
			//   - inputSizeBytes / httpStatus / latencyMs → 0 (signals «redacted»)
			// Combined с entitiesAnonymizedAt timestamp = clean audit story:
			// «scrubbed at X, technical metadata redacted».
			await sql`
				UPDATE passportOcrAudit
				SET surname = NULL,
				    name = NULL,
				    middleName = NULL,
				    gender = NULL,
				    citizenshipIso3 = NULL,
				    birthDate = NULL,
				    birthPlace = NULL,
				    documentNumber = NULL,
				    issueDate = NULL,
				    detectedCountryIso3 = NULL,
				    apiConfidenceRaw = NULL,
				    confidenceHeuristic = NULL,
				    rawResponseJson = NULL,
				    inputObjectKey = NULL,
				    inputMimeType = 'scrubbed',
				    inputSizeBytes = 0,
				    httpStatus = 0,
				    latencyMs = 0,
				    entitiesAnonymizedAt = ${toTs(now)}
				WHERE tenantId = ${tenantId} AND photoConsentLogId = ${consentId}
			`
		},

		/**
		 * Find all audit rows linked к consent (для RTBF cascade — find objectKeys
		 * to delete из storage перед nullify).
		 */
		async findObjectKeysByConsentId(tenantId: string, consentId: string): Promise<string[]> {
			const [rows = []] = await sql<{ inputObjectKey: string | null }[]>`
				SELECT inputObjectKey FROM passportOcrAudit
				WHERE tenantId = ${tenantId}
				  AND photoConsentLogId = ${consentId}
				  AND inputObjectKey IS NOT NULL
			`.idempotent(true)
			return rows.map((r) => r.inputObjectKey).filter((k): k is string => k !== null)
		},
	}
}

export type PassportOcrAuditRepo = ReturnType<typeof createPassportOcrAuditRepo>
