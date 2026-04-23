import type { Room, RoomCreateInput, RoomUpdateInput } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { YDBError } from '@ydbjs/error'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_INT32, NULL_TEXT, toNumber, toTs, tsFromIso } from '../../db/ydb-helpers.ts'
import { RoomNumberTakenError } from '../../errors/domain.ts'

type SqlInstance = typeof SQL

/**
 * YDB PRECONDITION_FAILED status code (issueCode 2012 "Conflict with existing key").
 * This is how UNIQUE index violations surface in the Query Service. Code value
 * verified against stankoff-v2/objects/schema/schema.db.test.ts.
 */
const YDB_PRECONDITION_FAILED = 400120

function isUniqueConflict(err: unknown): err is YDBError {
	return err instanceof YDBError && err.code === YDB_PRECONDITION_FAILED
}

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
				const [rows = []] = opts.includeInactive
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
			const [rows = []] = opts.includeInactive
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
			const [rows = []] = await sql<RoomRow[]>`
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
			const nowTs = toTs(now)
			const floor = input.floor ?? NULL_INT32
			const notes = input.notes ?? NULL_TEXT
			try {
				await sql`
					UPSERT INTO room (
						\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`number\`,
						\`floor\`, \`isActive\`, \`notes\`, \`createdAt\`, \`updatedAt\`
					) VALUES (
						${tenantId}, ${id}, ${propertyId}, ${roomTypeId}, ${input.number},
						${floor}, ${true}, ${notes}, ${nowTs}, ${nowTs}
					)
				`
			} catch (err) {
				if (isUniqueConflict(err)) throw new RoomNumberTakenError(input.number)
				throw err
			}
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
			// Atomic read-modify-write via YDB Serializable tx.
			// Note: @ydbjs/query's sql.begin() wraps any non-retryable error thrown
			// from the callback in `new Error("Transaction failed.", { cause })`. We
			// re-throw the original cause below so route handlers can `instanceof`
			// our domain errors (RoomNumberTakenError) without walking .cause.
			try {
				return await sql.begin(async (tx) => {
					const [rows = []] = await tx<RoomRow[]>`
						SELECT * FROM room
						WHERE tenantId = ${tenantId} AND id = ${id}
						LIMIT 1
					`
					const row = rows[0]
					if (!row) return null
					const current = rowToRoom(row)

					const nextFloor: number | null =
						'floor' in patch && patch.floor !== undefined ? patch.floor : current.floor
					const nextNotes: string | null =
						'notes' in patch && patch.notes !== undefined ? patch.notes : current.notes
					const merged: Room = {
						...current,
						propertyId: newPropertyId ?? current.propertyId,
						roomTypeId: patch.roomTypeId ?? current.roomTypeId,
						number: patch.number ?? current.number,
						floor: nextFloor,
						notes: nextNotes,
						isActive: patch.isActive ?? current.isActive,
						updatedAt: new Date().toISOString(),
					}
					const floor = merged.floor ?? NULL_INT32
					const notes = merged.notes ?? NULL_TEXT
					const createdAtTs = tsFromIso(merged.createdAt)
					const updatedAtTs = tsFromIso(merged.updatedAt)
					try {
						await tx`
							UPSERT INTO room (
								\`tenantId\`, \`id\`, \`propertyId\`, \`roomTypeId\`, \`number\`,
								\`floor\`, \`isActive\`, \`notes\`, \`createdAt\`, \`updatedAt\`
							) VALUES (
								${tenantId}, ${id}, ${merged.propertyId}, ${merged.roomTypeId}, ${merged.number},
								${floor}, ${merged.isActive}, ${notes}, ${createdAtTs}, ${updatedAtTs}
							)
						`
					} catch (err) {
						if (isUniqueConflict(err)) throw new RoomNumberTakenError(merged.number)
						throw err
					}
					return merged
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof RoomNumberTakenError) {
					throw err.cause
				}
				throw err
			}
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
