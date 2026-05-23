/**
 * `passport_scan_audit_projector` CDC handler — consumes
 * `photoConsentLog/photoConsentLogChanges` + `passportOcrAudit/passportOcrAuditChanges`
 * topics so the consumer offset advances continuously.
 *
 * **Sprint C+ 5-expert audit fix 2026-05-23d (YDB P0 + Senior P1-1)**:
 * Migration 0069 reserved `ADD CONSUMER passportScanAuditProjector` on both
 * changefeeds, но zero worker code consumed them. With Tier-A `RETENTION_PERIOD =
 * PT24H` (per 0014a Serverless empirical canon), unread events expire after
 * 24h — first worker deploy would replay nothing → **silent CDC data loss**.
 * This minimal projector consumes both topics, advances offsets, and emits a
 * structured log per event so Roskomnadzor inspection can prove the audit feed
 * is actively projected (152-ФЗ ст.21 ч.4 audit trail).
 *
 * **What it does NOW (M10)**:
 *   - Read each CDC event → parse `event.kind` (INSERT/UPDATE/DELETE inferred from
 *     image presence) + extract non-PII metadata (tenantId, id, anonymizedAt) +
 *     emit structured `passport_scan_audit_changefeed` log line.
 *   - **Zero DB writes** — pure observation layer. Idempotent by construction.
 *
 * **What it WILL do later (M11+)**:
 *   - Project events into `passportOcrAuditScrubLog` append-only event table
 *     (Senior P1 / Round 5 Legal recommendation: separate immutable audit log
 *     for «уничтожение ПДн» events per Roskomnadzor методические рекомендации).
 *   - Optionally fan-out to YC Monitoring for real-time РКН-dashboard.
 *
 * **PII safety**:
 *   - CDC NEW_AND_OLD_IMAGES contains PII in `newImage.surname`, `.name`, etc.
 *   - We DO NOT log image payloads — only top-level `tenantId` + non-PII keys.
 *   - Pino `logger.ts` redact paths additionally protect against accidental logging.
 *   - Type defensively: cast event.newImage/oldImage as `Record<string, unknown>`
 *     and only access tenantId / id / entitiesAnonymizedAt / revokedAt (none PII).
 *
 * **Idempotency**: No-op projection → trivially idempotent under at-least-once.
 */

import type { TX } from '@ydbjs/query'
import type { CdcEvent } from '../cdc-handlers.ts'
import type { HandlerLogger } from './refund-creator.ts'

/** Topic kind — for log label disambiguation. */
export type PassportScanAuditTopic = 'photoConsentLog' | 'passportOcrAudit'

/**
 * Extract non-PII summary fields from CDC event image. We deliberately restrict
 * к metadata-only fields (id, timestamps, status). PII fields (surname, name,
 * birthDate, documentNumber, entities.*) are NEVER read here.
 */
function summarizeImage(image: Record<string, unknown> | undefined): {
	id: string | null
	tenantId: string | null
	entitiesAnonymizedAt: string | null
	revokedAt: string | null
} {
	if (!image) {
		return { id: null, tenantId: null, entitiesAnonymizedAt: null, revokedAt: null }
	}
	const idRaw = image.id
	const tenantIdRaw = image.tenantId
	const anonymizedRaw = image.entitiesAnonymizedAt
	const revokedRaw = image.revokedAt
	return {
		id: typeof idRaw === 'string' ? idRaw : null,
		tenantId: typeof tenantIdRaw === 'string' ? tenantIdRaw : null,
		entitiesAnonymizedAt: typeof anonymizedRaw === 'string' ? anonymizedRaw : null,
		revokedAt: typeof revokedRaw === 'string' ? revokedRaw : null,
	}
}

/**
 * Infer CDC event kind from image presence (canonical YDB convention):
 *   - oldImage null, newImage set → INSERT
 *   - both set → UPDATE
 *   - newImage null, oldImage set → DELETE (rare для append-only audit tables)
 */
function inferKind(event: CdcEvent): 'insert' | 'update' | 'delete' | 'unknown' {
	const hasNew = event.newImage !== undefined && event.newImage !== null
	const hasOld = event.oldImage !== undefined && event.oldImage !== null
	if (hasNew && !hasOld) return 'insert'
	if (hasNew && hasOld) return 'update'
	if (!hasNew && hasOld) return 'delete'
	return 'unknown'
}

/**
 * Build CDC projection that emits structured audit log per passport-scan
 * change event. Pure no-op projection — does not touch DB.
 *
 * @param topic Which audit table this projector is wired для (used in log label).
 * @param log Pino-style logger (HandlerLogger interface from refund-creator).
 */
export function createPassportScanAuditProjectorHandler(
	topic: PassportScanAuditTopic,
	log: HandlerLogger,
) {
	return async (_tx: TX, event: CdcEvent): Promise<void> => {
		const kind = inferKind(event)
		// Prefer newImage summary; fall back to oldImage for DELETE events.
		const newImg = event.newImage as Record<string, unknown> | undefined
		const oldImg = event.oldImage as Record<string, unknown> | undefined
		const summary = summarizeImage(newImg ?? oldImg)
		log.info(
			{
				event: 'passport_scan_audit_changefeed',
				topic,
				kind,
				tenantId: summary.tenantId,
				rowId: summary.id,
				entitiesAnonymizedAt: summary.entitiesAnonymizedAt,
				revokedAt: summary.revokedAt,
			},
			`passport_scan_audit_projector consumed ${topic} ${kind} event`,
		)
	}
}
