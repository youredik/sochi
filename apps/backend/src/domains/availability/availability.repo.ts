import type { Availability, AvailabilityBulkUpsertInput } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { dateFromIso, NULL_INT32, toNumber, toTs, tsFromIso } from '../../db/ydb-helpers.ts'
import { NoInventoryError } from '../../errors/domain.ts'

type SqlInstance = typeof SQL

type AvailabilityRow = {
	tenantId: string
	propertyId: string
	roomTypeId: string
	date: Date
	allotment: number | bigint
	sold: number | bigint
	oversellDelta: number | bigint | null
	minStay: number | bigint | null
	maxStay: number | bigint | null
	closedToArrival: boolean
	closedToDeparture: boolean
	stopSell: boolean
	createdAt: Date
	updatedAt: Date
}

function rowToAvailability(r: AvailabilityRow): Availability {
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		roomTypeId: r.roomTypeId,
		date: r.date.toISOString().slice(0, 10),
		allotment: Number(r.allotment),
		sold: Number(r.sold),
		oversellDelta: r.oversellDelta === null ? 0 : Number(r.oversellDelta),
		minStay: toNumber(r.minStay),
		maxStay: toNumber(r.maxStay),
		closedToArrival: r.closedToArrival,
		closedToDeparture: r.closedToDeparture,
		stopSell: r.stopSell,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

/**
 * Availability repository. PK is compound
 * `(tenantId, propertyId, roomTypeId, date)` — one row per roomType per day.
 *
 * Critical invariant: this repo does NOT touch `sold`. That column is
 * advanced/released exclusively by the booking service under its own tx
 * (Phase 2 M4). Exposing `sold` mutation here would let the availability
 * API silently contradict the booking ledger.
 *
 * `bulkUpsert` preserves `sold` and `createdAt` on overwrite — the revenue
 * manager can set allotment/restrictions without blowing away the booking
 * count or audit trail.
 */
export function createAvailabilityRepo(sql: SqlInstance) {
	return {
		async listRange(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			range: { from: string; to: string },
		): Promise<Availability[]> {
			const [rows = []] = await sql<AvailabilityRow[]>`
				SELECT * FROM availability
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND roomTypeId = ${roomTypeId}
					AND date >= ${dateFromIso(range.from)}
					AND date <= ${dateFromIso(range.to)}
				ORDER BY date ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToAvailability)
		},

		async getOne(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			date: string,
		): Promise<Availability | null> {
			const [rows = []] = await sql<AvailabilityRow[]>`
				SELECT * FROM availability
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND roomTypeId = ${roomTypeId}
					AND date = ${dateFromIso(date)}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToAvailability(row) : null
		},

		async bulkUpsert(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			input: AvailabilityBulkUpsertInput,
		): Promise<Availability[]> {
			const now = new Date()
			const nowTs = toTs(now)

			try {
				await sql.begin({ idempotent: true }, async (tx) => {
					for (const r of input.rates) {
						// Preserve sold + createdAt on overwrite.
						const [existingRows = []] = await tx<
							{
								sold: number | bigint
								createdAt: Date
								oversellDelta: number | bigint | null
							}[]
						>`
							SELECT sold, createdAt, oversellDelta FROM availability
							WHERE tenantId = ${tenantId}
								AND propertyId = ${propertyId}
								AND roomTypeId = ${roomTypeId}
								AND date = ${dateFromIso(r.date)}
							LIMIT 1
						`
						const existing = existingRows[0]
						const sold = existing ? Number(existing.sold) : 0
						const createdAtTs = existing ? tsFromIso(existing.createdAt.toISOString()) : nowTs
						const minStay = r.minStay ?? NULL_INT32
						const maxStay = r.maxStay ?? NULL_INT32
						// Apaleo «Allowed Overbooking» canon: new delta inherits existing
						// value when omitted (operator setting allotment without touching
						// oversell preserves intent). Default 0 на first-create.
						const existingOversell =
							existing && existing.oversellDelta !== null ? Number(existing.oversellDelta) : 0
						const oversellDelta = r.oversellDelta ?? existingOversell

						// Gap C guard (2026-05-18): reject allotment+oversellDelta < sold.
						// YDB has no CHECK constraint, so invariant lives here. Without this
						// the operator can break the `sold <= effective allotment` invariant
						// silently — future creates fail с NoInventory, but existing rows
						// над лимитом stand. Closes Gap C from overbooking audit.
						const effective = r.allotment + oversellDelta
						if (effective < sold) {
							throw new NoInventoryError(
								`Cannot reduce capacity below sold: allotment+oversellDelta=${effective} < sold=${sold} for ${r.date}`,
							)
						}

						await tx`
							UPSERT INTO availability (
								\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`date\`,
								\`allotment\`, \`sold\`, \`oversellDelta\`, \`minStay\`, \`maxStay\`,
								\`closedToArrival\`, \`closedToDeparture\`, \`stopSell\`,
								\`createdAt\`, \`updatedAt\`
							) VALUES (
								${tenantId}, ${propertyId}, ${roomTypeId}, ${dateFromIso(r.date)},
								${r.allotment}, ${sold}, ${oversellDelta}, ${minStay}, ${maxStay},
								${r.closedToArrival ?? false},
								${r.closedToDeparture ?? false},
								${r.stopSell ?? false},
								${createdAtTs}, ${nowTs}
							)
						`
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof NoInventoryError) throw err.cause
				throw err
			}

			const sortedDates = input.rates.map((r) => r.date).sort()
			const from = sortedDates[0] ?? input.rates[0]?.date ?? ''
			const to = sortedDates[sortedDates.length - 1] ?? from
			return this.listRange(tenantId, propertyId, roomTypeId, { from, to })
		},

		async deleteOne(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			date: string,
		): Promise<boolean> {
			const existing = await this.getOne(tenantId, propertyId, roomTypeId, date)
			if (!existing) return false
			await sql`
				DELETE FROM availability
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND roomTypeId = ${roomTypeId}
					AND date = ${dateFromIso(date)}
			`
			return true
		},
	}
}

export type AvailabilityRepo = ReturnType<typeof createAvailabilityRepo>
