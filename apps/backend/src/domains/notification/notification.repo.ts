/**
 * Notification repo — admin console operations on `notificationOutbox`.
 *
 * Production transitions are written by the dispatcher worker
 * (`apps/backend/src/workers/notification-dispatcher.ts`) — this repo only
 * exposes READ + MANUAL-RETRY paths used by the admin UI.
 *
 *   - `list(tenantId, opts)` — cursor-paginated listing with optional
 *     status/kind/recipient/date filters. Sort: `createdAt DESC, id DESC`.
 *   - `getById(tenantId, id)` — single row for drill-down.
 *   - `markForRetry(tenantId, id, actorUserId)` — operator-triggered retry.
 *     Resets row to `status='pending'`, clears failure metadata, sets
 *     `nextAttemptAt = now()` (so dispatcher picks immediately), and
 *     RESETS `retryCount = 0` so existing dispatcher's `retryCount <
 *     maxRetries` guard doesn't skip the row. The audit trail of how many
 *     attempts happened lives in the activity table, not the counter.
 *
 * Operator retry on `status='sent'` is rejected (cannot un-send) — admin
 * needs to use a separate "resend" flow, deferred to M9.
 */

import type { Notification, NotificationListPage, NotificationListParams } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_TEXT, NULL_TIMESTAMP, textOpt, toJson, toTs } from '../../db/ydb-helpers.ts'
import { NotificationAlreadySentError, NotificationNotFoundError } from '../../errors/domain.ts'

type SqlInstance = typeof SQL

type NotificationRow = {
	tenantId: string
	id: string
	kind: string
	channel: string
	recipient: string
	recipientKind: string | null
	subject: string
	bodyText: string | null
	payloadJson: unknown
	status: string
	sentAt: Date | null
	failedAt: Date | null
	failureReason: string | null
	retryCount: number | bigint
	sourceObjectType: string
	sourceObjectId: string
	sourceEventDedupKey: string
	createdAt: Date
	updatedAt: Date
	createdBy: string
	updatedBy: string
	nextAttemptAt: Date | null
	messageId: string | null
}

function rowToNotification(r: NotificationRow): Notification {
	return {
		tenantId: r.tenantId,
		id: r.id,
		kind: r.kind as Notification['kind'],
		channel: r.channel as Notification['channel'],
		recipient: r.recipient,
		recipientKind: r.recipientKind as Notification['recipientKind'],
		subject: r.subject,
		bodyText: r.bodyText,
		payloadJson: r.payloadJson,
		status: r.status as Notification['status'],
		sentAt: r.sentAt?.toISOString() ?? null,
		failedAt: r.failedAt?.toISOString() ?? null,
		failureReason: r.failureReason,
		retryCount: Number(r.retryCount),
		sourceObjectType: r.sourceObjectType,
		sourceObjectId: r.sourceObjectId,
		sourceEventDedupKey: r.sourceEventDedupKey,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}
}

/**
 * Cursor encoding — `${createdAtIso}|${id}`. Opaque to clients (base64).
 * Decoding yields tuple used in `WHERE (createdAt, id) < (cursorCreatedAt,
 * cursorId)` for stable pagination over `ORDER BY createdAt DESC, id DESC`.
 */
function encodeCursor(createdAtIso: string, id: string): string {
	return Buffer.from(`${createdAtIso}|${id}`, 'utf8').toString('base64url')
}

interface DecodedCursor {
	createdAt: Date
	id: string
}

function decodeCursor(cursor: string): DecodedCursor | null {
	try {
		const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
		const sep = decoded.indexOf('|')
		if (sep < 0) return null
		const createdAtIso = decoded.slice(0, sep)
		const id = decoded.slice(sep + 1)
		const createdAt = new Date(createdAtIso)
		if (Number.isNaN(createdAt.getTime()) || !id) return null
		return { createdAt, id }
	} catch {
		return null
	}
}

/**
 * `nextAttemptAt = now` so the dispatcher's poll picks up THIS row in the
 * very next cycle. We could insert a row in `notification_attempt`
 * (future table), but for V1 we record the operator action via the
 * activity table — service layer handles that.
 */
export interface NotificationRepo {
	list: (tenantId: string, opts: NotificationListParams) => Promise<NotificationListPage>
	getById: (tenantId: string, id: string) => Promise<Notification | null>
	/**
	 * Resets row to pending so dispatcher resends. Throws
	 * `NotificationNotFoundError` (404) if absent in tenant +
	 * `NotificationAlreadySentError` (409) if status is already 'sent'.
	 */
	markForRetry: (tenantId: string, id: string, actorUserId: string) => Promise<Notification>
}

