/**
 * Channel inbox repo — M10 / A7.1.fix.
 *
 * UPSERT-shaped idempotent inbound webhook persistence per D11 (CloudEvents
 * 1.0.2 idempotency tuple `(source, eventId)` = composite PK).
 *
 * Behaviour (per `inbox.ts` lib `classifyIncoming`):
 *   - first delivery (source, eventId) → INSERT, return `accepted`
 *   - duplicate same body → return cached responseJson, status='processed'
 *   - duplicate different body → return `tampered` flag, do NOT mutate row
 *
 * Cross-tenant guard: PK is `(source, eventId)` per CE 1.0.2 spec; tenantId
 * is denormalized for index reads. Service-side check ensures source URN
 * encodes tenantId via `buildSourceUrn` so cross-tenant dedup attempts fail
 * the source-mismatch check.
 */

import type { sql as SQL } from '../../db/index.ts'
import { NULL_INT32, textOpt, toJson } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

export type InboxStatus = 'received' | 'processing' | 'processed' | 'failed'

export interface InboxRecord {
	readonly source: string
	readonly eventId: string
	readonly tenantId: string
	readonly channelId: string
	readonly eventType: string
	readonly receivedAt: string
	readonly bodyHash: string
	readonly signatureKid: string | null
	readonly status: InboxStatus
	readonly responseJson: unknown
	readonly retryCount: number
}

export interface InboxInsertInput {
	readonly source: string
	readonly eventId: string
	readonly tenantId: string
	readonly channelId: string
	readonly eventType: string
	readonly bodyHash: string
	readonly signatureKid?: string | null
}

type InboxYdbRow = {
	source: string
	eventId: string
	tenantId: string
	channelId: string
	eventType: string
	receivedAt: Date
	bodyHash: string
	signatureKid: string | null
	status: string
	responseJson: unknown
	retryCount: number | bigint
}

function rowToInbox(r: InboxYdbRow): InboxRecord {
	return {
		source: r.source,
		eventId: r.eventId,
		tenantId: r.tenantId,
		channelId: r.channelId,
		eventType: r.eventType,
		receivedAt: r.receivedAt.toISOString(),
		bodyHash: r.bodyHash,
		signatureKid: r.signatureKid,
		status: r.status as InboxStatus,
		responseJson: r.responseJson,
		retryCount: typeof r.retryCount === 'bigint' ? Number(r.retryCount) : r.retryCount,
	}
}

export type InboxClassification =
	| { readonly kind: 'accepted'; readonly record: InboxRecord }
	| { readonly kind: 'duplicate'; readonly record: InboxRecord }
	| { readonly kind: 'tampered'; readonly stored: InboxRecord }

export function createInboxRepo(sql: SqlInstance) {
	return {
		/**
		 * Atomic classify+insert. Wraps SELECT-then-INSERT в Serializable tx
		 * so concurrent identical (source, eventId) deliveries don't both INSERT.
		 *
		 * Returns:
		 *   - `accepted` first time
		 *   - `duplicate` on identical body replay
		 *   - `tampered` on bodyHash mismatch (replay attack OR sender bug)
		 */
		async classifyAndInsert(input: InboxInsertInput): Promise<InboxClassification> {
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<InboxYdbRow[]>`
					SELECT
						source, eventId, tenantId, channelId, eventType,
						receivedAt, bodyHash, signatureKid, status, responseJson, retryCount
					FROM channelInbox
					WHERE source = ${input.source} AND eventId = ${input.eventId}
					LIMIT 1
				`
				const existing = rows[0]
				if (existing !== undefined) {
					const stored = rowToInbox(existing)
					if (stored.bodyHash !== input.bodyHash) {
						return { kind: 'tampered', stored } as InboxClassification
					}
					return { kind: 'duplicate', record: stored } as InboxClassification
				}
				const now = new Date()
				await tx`
					INSERT INTO channelInbox (
						source, eventId, tenantId, channelId, eventType,
						receivedAt, bodyHash, signatureKid, status, responseJson, retryCount
					) VALUES (
						${input.source}, ${input.eventId}, ${input.tenantId},
						${input.channelId}, ${input.eventType},
						${now}, ${input.bodyHash},
						${textOpt(input.signatureKid ?? null)},
						${'received'}, ${toJson(null)}, ${0}
					)
				`
				return {
					kind: 'accepted',
					record: {
						source: input.source,
						eventId: input.eventId,
						tenantId: input.tenantId,
						channelId: input.channelId,
						eventType: input.eventType,
						receivedAt: now.toISOString(),
						bodyHash: input.bodyHash,
						signatureKid: input.signatureKid ?? null,
						status: 'received',
						responseJson: null,
						retryCount: 0,
					},
				} as InboxClassification
			})
		},

		async markProcessed(input: {
			readonly source: string
			readonly eventId: string
			readonly responseJson: unknown
		}): Promise<void> {
			await sql`
				UPDATE channelInbox
				SET status = ${'processed'},
				    responseJson = ${toJson(input.responseJson)}
				WHERE source = ${input.source} AND eventId = ${input.eventId}
			`
		},

		async markFailed(input: {
			readonly source: string
			readonly eventId: string
			readonly retryCount: number
		}): Promise<void> {
			await sql`
				UPDATE channelInbox
				SET status = ${'failed'},
				    retryCount = ${input.retryCount}
				WHERE source = ${input.source} AND eventId = ${input.eventId}
			`
			void NULL_INT32
		},

		async getById(input: {
			readonly source: string
			readonly eventId: string
		}): Promise<InboxRecord | null> {
			const [rows = []] = await sql<InboxYdbRow[]>`
				SELECT
					source, eventId, tenantId, channelId, eventType,
					receivedAt, bodyHash, signatureKid, status, responseJson, retryCount
				FROM channelInbox
				WHERE source = ${input.source} AND eventId = ${input.eventId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToInbox(row) : null
		},

		async listByTenant(
			tenantId: string,
			opts: { readonly limit?: number } = {},
		): Promise<ReadonlyArray<InboxRecord>> {
			const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000))
			const [rows = []] = await sql<InboxYdbRow[]>`
				SELECT
					source, eventId, tenantId, channelId, eventType,
					receivedAt, bodyHash, signatureKid, status, responseJson, retryCount
				FROM channelInbox
				WHERE tenantId = ${tenantId}
				LIMIT ${limit}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToInbox)
		},
	}
}
