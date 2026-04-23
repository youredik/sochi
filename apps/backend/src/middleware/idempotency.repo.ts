import { Json } from '@ydbjs/value/primitive'
import type { sql as SQL } from '../db/index.ts'
import { toTs } from '../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

type IdempotencyRow = {
	tenantId: string
	key: string
	requestFingerprintSha256: string
	responseStatus: number | bigint
	// @ydbjs/query auto-parses `Json` columns into JS values (we wrote it via
	// `new Json(text)` on the insert side — YDB round-trips as parsed object).
	responseBodyJson: unknown
	createdAt: Date
}

type IdempotencyRecord = {
	tenantId: string
	key: string
	requestFingerprintSha256: string
	responseStatus: number
	responseBody: unknown
	createdAt: string
}

/**
 * Tenant-scoped storage for `Idempotency-Key` → cached response pairs.
 * Row TTL is 24h (YDB-native, configured inline in migration 0004). Readers
 * should treat a missing row as "never seen or expired"; a write into a
 * post-expiry key is indistinguishable from a fresh key — that's the
 * desired client-visible semantic (Stripe convention).
 *
 * NOT a domain repo — lives under `middleware/` because its only caller is
 * the HTTP idempotency middleware. Booking/rate/etc. domain code never
 * touches it.
 */
export function createIdempotencyRepo(sql: SqlInstance) {
	return {
		async find(tenantId: string, key: string): Promise<IdempotencyRecord | null> {
			const [rows = []] = await sql<IdempotencyRow[]>`
				SELECT * FROM idempotencyKey
				WHERE tenantId = ${tenantId} AND key = ${key}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (!row) return null
			return {
				tenantId: row.tenantId,
				key: row.key,
				requestFingerprintSha256: row.requestFingerprintSha256,
				responseStatus: Number(row.responseStatus),
				responseBody: row.responseBodyJson,
				createdAt: row.createdAt.toISOString(),
			}
		},

		/**
		 * INSERT-only (via UPSERT to avoid throwing on racy concurrent writes).
		 * Caller guarantees fingerprint uniqueness per key — see middleware
		 * logic, which re-reads before storing.
		 */
		async store(
			tenantId: string,
			key: string,
			fingerprint: string,
			responseStatus: number,
			responseBodyJson: string,
			createdAt: Date,
		): Promise<void> {
			// Pre-serialized JSON text is bound as YDB `Json` primitive explicitly —
			// bare `${string}` infers as `Utf8` which YDB rejects for a `Json NOT NULL`
			// column with `ERROR(1030): Type annotation`.
			await sql`
				UPSERT INTO idempotencyKey (
					\`tenantId\`, \`key\`,
					\`requestFingerprintSha256\`,
					\`responseStatus\`, \`responseBodyJson\`, \`createdAt\`
				) VALUES (
					${tenantId}, ${key},
					${fingerprint},
					${responseStatus}, ${new Json(responseBodyJson)}, ${toTs(createdAt)}
				)
			`
		},
	}
}

export type IdempotencyRepo = ReturnType<typeof createIdempotencyRepo>
