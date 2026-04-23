import type { Property, PropertyCreateInput, PropertyUpdateInput } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { Optional } from '@ydbjs/value/optional'
import { TextType } from '@ydbjs/value/primitive'
import type { sql as SQL } from '../../db/index.ts'

type SqlInstance = typeof SQL

// YDB rejects raw JS null in tagged templates — see project_ydb_specifics.md.
// Preallocate typed nulls for each nullable column.
const NULL_TEXT = new Optional(null, new TextType())

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
			const [rows] = opts.includeInactive
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
			const [rows] = await sql<PropertyRow[]>`
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
			const timezone = input.timezone ?? 'Europe/Moscow'
			await sql`
				UPSERT INTO property (
					\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
					\`isActive\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${id}, ${input.name}, ${input.address}, ${input.city}, ${timezone},
					${true}, ${now}, ${now}
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
			const current = await this.getById(tenantId, id)
			if (!current) return null

			const merged: Property = {
				...current,
				...patch,
				classificationId:
					patch.classificationId === undefined ? current.classificationId : patch.classificationId,
				updatedAt: new Date().toISOString(),
			}

			const updatedAt = new Date(merged.updatedAt)
			const classificationId = merged.classificationId ?? NULL_TEXT
			// UPSERT rewrites the full row — simple, atomic, native YDB pattern.
			await sql`
				UPSERT INTO property (
					\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
					\`classificationId\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${id}, ${merged.name}, ${merged.address}, ${merged.city}, ${merged.timezone},
					${classificationId}, ${merged.isActive}, ${new Date(merged.createdAt)}, ${updatedAt}
				)
			`
			return merged
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
