import type { Activity, ActivityObjectType, ActivityType } from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_TEXT, toJson, toTs } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

type ActivityRow = {
	tenantId: string
	objectType: string
	recordId: string
	createdAt: Date
	id: string
	activityType: string
	actorUserId: string
	impersonatorUserId: string | null
	diffJson: unknown
}

function rowToActivity(r: ActivityRow): Activity {
	return {
		tenantId: r.tenantId,
		objectType: r.objectType as ActivityObjectType,
		recordId: r.recordId,
		createdAt: r.createdAt.toISOString(),
		id: r.id,
		activityType: r.activityType as ActivityType,
		actorUserId: r.actorUserId,
		impersonatorUserId: r.impersonatorUserId,
		diffJson: r.diffJson,
	}
}

export type ActivityInsertInput = {
	tenantId: string
	objectType: ActivityObjectType
	recordId: string
	activityType: ActivityType
	actorUserId: string
	/** Present when a super-admin was acting as `actorUserId`. Default null. */
	impersonatorUserId?: string | null
	diffJson: unknown
}

/**
 * Shared INSERT body parameterised by the SQL surface — the global pool
 * (`sql`) for non-tx call paths, or a tx (`TX` from `sql.begin` / topic-tx
 * reader) for CDC consumer projections.
 *
 * `TX extends SQL`, so the same tagged-template body works in both modes.
 *
 * `dedupKey` (optional): when supplied, runs a SELECT-then-INSERT pre-check
 * via `ixActivityDedup` index (migration 0018). Returns the existing
 * activity row instead of inserting a duplicate — handles the at-least-once
 * commit-after-projection-success replay race in the CDC consumer.
 *
 * Pattern is the same as refund-creator + notification handlers'
 * idempotent SELECT-then-UPSERT (avoids YDB tx-poison-on-PK pattern).
 */
async function runInsert(
	qrun: SqlInstance | TX,
	input: ActivityInsertInput,
	dedupKey: string | null = null,
): Promise<Activity> {
	if (dedupKey !== null) {
		const [existingRows = []] = await qrun<ActivityRow[]>`
			SELECT \`tenantId\`, \`objectType\`, \`recordId\`, \`createdAt\`, \`id\`,
				\`activityType\`, \`actorUserId\`, \`impersonatorUserId\`, \`diffJson\`
			FROM activity VIEW ixActivityDedup
			WHERE tenantId = ${input.tenantId} AND eventDedupKey = ${dedupKey}
			LIMIT 1
		`
		const existing = existingRows[0]
		if (existing) return rowToActivity(existing)
	}
	const id = newId('activity')
	const now = new Date()
	const nowTs = toTs(now)
	const impersonatorUserId = input.impersonatorUserId ?? null
	const impersonatorBind = impersonatorUserId ?? NULL_TEXT
	await qrun`
		UPSERT INTO activity (
			\`tenantId\`, \`objectType\`, \`recordId\`, \`createdAt\`, \`id\`,
			\`activityType\`, \`actorUserId\`, \`impersonatorUserId\`, \`diffJson\`,
			\`eventDedupKey\`
		) VALUES (
			${input.tenantId}, ${input.objectType}, ${input.recordId}, ${nowTs}, ${id},
			${input.activityType}, ${input.actorUserId}, ${impersonatorBind}, ${toJson(input.diffJson)},
			${dedupKey ?? NULL_TEXT}
		)
	`
	return {
		tenantId: input.tenantId,
		objectType: input.objectType,
		recordId: input.recordId,
		createdAt: now.toISOString(),
		id,
		activityType: input.activityType,
		actorUserId: input.actorUserId,
		impersonatorUserId,
		diffJson: input.diffJson,
	}
}

/**
 * Activity repository. Polymorphic audit log — see memory
 * `project_event_architecture.md`. NOT called from business/domain services;
 * ONLY the CDC consumer inserts. Reads: admin-UI "history of record X".
 *
 * JSON column binding: `diffJson` always wrapped via `toJson()` — YDB rejects
 * bare-string/object binds for Json columns (memory `project_ydb_specifics.md`
 * #13 + M4a empirical lesson). BigInts inside serialize as decimal strings
 * via toJson's replacer and hydrate back in hot code that needs them.
 */
export function createActivityRepo(sql: SqlInstance) {
	return {
		async insert(input: ActivityInsertInput): Promise<Activity> {
			return await runInsert(sql, input)
		},

		/**
		 * Insert WITHIN a caller-provided transaction. Used by CDC consumers so
		 * the activity row commits in the same projection tx as the source
		 * domain change (the CDC consumer then commits the topic offset via
		 * `reader.commit(batch)` AFTER the projection tx commits — at-least-
		 * once delivery; idempotency provided by `dedupKey`).
		 *
		 * `dedupKey` MUST be deterministic per CDC event × derived activity index
		 * — see `handlers/activity.ts` for the build (CDC virtual timestamp
		 * `${ts[0]}-${ts[1]}-${i}`). Omit / pass `null` for non-CDC call paths.
		 */
		async insertTx(
			tx: TX,
			input: ActivityInsertInput,
			dedupKey: string | null = null,
		): Promise<Activity> {
			return await runInsert(tx, input, dedupKey)
		},

		/**
		 * List activities for a single record, oldest first.
		 * PK-prefix scan on `(tenantId, objectType, recordId)` — efficient.
		 */
		async listForRecord(
			tenantId: string,
			objectType: ActivityObjectType,
			recordId: string,
			limit: number,
		): Promise<Activity[]> {
			const [rows = []] = await sql<ActivityRow[]>`
				SELECT * FROM activity
				WHERE tenantId = ${tenantId}
					AND objectType = ${objectType}
					AND recordId = ${recordId}
				ORDER BY createdAt ASC, id ASC
				LIMIT ${limit}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToActivity)
		},
	}
}

export type ActivityRepo = ReturnType<typeof createActivityRepo>
