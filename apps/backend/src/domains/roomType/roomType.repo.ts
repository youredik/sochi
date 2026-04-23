import type { RoomType, RoomTypeCreateInput, RoomTypeUpdateInput } from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_INT32, NULL_TEXT, toNumber, toTs, tsFromIso } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

type RoomTypeRow = {
	tenantId: string
	id: string
	propertyId: string
	name: string
	description: string | null
	maxOccupancy: number | bigint
	baseBeds: number | bigint
	extraBeds: number | bigint
	areaSqm: number | bigint | null
	inventoryCount: number | bigint
	isActive: boolean
	createdAt: Date
	updatedAt: Date
}

function rowToRoomType(r: RoomTypeRow): RoomType {
	return {
		id: r.id,
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		name: r.name,
		description: r.description,
		maxOccupancy: Number(r.maxOccupancy),
		baseBeds: Number(r.baseBeds),
		extraBeds: Number(r.extraBeds),
		areaSqm: toNumber(r.areaSqm),
		inventoryCount: Number(r.inventoryCount),
		isActive: r.isActive,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

/**
 * RoomType repository — all methods tenant-scoped.
 * Writes use UPSERT for idempotency under retries.
 */
export function createRoomTypeRepo(sql: SqlInstance) {
	return {
		async listByProperty(tenantId: string, propertyId: string, opts: { includeInactive: boolean }) {
			const [rows = []] = opts.includeInactive
				? await sql<RoomTypeRow[]>`
						SELECT * FROM roomType
						WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
				: await sql<RoomTypeRow[]>`
						SELECT * FROM roomType
						WHERE tenantId = ${tenantId} AND propertyId = ${propertyId} AND isActive = ${true}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
			return rows.map(rowToRoomType)
		},

		async getById(tenantId: string, id: string): Promise<RoomType | null> {
			const [rows = []] = await sql<RoomTypeRow[]>`
				SELECT * FROM roomType
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToRoomType(row) : null
		},

		async create(
			tenantId: string,
			propertyId: string,
			input: RoomTypeCreateInput,
		): Promise<RoomType> {
			const id = newId('roomType')
			const now = new Date()
			const nowTs = toTs(now)
			const description = input.description ?? NULL_TEXT
			const areaSqm = input.areaSqm ?? NULL_INT32
			await sql`
				UPSERT INTO roomType (
					\`tenantId\`, \`id\`, \`propertyId\`, \`name\`, \`description\`,
					\`maxOccupancy\`, \`baseBeds\`, \`extraBeds\`, \`areaSqm\`,
					\`inventoryCount\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${id}, ${propertyId}, ${input.name}, ${description},
					${input.maxOccupancy}, ${input.baseBeds}, ${input.extraBeds}, ${areaSqm},
					${input.inventoryCount}, ${true}, ${nowTs}, ${nowTs}
				)
			`
			return {
				id,
				tenantId,
				propertyId,
				name: input.name,
				description: input.description ?? null,
				maxOccupancy: input.maxOccupancy,
				baseBeds: input.baseBeds,
				extraBeds: input.extraBeds,
				areaSqm: input.areaSqm ?? null,
				inventoryCount: input.inventoryCount,
				isActive: true,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			}
		},

		async update(
			tenantId: string,
			id: string,
			patch: RoomTypeUpdateInput,
		): Promise<RoomType | null> {
			// Atomic read-modify-write via YDB Serializable tx.
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<RoomTypeRow[]>`
					SELECT * FROM roomType
					WHERE tenantId = ${tenantId} AND id = ${id}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) return null
				const current = rowToRoomType(row)

				const nextDescription: string | null =
					'description' in patch && patch.description !== undefined
						? patch.description
						: current.description
				const nextAreaSqm: number | null =
					'areaSqm' in patch && patch.areaSqm !== undefined ? patch.areaSqm : current.areaSqm
				const merged: RoomType = {
					...current,
					name: patch.name ?? current.name,
					description: nextDescription,
					maxOccupancy: patch.maxOccupancy ?? current.maxOccupancy,
					baseBeds: patch.baseBeds ?? current.baseBeds,
					extraBeds: patch.extraBeds ?? current.extraBeds,
					areaSqm: nextAreaSqm,
					inventoryCount: patch.inventoryCount ?? current.inventoryCount,
					isActive: patch.isActive ?? current.isActive,
					updatedAt: new Date().toISOString(),
				}
				const description = merged.description ?? NULL_TEXT
				const areaSqm = merged.areaSqm ?? NULL_INT32
				const createdAtTs = tsFromIso(merged.createdAt)
				const updatedAtTs = tsFromIso(merged.updatedAt)
				await tx`
					UPSERT INTO roomType (
						\`tenantId\`, \`id\`, \`propertyId\`, \`name\`, \`description\`,
						\`maxOccupancy\`, \`baseBeds\`, \`extraBeds\`, \`areaSqm\`,
						\`inventoryCount\`, \`isActive\`, \`createdAt\`, \`updatedAt\`
					) VALUES (
						${tenantId}, ${id}, ${merged.propertyId}, ${merged.name}, ${description},
						${merged.maxOccupancy}, ${merged.baseBeds}, ${merged.extraBeds}, ${areaSqm},
						${merged.inventoryCount}, ${merged.isActive}, ${createdAtTs}, ${updatedAtTs}
					)
				`
				return merged
			})
		},

		async delete(tenantId: string, id: string): Promise<boolean> {
			const current = await this.getById(tenantId, id)
			if (!current) return false
			await sql`
				DELETE FROM roomType
				WHERE tenantId = ${tenantId} AND id = ${id}
			`
			return true
		},
	}
}

export type RoomTypeRepo = ReturnType<typeof createRoomTypeRepo>
