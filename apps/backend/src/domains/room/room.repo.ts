import type { Room, RoomCreateInput, RoomUpdateInput } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { Optional } from '@ydbjs/value/optional'
import { Int32Type, TextType } from '@ydbjs/value/primitive'
import type { sql as SQL } from '../../db/index.ts'

type SqlInstance = typeof SQL

const NULL_TEXT = new Optional(null, new TextType())
const NULL_INT32 = new Optional(null, new Int32Type())

type RoomRow = {
	tenantId: string
	id: string
	propertyId: string
	roomTypeId: string
	number: string
	floor: number | bigint | null
	isActive: boolean
	notes: string | null
	createdAt: Date
	updatedAt: Date
}

function toNumber(v: number | bigint | null): number | null {
	if (v === null) return null
	return typeof v === 'bigint' ? Number(v) : v
}

function rowToRoom(r: RoomRow): Room {
	return {
		id: r.id,
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		roomTypeId: r.roomTypeId,
		number: r.number,
		floor: toNumber(r.floor),
		isActive: r.isActive,
		notes: r.notes,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

/**
 * Room repository. Tenant-scoped reads. Writes include `propertyId` which
 * the service layer resolves from the parent roomType (single source of truth).
 */
export function createRoomRepo(sql: SqlInstance) {
	return {
		async listByProperty(
			tenantId: string,
			propertyId: string,
			opts: { includeInactive: boolean; roomTypeId?: string },
		) {
			if (opts.roomTypeId) {
				const [rows] = opts.includeInactive
					? await sql<RoomRow[]>`
							SELECT * FROM room
							WHERE tenantId = ${tenantId}
								AND propertyId = ${propertyId}
								AND roomTypeId = ${opts.roomTypeId}
						`
							.isolation('snapshotReadOnly')
							.idempotent(true)
					: await sql<RoomRow[]>`
							SELECT * FROM room
							WHERE tenantId = ${tenantId}
								AND propertyId = ${propertyId}
								AND roomTypeId = ${opts.roomTypeId}
								AND isActive = ${true}
						`
							.isolation('snapshotReadOnly')
							.idempotent(true)
				return rows.map(rowToRoom)
			}
			const [rows] = opts.includeInactive
				? await sql<RoomRow[]>`
						SELECT * FROM room
						WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
				: await sql<RoomRow[]>`
						SELECT * FROM room
						WHERE tenantId = ${tenantId} AND propertyId = ${propertyId} AND isActive = ${true}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
			return rows.map(rowToRoom)
		},

		async getById(tenantId: string, id: string): Promise<Room | null> {
			const [rows] = await sql<RoomRow[]>`
				SELECT * FROM room
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToRoom(row) : null
		},

		async create(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			input: RoomCreateInput,
		): Promise<Room> {
			const id = newId('room')
			const now = new Date()
			const floor = input.floor ?? NULL_INT32
			const notes = input.notes ?? NULL_TEXT
			await sql`
				UPSERT INTO room (
					\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`number\`,
					\`floor\`, \`isActive\`, \`notes\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${id}, ${propertyId}, ${roomTypeId}, ${input.number},
					${floor}, ${true}, ${notes}, ${now}, ${now}
				)
			`
			return {
				id,
				tenantId,
				propertyId,
				roomTypeId,
				number: input.number,
				floor: input.floor ?? null,
				isActive: true,
				notes: input.notes ?? null,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			}
		},

		async update(
			tenantId: string,
			id: string,
			patch: RoomUpdateInput,
			newPropertyId?: string,
		): Promise<Room | null> {
			const current = await this.getById(tenantId, id)
			if (!current) return null

			const merged: Room = {
				...current,
				propertyId: newPropertyId ?? current.propertyId,
				roomTypeId: patch.roomTypeId ?? current.roomTypeId,
				number: patch.number ?? current.number,
				floor: patch.floor === undefined ? current.floor : patch.floor,
				notes: patch.notes === undefined ? current.notes : patch.notes,
				isActive: patch.isActive ?? current.isActive,
				updatedAt: new Date().toISOString(),
			}
			const floor = merged.floor ?? NULL_INT32
			const notes = merged.notes ?? NULL_TEXT
			await sql`
				UPSERT INTO room (
					\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`number\`,
					\`floor\`, \`isActive\`, \`notes\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${id}, ${merged.propertyId}, ${merged.roomTypeId}, ${merged.number},
					${floor}, ${merged.isActive}, ${notes}, ${new Date(merged.createdAt)}, ${new Date(merged.updatedAt)}
				)
			`
			return merged
		},

		async delete(tenantId: string, id: string): Promise<boolean> {
			const current = await this.getById(tenantId, id)
			if (!current) return false
			await sql`
				DELETE FROM room
				WHERE tenantId = ${tenantId} AND id = ${id}
			`
			return true
		},
	}
}

export type RoomRepo = ReturnType<typeof createRoomRepo>
