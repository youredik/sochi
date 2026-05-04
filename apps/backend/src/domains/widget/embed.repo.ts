/**
 * Embed repo — per-tenant `publicEmbedDomains` allowlist + `widgetReleaseAudit`
 * append-only log (M9.widget.6 / А4.3).
 *
 * Per `plans/m9_widget_6_canonical.md`:
 *   * D11 — read `property.publicEmbedDomains` to derive dynamic CORS
 *     reflection on `/embed/v1/:slug.{hash}.js` GET (D21) AND CSP
 *     `frame-ancestors` on iframe HTML route (А4.4).
 *   * D24 — write-side regex (`HTTPS_ORIGIN_REGEX`) + array-length cap;
 *     read-side `assertOriginSafe(...)` BEFORE any `c.header(...)` splice
 *     in routes (header-injection defense per CVE-2026-29086 class).
 *   * D26 — `widgetReleaseAudit` append-only INSERT path (NEVER UPDATE/DELETE
 *     in production code; tamper-evidence baseline).
 *
 * Cross-tenant isolation: every method takes `tenantId` and filters
 * `WHERE tenantId = ${tenantId}`. Caller (route layer) resolves slug → tenantId
 * via existing `tenant-resolver.ts`; repo never reads slug directly.
 */

import { z } from 'zod'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_TEXT, toJson, toTs } from '../../db/ydb-helpers.ts'
import { HTTPS_ORIGIN_REGEX } from '../../lib/embed/header-safety.ts'

type SqlInstance = typeof SQL

/** Bundle kinds emitted by widget-embed Vite multi-entry build. */
export const widgetBundleKindSchema = z.enum(['embed', 'booking-flow'])
export type WidgetBundleKind = z.infer<typeof widgetBundleKindSchema>

/** Lifecycle action recorded in `widgetReleaseAudit`. */
export const widgetReleaseActionSchema = z.enum(['published', 'revoked', 'reauthorized'])
export type WidgetReleaseAction = z.infer<typeof widgetReleaseActionSchema>

export const widgetReleaseActorSourceSchema = z.enum(['admin_ui', 'cli', 'ci', 'cron'])
export type WidgetReleaseActorSource = z.infer<typeof widgetReleaseActorSourceSchema>

/**
 * Operator-controlled origin string. Strict allowlist:
 *   * lowercase ASCII letters / digits / dot / hyphen in hostname
 *   * optional port
 *   * MUST be HTTPS (no http://, no scheme-relative)
 *   * Cyrillic must be punycode-encoded by upstream admin UI
 */
export const publicEmbedOriginSchema = z
	.string()
	.min(1)
	.max(253)
	.regex(HTTPS_ORIGIN_REGEX, 'origin must be https://host[:port] ASCII-only')

/**
 * Allowlist column shape: array of origins, max 32 entries (defends against
 * accidental DoS via huge JSON column reads). NULL = embedding disabled.
 */
export const publicEmbedDomainsSchema = z.array(publicEmbedOriginSchema).max(32)
export type PublicEmbedDomains = z.infer<typeof publicEmbedDomainsSchema>

const auditReasonSchema = z
	.string()
	.max(500)
	.refine((s) => !/[\r\n]/.test(s), {
		message: 'reason must not contain CR/LF (header-injection defense in depth)',
	})

export interface AuditInput {
	readonly tenantId: string
	readonly id: string
	readonly hash: string
	readonly bundleKind: WidgetBundleKind
	readonly action: WidgetReleaseAction
	readonly reason: string | null
	readonly actorUserId: string
	readonly actorSource: WidgetReleaseActorSource
	readonly actionAt: Date
}

const auditInputShape = z.object({
	tenantId: z.string().min(1),
	id: z.string().min(1),
	hash: z.string().regex(/^[a-f0-9]{96}$/i, 'hash must be hex-encoded SHA-384 (96 chars)'),
	bundleKind: widgetBundleKindSchema,
	action: widgetReleaseActionSchema,
	reason: auditReasonSchema.nullable(),
	actorUserId: z.string().min(1),
	actorSource: widgetReleaseActorSourceSchema,
	actionAt: z.date(),
})

