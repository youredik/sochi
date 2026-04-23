import type { Property, PropertyCreateInput, PropertyUpdateInput } from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_TEXT, toTs, tsFromIso } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

/**
 * Raw YDB row shape. `createdAt`/`updatedAt` come back as JS Date from the SDK
 * (Timestamp → Date automatic conversion via @ydbjs/query.toJs).
 */
type PropertyRow = {
	tenantId: string
	id: string
	name: string
	address: string
	city: string
	timezone: string
	classificationId: string | null
	isActive: boolean
	createdAt: Date
	updatedAt: Date
}

function rowToProperty(r: PropertyRow): Property {
	return {
		id: r.id,
		tenantId: r.tenantId,
		name: r.name,
		address: r.address,
		city: r.city as Property['city'],
		timezone: r.timezone,
		classificationId: r.classificationId,
		isActive: r.isActive,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

/**
 * Property repository. All queries are tenant-scoped — `tenantId` is the
 * first column of the PK, so YDB runs them as a partition-local scan.
 * The signature forces `tenantId` on every method; there is no public API
 * that skips it.
 */
export function createPropertyRepo(sql: SqlInstance) {
	return {
		async list(tenantId: string, opts: { includeInactive: boolean }) {
			const [rows = []] = opts.includeInactive
				? await sql<PropertyRow[]>`
						SELECT * FROM property
						WHERE tenantId = ${tenantId}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
				: await sql<PropertyRow[]>`
						SELECT * FROM property
						WHERE tenantId = ${tenantId} AND isActive = ${true}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
			return rows.map(rowToProperty)
		},

		async getById(tenantId: string, id: string): Promise<Property | null> {
			const [rows = []] = await sql<PropertyRow[]>`
				SELECT * FROM property
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToProperty(row) : null
		},

		async create(tenantId: string, input: PropertyCreateInput): Promise<Property> {
			const id = newId('property')
			const now = new Date()
			const nowTs = toTs(now)
			const timezone = input.timezone ?? 'Europe/Moscow'
			await sql`
				UPSERT INTO property (
					\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
					\`isActive\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${id}, ${input.name}, ${input.address}, ${input.city}, ${timezone},
					${true}, ${nowTs}, ${nowTs}
				)
			`
			return {
				id,
				tenantId,
				name: input.name,
				address: input.address,
				city: input.city,
				timezone,
				classificationId: null,
				isActive: true,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			}
		},

		async update(
			tenantId: string,
			id: string,
			patch: PropertyUpdateInput,
		): Promise<Property | null> {
			// Atomic read-modify-write. YDB default isolation is Serializable;
			// concurrent PATCHes on the same row conflict → one commits, the
			// other retries via @ydbjs/retry.
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<PropertyRow[]>`
					SELECT * FROM property
					WHERE tenantId = ${tenantId} AND id = ${id}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) return null
				const current = rowToProperty(row)

				// Nullable-field patch rule: treat `undefined` as "no change",
				// `null` as "explicit clear". Plain `??` fails to distinguish them.
				const nextClassificationId: string | null =
					'classificationId' in patch && patch.classificationId !== undefined
						? patch.classificationId
						: current.classificationId
				const merged: Property = {
					...current,
					...patch,
					classificationId: nextClassificationId,
					updatedAt: new Date().toISOString(),
				}

				const createdAtTs = tsFromIso(merged.createdAt)
				const updatedAtTs = tsFromIso(merged.updatedAt)
				const classificationId = merged.classificationId ?? NULL_TEXT
				await tx`
					UPSERT INTO property (
						\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
						\`classificationId\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
					) VALUES (
						${tenantId}, ${id}, ${merged.name}, ${merged.address}, ${merged.city}, ${merged.timezone},
						${classificationId}, ${merged.isActive}, ${createdAtTs}, ${updatedAtTs}
					)
				`
				return merged
			})
		},

		async delete(tenantId: string, id: string): Promise<boolean> {
			const current = await this.getById(tenantId, id)
			if (!current) return false
			await sql`
				DELETE FROM property
				WHERE tenantId = ${tenantId} AND id = ${id}
			`
			return true
		},
	}
}

export type PropertyRepo = ReturnType<typeof createPropertyRepo>