export function createNotificationRepo(sql: SqlInstance): NotificationRepo {
	return {
		async list(tenantId, opts): Promise<NotificationListPage> {
			const limit = opts.limit
			// We over-fetch by 1 to detect "has next page" without a separate count.
			const fetchLimit = limit + 1

			const cursor = opts.cursor ? decodeCursor(opts.cursor) : null

			// PK scan: WHERE tenantId = ?. Filters applied post-scan (status/kind
			// are short enums, recipient is high-cardinality but exact-match).
			// Date filter narrows by `createdAt` range — interpreted as inclusive
			// YYYY-MM-DD bounds, compared in-memory against JS Date.
			const fromBound = opts.from ? new Date(`${opts.from}T00:00:00Z`) : null
			const toBoundExclusive = opts.to
				? (() => {
						const d = new Date(`${opts.to}T00:00:00Z`)
						d.setUTCDate(d.getUTCDate() + 1)
						return d
					})()
				: null

			// Build a single SQL with cursor WHERE clauses inline. Tagged-template
			// composition is awkward в YDB, so we branch by cursor presence.
			const [rawRows = []] = cursor
				? await sql<NotificationRow[]>`
					SELECT * FROM notificationOutbox
					WHERE tenantId = ${tenantId}
						AND (createdAt < ${toTs(cursor.createdAt)}
							OR (createdAt = ${toTs(cursor.createdAt)} AND id < ${cursor.id}))
					ORDER BY createdAt DESC, id DESC
				`
						.isolation('snapshotReadOnly')
						.idempotent(true)
				: await sql<NotificationRow[]>`
					SELECT * FROM notificationOutbox
					WHERE tenantId = ${tenantId}
					ORDER BY createdAt DESC, id DESC
				`
						.isolation('snapshotReadOnly')
						.idempotent(true)

			// Post-scan filters + apply the over-fetch cap.
			const filtered: NotificationRow[] = []
			for (const r of rawRows) {
				if (opts.status && r.status !== opts.status) continue
				if (opts.kind && r.kind !== opts.kind) continue
				if (opts.recipient && r.recipient !== opts.recipient) continue
				if (fromBound && r.createdAt < fromBound) continue
				if (toBoundExclusive && r.createdAt >= toBoundExclusive) continue
				filtered.push(r)
				if (filtered.length === fetchLimit) break
			}

			const hasMore = filtered.length > limit
			const pageRows = hasMore ? filtered.slice(0, limit) : filtered
			const last = pageRows[pageRows.length - 1]
			const nextCursor =
				hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null

			return {
				items: pageRows.map(rowToNotification),
				nextCursor,
			}
		},

		async getById(tenantId, id) {
			const [rows = []] = await sql<NotificationRow[]>`
				SELECT * FROM notificationOutbox
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToNotification(row) : null
		},

		async markForRetry(tenantId, id, actorUserId): Promise<Notification> {
			// Read-then-UPSERT (mirror dispatcher pattern; YDB UPDATE rejects
			// mixed Optional/Utf8 binds — see project_ydb_specifics.md).
			const [rows = []] = await sql<NotificationRow[]>`
				SELECT * FROM notificationOutbox
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`
			const current = rows[0]
			if (!current) throw new NotificationNotFoundError(id)
			if (current.status === 'sent') throw new NotificationAlreadySentError(id)

			const now = new Date()
			const nowTs = toTs(now)
			await sql`
				UPSERT INTO notificationOutbox (
					\`tenantId\`, \`id\`, \`kind\`, \`channel\`, \`recipient\`, \`recipientKind\`, \`subject\`,
					\`bodyText\`, \`payloadJson\`, \`status\`,
					\`sentAt\`, \`failedAt\`, \`failureReason\`,
					\`retryCount\`, \`messageId\`, \`nextAttemptAt\`,
					\`sourceObjectType\`, \`sourceObjectId\`, \`sourceEventDedupKey\`,
					\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
				) VALUES (
					${current.tenantId}, ${current.id}, ${current.kind}, ${current.channel},
					${current.recipient}, ${textOpt(current.recipientKind)}, ${current.subject},
					${current.bodyText ?? NULL_TEXT},
					${toJson(current.payloadJson)},
					${'pending'},
					${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
					${0}, ${NULL_TEXT}, ${nowTs},
					${current.sourceObjectType}, ${current.sourceObjectId}, ${current.sourceEventDedupKey},
					${toTs(current.createdAt)}, ${nowTs}, ${current.createdBy}, ${actorUserId}
				)
			`

			// Re-read so caller sees the consistent post-update row.
			const [updatedRows = []] = await sql<NotificationRow[]>`
				SELECT * FROM notificationOutbox
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`
			const updated = updatedRows[0]
			if (!updated) {
				// Should never happen — UPSERT just succeeded.
				throw new NotificationNotFoundError(id)
			}
			return rowToNotification(updated)
		},
	}
}