export function createEmbedRepo(sqlInstance: SqlInstance) {
	return {
		/**
		 * Read tenant-scoped `publicEmbedDomains` for the property. Returns
		 * null if column is NULL OR property is private/missing/cross-tenant.
		 *
		 * The allowlist is JSON-shaped — zod-parsed before return so the route
		 * layer never sees malformed legacy values. Throws on parse failure
		 * (operator must fix data; route maps to 500 to avoid silent
		 * security-relevant degradation).
		 */
		async getPublicEmbedDomains(
			tenantId: string,
			propertyId: string,
		): Promise<PublicEmbedDomains | null> {
			const [rows = []] = await sqlInstance<{ publicEmbedDomains: unknown }[]>`
				SELECT publicEmbedDomains
				FROM property
				WHERE tenantId = ${tenantId} AND id = ${propertyId}
				  AND isPublic = ${true} AND isActive = ${true}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (!row) return null
			if (row.publicEmbedDomains === null || row.publicEmbedDomains === undefined) {
				return null
			}
			return publicEmbedDomainsSchema.parse(row.publicEmbedDomains)
		},

		/**
		 * Write the allowlist (admin UI / migration backfill use-case). Zod-
		 * parses input — throws on any element failing the strict regex.
		 *
		 * Empty array `[]` is collapsed to NULL semantically (admin UI
		 * concern; repo writes literal what it gets, but service layer should
		 * coerce empty array → null write).
		 */
		async setPublicEmbedDomains(
			tenantId: string,
			propertyId: string,
			origins: PublicEmbedDomains,
		): Promise<void> {
			publicEmbedDomainsSchema.parse(origins)
			await sqlInstance`
				UPDATE property
				SET publicEmbedDomains = ${toJson(origins)}
				WHERE tenantId = ${tenantId} AND id = ${propertyId}
			`
		},

		/**
		 * Append a row to `widgetReleaseAudit`. NEVER updates / deletes —
		 * append-only canon (D26 tamper-evidence). Caller wraps the call in
		 * `sql.begin({ idempotent: true })` together with the
		 * `widget_release` UPDATE so kill-switch atomicity holds.
		 *
		 * `tx` is optional — pass when called inside an outer transaction;
		 * if absent we use the bare `sqlInstance` (admin tooling path).
		 */
		async appendAudit(input: AuditInput, tx?: SqlInstance): Promise<void> {
			const parsed = auditInputShape.parse(input)
			const exec = tx ?? sqlInstance
			const nowTs = toTs(new Date())
			const actionAtTs = toTs(parsed.actionAt)
			const reason = parsed.reason ?? NULL_TEXT
			await exec`
				UPSERT INTO widgetReleaseAudit (
					\`tenantId\`, \`id\`, \`hash\`, \`bundleKind\`, \`action\`, \`reason\`,
					\`actorUserId\`, \`actorSource\`, \`actionAt\`, \`createdAt\`
				) VALUES (
					${parsed.tenantId}, ${parsed.id}, ${parsed.hash}, ${parsed.bundleKind},
					${parsed.action}, ${reason},
					${parsed.actorUserId}, ${parsed.actorSource},
					${actionAtTs}, ${nowTs}
				)
			`
		},

		/**
		 * List recent audit events for a tenant (admin UI consumption).
		 * Returns up to `limit` rows ordered by `actionAt DESC`.
		 */
		async listAudit(
			tenantId: string,
			limit = 50,
		): Promise<
			Array<{
				readonly id: string
				readonly hash: string
				readonly bundleKind: WidgetBundleKind
				readonly action: WidgetReleaseAction
				readonly reason: string | null
				readonly actorUserId: string
				readonly actorSource: WidgetReleaseActorSource
				readonly actionAt: Date
			}>
		> {
			const [rows = []] = await sqlInstance<
				Array<{
					id: string
					hash: string
					bundleKind: string
					action: string
					reason: string | null
					actorUserId: string
					actorSource: string
					actionAt: Date
				}>
			>`
				SELECT id, hash, bundleKind, action, reason, actorUserId, actorSource, actionAt
				FROM widgetReleaseAudit VIEW idxWidgetReleaseAuditActionAt
				WHERE tenantId = ${tenantId}
				ORDER BY actionAt DESC
				LIMIT ${limit}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map((r) => ({
				id: r.id,
				hash: r.hash,
				bundleKind: widgetBundleKindSchema.parse(r.bundleKind),
				action: widgetReleaseActionSchema.parse(r.action),
				reason: r.reason ?? null,
				actorUserId: r.actorUserId,
				actorSource: widgetReleaseActorSourceSchema.parse(r.actorSource),
				actionAt: r.actionAt,
			}))
		},
	}
}
