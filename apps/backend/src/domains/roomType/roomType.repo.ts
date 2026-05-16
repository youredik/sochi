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

function rowToRoomType(r: RoomTypeRow, derivedCount?: number | bigint): RoomType {
	// `inventoryCount` is canonically DERIVED from active room rows
	// (see `category-form-sheet.test.tsx [R3]` canon). The stored
	// `roomType.inventoryCount` column persists the onboarding-time
	// planning intent and drifts когда rooms are added/removed via
	// bulk-rooms admin; we ALWAYS prefer the derived count в read paths
	// чтобы grid header + widget capacity + JSON-LD numberOfRooms
	// reflect reality, not stale planning intent. Fallback к stored
	// value covers `getById`-without-join + create-response (where
	// derived count would be zero immediately после creation).
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
		inventoryCount: derivedCount !== undefined ? Number(derivedCount) : Number(r.inventoryCount),
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
			// Derived inventoryCount via YQL named-result-set + LEFT JOIN
			// (correlated subqueries в SELECT clause не поддерживаются YDB —
			// per `[[ydb-specifics]]`). Canonical fix (2026-05-16) для
			// operator-trust bug где stored `roomType.inventoryCount` drifts
			// от actual rooms (bulk-rooms admin add/remove не обновляет
			// stored). Counts only ACTIVE rooms (matches грид + widget
			// capacity + availability semantics).
			type RowWithCount = RoomTypeRow & { derivedRoomCount: number | bigint | null }
			const [rows = []] = opts.includeInactive
				? await sql<RowWithCount[]>`
						$counts = SELECT roomTypeId, COUNT(*) AS cnt FROM room
							WHERE tenantId = ${tenantId} AND isActive = ${true}
							GROUP BY roomTypeId;
						SELECT rt.*, c.cnt AS derivedRoomCount
						FROM roomType AS rt LEFT JOIN $counts AS c ON c.roomTypeId = rt.id
						WHERE rt.tenantId = ${tenantId} AND rt.propertyId = ${propertyId}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
				: await sql<RowWithCount[]>`
						$counts = SELECT roomTypeId, COUNT(*) AS cnt FROM room
							WHERE tenantId = ${tenantId} AND isActive = ${true}
							GROUP BY roomTypeId;
						SELECT rt.*, c.cnt AS derivedRoomCount
						FROM roomType AS rt LEFT JOIN $counts AS c ON c.roomTypeId = rt.id
						WHERE rt.tenantId = ${tenantId} AND rt.propertyId = ${propertyId} AND rt.isActive = ${true}
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
			return rows.map((r) => rowToRoomType(r, r.derivedRoomCount ?? 0))
		},

		async getById(tenantId: string, id: string): Promise<RoomType | null> {
			// Same canonical derived-count pattern (YQL named-result-set
			// + LEFT JOIN). Callers reading single roomType (e.g., booking-
			// edit-sheet's «Изменить тариф» dropdown, validation flows)
			// must see actual room count, not stored planning intent.
			type RowWithCount = RoomTypeRow & { derivedRoomCount: number | bigint | null }
			const [rows = []] = await sql<RowWithCount[]>`
				$counts = SELECT roomTypeId, COUNT(*) AS cnt FROM room
					WHERE tenantId = ${tenantId} AND roomTypeId = ${id} AND isActive = ${true}
					GROUP BY roomTypeId;
				SELECT rt.*, c.cnt AS derivedRoomCount
				FROM roomType AS rt LEFT JOIN $counts AS c ON c.roomTypeId = rt.id
				WHERE rt.tenantId = ${tenantId} AND rt.id = ${id}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToRoomType(row, row.derivedRoomCount ?? 0) : null
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
			// Return derived inventoryCount (per canon 2026-05-16) — at
			// creation time no rooms exist yet for this brand-new roomType
			// so derived count = 0. Consumers (onboarding, admin form) get
			// honest «no rooms yet» feedback instead of echoing stale
			// «planning intent» from input. Onboarding service bulk-creates
			// rooms AFTER this call returns, and the next read shows the
			// actual count.
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
				inventoryCount: 0,
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
			// Returns derived inventoryCount (same contract as getById /
			// listByProperty per 2026-05-16 canon) — operator-facing
			// response shape stays consistent across read paths.
			return sql.begin({ idempotent: true }, async (tx) => {
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
				// Derive inventoryCount from current rooms — same canon as
				// listByProperty / getById. Counts ACTIVE rooms только.
				const [countRows = []] = await tx<{ cnt: number | bigint }[]>`
					SELECT COUNT(*) AS cnt FROM room
					WHERE tenantId = ${tenantId} AND roomTypeId = ${id} AND isActive = ${true}
				`
				const derivedCount = Number(countRows[0]?.cnt ?? 0)
				return { ...merged, inventoryCount: derivedCount }
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
