import type { Activity, ActivityObjectType, ActivityType } from '@horeca/shared'
import { newId } from '@horeca/shared'
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
			const id = newId('activity')
			const now = new Date()
			const nowTs = toTs(now)
			const impersonatorUserId = input.impersonatorUserId ?? null
			// YDB `@ydbjs/query` rejects bare JS null → bind via typed `NULL_TEXT`
			// when absent. Present value binds as plain string (auto-inferred Utf8).
			const impersonatorBind = impersonatorUserId ?? NULL_TEXT
			await sql`
				UPSERT INTO activity (
					\`tenantId\`, \`objectType\`, \`recordId\`, \`createdAt\`, \`id\`,
					\`activityType\`, \`actorUserId\`, \`impersonatorUserId\`, \`diffJson\`
				) VALUES (
					${input.tenantId}, ${input.objectType}, ${input.recordId}, ${nowTs}, ${id},
					${input.activityType}, ${input.actorUserId}, ${impersonatorBind}, ${toJson(input.diffJson)}
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
