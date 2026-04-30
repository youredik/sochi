/**
 * Consent recording helper — appends rows to existing `consentLog` table
 * (defined в `0001_init.sql:431`).
 *
 * Per `plans/m9_widget_4_canonical.md` §3 + Round 2 verified:
 *   - 152-ФЗ ст. 9 separate-document consent (effective 2025-09-01) — каждое
 *     consent оформляется отдельной row (не bundled).
 *   - 152-ФЗ ст. 22.1 DPO recordkeeping — `consentLog` audit trail mandatory
 *     даже для demo-tenant bookings (compliance не зависит от Mock vs Live).
 *   - 38-ФЗ ст. 18 marketing consent — opt-in только.
 *
 * Existing schema mapping для public widget Screen 3:
 *   - subjectType = 'guest' (vs 'user' для admin auth flows)
 *   - subjectId = guestId (typeid `gst_*`)
 *   - tenantId = resolved organization id (NOT NULL in widget context;
 *     existing schema allows nullable для pre-tenant cookie consent)
 *   - consentType:
 *     - '152fz_pd' from widget UI → 'dpaAcceptance' (canonical schema enum)
 *     - '38fz_marketing' from widget UI → 'marketing'
 *   - consentVersion — semver-style ('v1.0' / 'v1.1') для traceability при
 *     wording updates. Operator policy decides когда bump.
 *   - textSnapshot — exact wording shown к guest (NOT template name).
 *     Required для defending в РКН инспекции.
 *   - ipAddress + userAgent — 152-ФЗ ст. 22.1 evidence trail.
 *
 * Why `granted` not stored explicitly:
 *   Existing schema records consent via row-presence (insert = granted) +
 *   `revokedAt` для revocation. Декретный pattern для immutable audit log.
 *   Refusal-to-consent NOT recorded (legitimate UX path: don't proceed +
 *   show error, no row inserted).
 */

import { newId } from '@horeca/shared'
import type { sql as SQL } from '../db/index.ts'
import { textOpt, toTs } from '../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

/**
 * Public widget consent types — UI-level discriminator. Mapped to canonical
 * schema enum в `recordConsents()` below.
 */
export const widgetConsentTypeValues = ['152fz_pd', '38fz_marketing'] as const
export type WidgetConsentType = (typeof widgetConsentTypeValues)[number]

const widgetToSchemaConsentType: Record<WidgetConsentType, string> = {
	'152fz_pd': 'dpaAcceptance',
	'38fz_marketing': 'marketing',
}

export interface ConsentRecordInput {
	readonly type: WidgetConsentType
	readonly textSnapshot: string
	readonly version: string
}

export interface RecordConsentsArgs {
	readonly tenantId: string
	readonly guestId: string
	readonly ipAddress: string
	readonly userAgent: string | null
	readonly consents: readonly ConsentRecordInput[]
	readonly grantedAt: Date
}

/**
 * Insert one consentLog row per granted consent. Atomic-per-row (no transaction
 * needed — each consent row is independent and immutable).
 *
 * Returns the inserted consent IDs in same order as input.
 *
 * Idempotency: caller is expected to invoke this exactly once per booking
 * commit (idempotency-key middleware on the public POST handles duplicate
 * requests; this helper itself doesn't dedup).
 */
export async function recordConsents(
	sqlInstance: SqlInstance,
	args: RecordConsentsArgs,
): Promise<string[]> {
	if (args.consents.length === 0) return []
	if (!args.guestId) throw new Error('recordConsents: guestId required')
	if (!args.tenantId) throw new Error('recordConsents: tenantId required')
	if (!args.ipAddress) throw new Error('recordConsents: ipAddress required')

	const grantedTs = toTs(args.grantedAt)
	const ids: string[] = []
	for (const c of args.consents) {
		const id = newId('consent')
		const schemaType = widgetToSchemaConsentType[c.type]
		await sqlInstance`
			INSERT INTO consentLog (
				\`id\`, \`subjectType\`, \`subjectId\`, \`tenantId\`,
				\`consentType\`, \`consentVersion\`, \`textSnapshot\`,
				\`ipAddress\`, \`userAgent\`, \`grantedAt\`
			) VALUES (
				${id}, ${'guest'}, ${args.guestId}, ${args.tenantId},
				${schemaType}, ${c.version}, ${c.textSnapshot},
				${args.ipAddress}, ${textOpt(args.userAgent)}, ${grantedTs}
			)
		`
		ids.push(id)
	}
	return ids
}

/**
 * Lookup consents granted by a guest. Useful для guest portal (M8.A.6
 * magic-link) — show «what consents you've granted» + revocation UX.
 *
 * Filters by `tenantId` for isolation; never returns rows from другого
 * tenant (defence-in-depth даже если subjectId leaked).
 */
export async function listConsentsForGuest(
	sqlInstance: SqlInstance,
	tenantId: string,
	guestId: string,
): Promise<
	Array<{
		readonly id: string
		readonly consentType: string
		readonly consentVersion: string
		readonly textSnapshot: string
		readonly grantedAt: Date
		readonly revokedAt: Date | null
	}>
> {
	const [rows = []] = await sqlInstance<
		Array<{
			id: string
			consentType: string
			consentVersion: string
			textSnapshot: string
			grantedAt: Date
			revokedAt: Date | null
		}>
	>`
		SELECT id, consentType, consentVersion, textSnapshot, grantedAt, revokedAt
		FROM consentLog
		WHERE tenantId = ${tenantId}
		  AND subjectType = ${'guest'}
		  AND subjectId = ${guestId}
		ORDER BY grantedAt DESC
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows.map((r) => ({
		id: r.id,
		consentType: r.consentType,
		consentVersion: r.consentVersion,
		textSnapshot: r.textSnapshot,
		grantedAt: r.grantedAt,
		revokedAt: r.revokedAt ?? null,
	}))
}
