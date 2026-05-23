/**
 * photoConsentLog repo (Sprint B, 2026-05-22).
 *
 * 152-ФЗ ст.9 ч.4 — separate-document consent для passport OCR. Audit trail
 * (timestamp + IP + UA) обязателен для Roskomnadzor inspections 2026.
 *
 * Tenant-scoped append-only writes; soft revoke via revokedAt (right-to-be-
 * forgotten ст.20). Narrow surface — single insert + lookup + revoke.
 *
 * SECURITY: `ipAddress` and `acceptedAt` resolved by CALLER (route handler) —
 * NEVER from client body. Client value (если есть) логируется но не персистится
 * как truth (forgeable).
 */

import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../../../db/index.ts'
import { textOpt, timestampOpt, toJson, toTs } from '../../../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

/** Scope enum forward-compat. Текущий use case = passport_ocr. */
export type ConsentScope = 'passport_ocr'

/**
 * Multi-checkbox state — per 152-ФЗ ст.10/ст.11 separate consents.
 *
 * Defensive over-consent (Sprint C): даже если passport photo storage-only ≠
 * biometric per Roskomnadzor 2022 guidance (legalacts.ru/doc/razjasnenija-roskomnadzora),
 * мы collect'им 3 checkboxes для insurance против 2026 enforcement-year surprises.
 *
 * - `generalPdn` — ст.6 общие ПДн (ФИО, паспорт)
 * - `citizenshipSpecial` — ст.10 ч.2 национальность (foreign citizens)
 * - `biometricPhoto` — ст.11 фото паспорта (defensive)
 */
export interface SeparateConsents {
	readonly generalPdn: boolean
	readonly citizenshipSpecial: boolean
	readonly biometricPhoto: boolean
}

export interface PhotoConsentLogInsert {
	readonly tenantId: string
	readonly guestId: string
	readonly version: string
	readonly scope: ConsentScope
	/** Server clock — caller passes `new Date()`. NOT client value (clock skew + adversarial). */
	readonly acceptedAt: Date
	/** Right-most-trusted-proxy resolved (via lib/net/client-ip). NOT client body. */
	readonly ipAddress: string
	/** UA header — used for forensic match if breach reported. */
	readonly userAgent: string
	/**
	 * Verbatim consent text shown к user в момент клика. Tamper-proof proof для
	 * Roskomnadzor inspection (152-ФЗ ст.9 ч.4 «оператор обязан доказать получение»).
	 * Git history ≠ proof. Этот field IS proof.
	 */
	readonly textSnapshot: string
	/** Ст.10 + ст.11 multi-checkbox state (defensive over-consent). */
	readonly separateConsents: SeparateConsents
}

export interface PhotoConsentLogRow {
	readonly tenantId: string
	readonly id: string
	readonly guestId: string
	readonly version: string
	readonly scope: string
	readonly acceptedAt: Date
	readonly ipAddress: string
	readonly userAgent: string
	readonly revokedAt: Date | null
	readonly revokedReason: string | null
	readonly createdAt: Date
	/** Verbatim consent text shown at click moment (NULL для pre-Sprint-C rows). */
	readonly textSnapshot: string | null
	/** Multi-checkbox state (NULL для pre-Sprint-C rows). */
	readonly separateConsents: SeparateConsents | null
}

interface DbRow {
	tenantId: string
	id: string
	guestId: string
	version: string
	scope: string
	acceptedAt: Date
	ipAddress: string
	userAgent: string
	revokedAt: Date | null
	revokedReason: string | null
	createdAt: Date
	textSnapshot: string | null
	/**
	 * YDB `Json` column. @ydbjs/query auto-parses Json → JS object при чтении
	 * (empirical verified 2026-05-23). Defensive `string | object | null` чтобы
	 * handle обе формы — старые миграции pre-parse + новые auto-parse.
	 */
	separateConsents: string | object | null
}

function parseSeparateConsents(raw: string | object | null): SeparateConsents | null {
	if (raw === null || raw === '') return null
	// YDB driver auto-parses Json column → already an object при чтении.
	// Pre-Sprint-C rows могут быть string (legacy) — fallback к JSON.parse.
	let obj: Partial<SeparateConsents>
	if (typeof raw === 'string') {
		try {
			obj = JSON.parse(raw) as Partial<SeparateConsents>
		} catch {
			return null
		}
	} else {
		obj = raw as Partial<SeparateConsents>
	}
	// Defensive: ensure all 3 fields present, falsy если missing
	return {
		generalPdn: obj.generalPdn === true,
		citizenshipSpecial: obj.citizenshipSpecial === true,
		biometricPhoto: obj.biometricPhoto === true,
	}
}

