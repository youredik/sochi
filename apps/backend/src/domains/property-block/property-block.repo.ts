import type { PropertyBlock, PropertyBlockReason, PropertyBlockUpdateInput } from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { NULL_TEXT, dateFromIso, toTs, tsFromIso } from '../../db/ydb-helpers.ts'
import { PropertyBlockNotFoundError } from '../../errors/domain.ts'

type SqlInstance = typeof SQL

type PropertyBlockRow = {
	tenantId: string
	id: string
	propertyId: string
	roomId: string
	startDate: Date
	endDate: Date
	reason: string
	comment: string | null
	createdBy: string
	createdAt: Date
	updatedAt: Date
}

function rowToBlock(r: PropertyBlockRow): PropertyBlock {
	return {
		id: r.id,
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		roomId: r.roomId,
		startDate: r.startDate.toISOString().slice(0, 10),
		endDate: r.endDate.toISOString().slice(0, 10),
		reason: r.reason as PropertyBlockReason,
		comment: r.comment,
		createdBy: r.createdBy,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

/**
 * Property-block repo. Tenant-scoped reads. All queries `WHERE tenantId = ?`
 * — propertyId additionally verified at service layer (defense-in-depth).
 *
 * Overlap predicate uses standard half-open interval canon:
 *   block.startDate < req.endDate AND block.endDate > req.startDate
 *
 * Mirrors `booking` overlap predicate (`checkIn < endDate AND checkOut >
 * startDate`) — consistent semantics across domains so future joins are
 * trivially correct.
 */
export function createPropertyBlockRepo(sql: SqlInstance) {
	return {
		/**
		 * List blocks whose date range overlaps [from, to) — same windowing
		 * canon as `GET /properties/:propertyId/bookings`. Used by chessboard
		 * grid render.
		 */
		async listByPropertyWindow(
			tenantId: string,
			propertyId: string,
			from: string,
			to: string,
		): Promise<PropertyBlock[]> {
			const [rows = []] = await sql<PropertyBlockRow[]>`
				SELECT * FROM propertyBlock
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND startDate < ${dateFromIso(to)}
					AND endDate > ${dateFromIso(from)}
				ORDER BY startDate ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToBlock)
		},

		async getById(tenantId: string, id: string): Promise<PropertyBlock | null> {
			const [rows = []] = await sql<PropertyBlockRow[]>`
				SELECT * FROM propertyBlock VIEW idxPropertyBlockId
				WHERE tenantId = ${tenantId} AND id = ${id}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToBlock(row) : null
		},

		/**
		 * Find blocks overlapping [startDate, endDate) for a specific room
		 * (excludes given `excludeBlockId` so that update doesn't conflict
		 * with itself).
		 *
		 * Per-row tx-internal call (see service.update / service.create).
		 * Use the per-room index `idxPropertyBlockRoom` so the scan is
		 * O(matching) not O(table).
		 */
		async findOverlappingByRoom(
			tenantId: string,
			roomId: string,
			startDate: string,
			endDate: string,
			excludeBlockId?: string,
		): Promise<PropertyBlock[]> {
			const startD = dateFromIso(startDate)
			const endD = dateFromIso(endDate)
			const [rows = []] = excludeBlockId
				? await sql<PropertyBlockRow[]>`
						SELECT * FROM propertyBlock VIEW idxPropertyBlockRoom
						WHERE tenantId = ${tenantId}
							AND roomId = ${roomId}
							AND startDate < ${endD}
							AND endDate > ${startD}
							AND id != ${excludeBlockId}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
				: await sql<PropertyBlockRow[]>`
						SELECT * FROM propertyBlock VIEW idxPropertyBlockRoom
						WHERE tenantId = ${tenantId}
							AND roomId = ${roomId}
							AND startDate < ${endD}
							AND endDate > ${startD}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
			return rows.map(rowToBlock)
		},

		/**
		 * Create a single block row. Per-row tx (no batch) — same canon as
		 * G8 auto-assign per `[[interval-partition-greedy-canon]]`: per-row
		 * tx avoids YDB session-pool edge with multi-statement batches and
		 * preserves CAS isolation for the overlap-check-then-insert dance.
		 *
		 * Caller (service) MUST have already validated:
		 *   - room belongs to property
		 *   - no overlapping booking (block-over-booking hard-block canon)
		 *   - no overlapping block (idempotency / operator clarity)
		 */
		async create(
			tenantId: string,
			propertyId: string,
			roomId: string,
			startDate: string,
			endDate: string,
			reason: PropertyBlockReason,
			comment: string | null,
			createdBy: string,
		): Promise<PropertyBlock> {
			const id = newId('propertyBlock')
			const now = new Date()
			const nowTs = toTs(now)
			const startD = dateFromIso(startDate)
			const endD = dateFromIso(endDate)
			const commentVal = comment ?? NULL_TEXT
			await sql`
				UPSERT INTO propertyBlock (
					\`tenantId\`, \`id\`, \`propertyId\`, \`roomId\`,
					\`startDate\`, \`endDate\`, \`reason\`, \`comment\`,
					\`createdBy\`, \`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${id}, ${propertyId}, ${roomId},
					${startD}, ${endD}, ${reason}, ${commentVal},
					${createdBy}, ${nowTs}, ${nowTs}
				)
			`
			return {
				id,
				tenantId,
				propertyId,
				roomId,
				startDate,
				endDate,
				reason,
				comment,
				createdBy,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			}
		},

		/**
		 * Update mutable fields. Service layer enforces past-immutability +
		 * overlap check inside the same tx. Atomic read-modify-write.
		 */
		async update(
			tenantId: string,
			id: string,
			patch: PropertyBlockUpdateInput,
		): Promise<PropertyBlock> {
			return await sql.begin({ idempotent: true }, async (tx) => {
				const [rows = []] = await tx<PropertyBlockRow[]>`
					SELECT * FROM propertyBlock VIEW idxPropertyBlockId
					WHERE tenantId = ${tenantId} AND id = ${id}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) throw new PropertyBlockNotFoundError(id)
				const current = rowToBlock(row)

				const merged: PropertyBlock = {
					...current,
					startDate: patch.startDate ?? current.startDate,
					endDate: patch.endDate ?? current.endDate,
					reason: patch.reason ?? current.reason,
					comment:
						'comment' in patch && patch.comment !== undefined ? patch.comment : current.comment,
					updatedAt: new Date().toISOString(),
				}
				const startD = dateFromIso(merged.startDate)
				const endD = dateFromIso(merged.endDate)
				const commentVal = merged.comment ?? NULL_TEXT
				const createdAtTs = tsFromIso(merged.createdAt)
				const updatedAtTs = tsFromIso(merged.updatedAt)
				await tx`
					UPSERT INTO propertyBlock (
						\`tenantId\`, \`id\`, \`propertyId\`, \`roomId\`,
						\`startDate\`, \`endDate\`, \`reason\`, \`comment\`,
						\`createdBy\`, \`createdAt\`, \`updatedAt\`
					) VALUES (
						${tenantId}, ${id}, ${merged.propertyId}, ${merged.roomId},
						${startD}, ${endD}, ${merged.reason}, ${commentVal},
						${merged.createdBy}, ${createdAtTs}, ${updatedAtTs}
					)
				`
				return merged
			})
		},

		async delete(tenantId: string, id: string): Promise<boolean> {
			const current = await this.getById(tenantId, id)
			if (!current) return false
			await sql`
				DELETE FROM propertyBlock
				WHERE tenantId = ${tenantId} AND id = ${id}
			`
			return true
		},

		/**
		 * Bulk-window count: how many distinct rooms (of a given roomType,
		 * indirectly via room.roomTypeId) are blocked at ANY day overlapping
		 * [from, to). Used by availability endpoint — returns the SET of
		 * blocked roomIds; caller intersects with room-type rooms.
		 *
		 * NB: blocks are per-room, not per-roomType, so we can't filter by
		 * roomTypeId at SQL — caller passes pre-resolved roomIds.
		 */
		async listBlockedRoomIdsInWindow(
			tenantId: string,
			propertyId: string,
			from: string,
			to: string,
		): Promise<string[]> {
			const [rows = []] = await sql<{ roomId: string }[]>`
				SELECT DISTINCT roomId FROM propertyBlock
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND startDate < ${dateFromIso(to)}
					AND endDate > ${dateFromIso(from)}
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map((r) => r.roomId)
		},
	}
}

export type PropertyBlockRepo = ReturnType<typeof createPropertyBlockRepo>
