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
 */

import type { sql as SQL } from '../../../db/index.ts'
import {
	createPassportOcrAuditRepo,
	type PassportOcrAuditRepo,
} from './audit/passport-ocr-audit.repo.ts'
import {
	createPhotoConsentLogRepo,
	type PhotoConsentLogRepo,
} from './consent/photo-consent-log.repo.ts'

export interface PassportScanFactory {
	readonly consentRepo: PhotoConsentLogRepo
	readonly auditRepo: PassportOcrAuditRepo
	/** Helper для transactional consent+audit write — used by vision.routes. */
	readonly recordConsentAndAuditAtomic: (input: AtomicWriteInput) => Promise<AtomicWriteResult>
	/** RTBF cascade — used by consent-revoke routes. nullify audit + revoke consent. */
	readonly cascadeRtbfRevoke: (input: RtbfRevokeInput) => Promise<void>
}

interface AtomicWriteInput {
	readonly consent: Parameters<PhotoConsentLogRepo['insert']>[0]
	readonly audit: Omit<Parameters<PassportOcrAuditRepo['insert']>[0], 'photoConsentLogId'>
}

interface AtomicWriteResult {
	readonly success: boolean
	readonly consentId: string | null
}

interface RtbfRevokeInput {
	readonly tenantId: string
	readonly consentId: string
	readonly reason: string
}

export function createPassportScanFactory(sql: typeof SQL): PassportScanFactory {
	const consentRepo = createPhotoConsentLogRepo(sql)
	const auditRepo = createPassportOcrAuditRepo(sql)

	const recordConsentAndAuditAtomic = async (
		input: AtomicWriteInput,
	): Promise<AtomicWriteResult> => {
		let consentId: string | null = null
		try {
			await sql.begin({ idempotent: true }, async (tx) => {
				// `tx` has the tagged-template interface compatible с repos;
				// cast разрешает sub-type (no `begin`/`do` on tx — мы не nesting).
				const consentRepoTx = createPhotoConsentLogRepo(tx as unknown as typeof SQL)
				const auditRepoTx = createPassportOcrAuditRepo(tx as unknown as typeof SQL)
				consentId = await consentRepoTx.insert(input.consent)
				await auditRepoTx.insert({ ...input.audit, photoConsentLogId: consentId })
			})
			return { success: true, consentId }
		} catch {
			return { success: false, consentId: null }
		}
	}

	const cascadeRtbfRevoke = async (input: RtbfRevokeInput): Promise<void> => {
		await sql.begin({ idempotent: true }, async (tx) => {
			const auditRepoTx = createPassportOcrAuditRepo(tx as unknown as typeof SQL)
			const consentRepoTx = createPhotoConsentLogRepo(tx as unknown as typeof SQL)
			await auditRepoTx.nullifyEntitiesByConsentId(input.tenantId, input.consentId)
			await consentRepoTx.revoke(input.tenantId, input.consentId, input.reason)
		})
	}

	return {
		consentRepo,
		auditRepo,
		recordConsentAndAuditAtomic,
		cascadeRtbfRevoke,
	}
}