function rowToConsent(row: DbRow): PhotoConsentLogRow {
	return {
		tenantId: row.tenantId,
		id: row.id,
		guestId: row.guestId,
		version: row.version,
		scope: row.scope,
		acceptedAt: row.acceptedAt,
		ipAddress: row.ipAddress,
		userAgent: row.userAgent,
		revokedAt: row.revokedAt,
		revokedReason: row.revokedReason,
		createdAt: row.createdAt,
		textSnapshot: row.textSnapshot,
		separateConsents: parseSeparateConsents(row.separateConsents),
	}
}

export function createPhotoConsentLogRepo(sql: SqlInstance) {
	const insertWithId = async (id: string, input: PhotoConsentLogInsert): Promise<string> => {
		const now = new Date()
		await sql`
			UPSERT INTO photoConsentLog (
				tenantId, id, guestId, version, scope,
				acceptedAt, ipAddress, userAgent,
				revokedAt, revokedReason, createdAt,
				textSnapshot, separateConsents
			) VALUES (
				${input.tenantId}, ${id}, ${input.guestId}, ${input.version}, ${input.scope},
				${toTs(input.acceptedAt)}, ${input.ipAddress}, ${input.userAgent},
				${timestampOpt(null)}, ${textOpt(null)}, ${toTs(now)},
				${input.textSnapshot}, ${toJson(input.separateConsents)}
			)
		`.idempotent(true)
		return id
	}

	return {
		/**
		 * Insert fresh consent record. Returns generated `cns_*` ID.
		 *
		 * Self-review note (Sprint C 2026-05-23 Y3 fix): factory's
		 * recordConsentAndAuditAtomic uses `insertWithId(id, ...)` with caller-
		 * generated ID so `sql.begin({idempotent:true})` retries don't mint new
		 * IDs per attempt. This wrapper kept for non-transactional call sites.
		 */
		async insert(input: PhotoConsentLogInsert): Promise<string> {
			return insertWithId(newId('consent'), input)
		},

		/**
		 * Insert with caller-provided ID — used by factory под sql.begin
		 * idempotent retry boundary. Same UPSERT shape as insert().
		 */
		insertWithId,

		/** Read by composite PK. Returns null if not found OR cross-tenant access. */
		async findById(tenantId: string, id: string): Promise<PhotoConsentLogRow | null> {
			const [rows = []] = await sql<DbRow[]>`
				SELECT * FROM photoConsentLog
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`.idempotent(true)
			const row = rows[0]
			return row ? rowToConsent(row) : null
		},

		/**
		 * Soft revoke — right-to-be-forgotten 152-ФЗ ст.20 (10 рабочих дней).
		 * Atomic UPDATE sets revokedAt + revokedReason. Caller pre-generates
		 * timestamp via `revokeAt` for single-clock canon.
		 *
		 * Legacy: `revoke()` retained для backward compat; calls revokeAt с
		 * fresh `new Date()`. Self-review fix H3 — prefer revokeAt downstream.
		 */
		async revoke(tenantId: string, id: string, reason: string): Promise<{ revoked: boolean }> {
			await this.revokeAt(tenantId, id, reason, new Date())
			return { revoked: true }
		},

		/**
		 * Sprint C self-review H3 fix: revoke с caller-supplied timestamp.
		 * Used by factory `cascadeRtbfRevoke` чтобы tx UPDATE и operator API
		 * response share canonical clock. WHERE includes `revokedAt IS NULL`
		 * для idempotency — повторный revoke не overwritits the original
		 * timestamp/reason (TOCTOU race safety).
		 */
		async revokeAt(tenantId: string, id: string, reason: string, when: Date): Promise<void> {
			await sql`
				UPDATE photoConsentLog
				SET revokedAt = ${toTs(when)}, revokedReason = ${reason}
				WHERE tenantId = ${tenantId} AND id = ${id} AND revokedAt IS NULL
			`
		},

		/** List all consents для гостя (admin view, revocation flow). */
		async findByGuestId(tenantId: string, guestId: string): Promise<PhotoConsentLogRow[]> {
			const [rows = []] = await sql<DbRow[]>`
				SELECT * FROM photoConsentLog
				WHERE tenantId = ${tenantId} AND guestId = ${guestId}
				ORDER BY createdAt DESC
				LIMIT 1000
			`.idempotent(true)
			return rows.map(rowToConsent)
		},
	}
}

export type PhotoConsentLogRepo = ReturnType<typeof createPhotoConsentLogRepo>
