/**
 * Inventory pool repo — M10 / A7.1.fix (D11.b).
 *
 * Atomic ARI updates with overbooking detection. Wraps `lib/channel-manager/
 * inventory-pool.ts` pure functions с YDB Serializable transactions.
 *
 * Schema reuses existing `availability` table (M5 migration 0001:272). PK is
 * `(tenantId, propertyId, roomTypeId, date)` — rate plan lives separately in
 * `rate` table. Effective availability = `allotment - sold`. Reserve increments
 * `sold` atomically; release decrements.
 *
 * Why Serializable (NOT just snapshot):
 *   - Walk-in × OTA collision: two concurrent decrement attempts на one
 *     (date, roomType) cell MUST serialize. YDB Serializable rejects
 *     both-saw-stale-balance with PRECONDITION_FAILED — caller retries.
 *   - YDB has no `SELECT FOR UPDATE`; Serializable isolation в `sql.begin`
 *     is the canonical replacement (lock-free OCC, retry on conflict).
 */

import type { sql as SQL } from '../../db/index.ts'
import { dateFromIso } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

export interface InventoryReserveInput {
	readonly tenantId: string
	readonly propertyId: string
	readonly roomTypeId: string
	readonly date: string // YYYY-MM-DD
	readonly count: number
	readonly source: 'channel' | 'walk-in' | 'pms'
	/** Channel id когда source==='channel'; for telemetry only. */
	readonly channelId?: string
}

export type InventoryReserveResult =
	| { readonly ok: true; readonly remaining: number }
	| {
			readonly ok: false
			readonly reason: 'oversold' | 'cell_missing' | 'stop_sell'
			readonly available: number
			readonly attempted: number
	  }

type AvailabilityRow = {
	allotment: number | bigint
	sold: number | bigint
	stopSell: boolean
}

function toNum(n: number | bigint): number {
	return typeof n === 'bigint' ? Number(n) : n
}

export function createInventoryPoolRepo(sql: SqlInstance) {
	return {
		/**
		 * Atomic reserve: SELECT current cell, validate (allotment - sold) ≥ count
		 * AND not stopSell, UPDATE sold += count — все в одной Serializable tx.
		 * Concurrent attempts либо succeed in serialization order либо receive
		 * PRECONDITION_FAILED (caller retries via @ydbjs/query idempotent retry).
		 */
		async reserve(input: InventoryReserveInput): Promise<InventoryReserveResult> {
			const dateBind = dateFromIso(input.date)
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<AvailabilityRow[]>`
					SELECT allotment, sold, stopSell
					FROM availability
					WHERE tenantId = ${input.tenantId}
					  AND propertyId = ${input.propertyId}
					  AND roomTypeId = ${input.roomTypeId}
					  AND date = ${dateBind}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) {
					return {
						ok: false,
						reason: 'cell_missing',
						available: 0,
						attempted: input.count,
					} as InventoryReserveResult
				}
				if (row.stopSell) {
					return {
						ok: false,
						reason: 'stop_sell',
						available: toNum(row.allotment) - toNum(row.sold),
						attempted: input.count,
					} as InventoryReserveResult
				}
				const allotment = toNum(row.allotment)
				const sold = toNum(row.sold)
				const available = allotment - sold
				if (available < input.count) {
					return {
						ok: false,
						reason: 'oversold',
						available,
						attempted: input.count,
					} as InventoryReserveResult
				}
				const newSold = sold + input.count
				await tx`
					UPDATE availability
					SET sold = ${newSold}, updatedAt = CurrentUtcTimestamp()
					WHERE tenantId = ${input.tenantId}
					  AND propertyId = ${input.propertyId}
					  AND roomTypeId = ${input.roomTypeId}
					  AND date = ${dateBind}
				`
				return { ok: true, remaining: allotment - newSold } as InventoryReserveResult
			})
		},

		/**
		 * Release count (cancellation flow). Symmetric to reserve. Always succeeds
		 * (no upper-bound validation — over-release surfaces as bug downstream).
		 */
		async release(input: {
			readonly tenantId: string
			readonly propertyId: string
			readonly roomTypeId: string
			readonly date: string
			readonly count: number
		}): Promise<{ readonly newAvailable: number }> {
			const dateBind = dateFromIso(input.date)
			return sql.begin(async (tx) => {
				const [rows = []] = await tx<AvailabilityRow[]>`
					SELECT allotment, sold, stopSell
					FROM availability
					WHERE tenantId = ${input.tenantId}
					  AND propertyId = ${input.propertyId}
					  AND roomTypeId = ${input.roomTypeId}
					  AND date = ${dateBind}
					LIMIT 1
				`
				const row = rows[0]
				if (!row) throw new Error(`inventory cell missing: ${input.tenantId} ${input.date}`)
				const allotment = toNum(row.allotment)
				const sold = Math.max(0, toNum(row.sold) - input.count)
				await tx`
					UPDATE availability
					SET sold = ${sold}, updatedAt = CurrentUtcTimestamp()
					WHERE tenantId = ${input.tenantId}
					  AND propertyId = ${input.propertyId}
					  AND roomTypeId = ${input.roomTypeId}
					  AND date = ${dateBind}
				`
				return { newAvailable: allotment - sold }
			})
		},

		async peek(input: {
			readonly tenantId: string
			readonly propertyId: string
			readonly roomTypeId: string
			readonly date: string
		}): Promise<{ readonly available: number; readonly stopSell: boolean } | null> {
			const dateBind = dateFromIso(input.date)
			const [rows = []] = await sql<AvailabilityRow[]>`
				SELECT allotment, sold, stopSell
				FROM availability
				WHERE tenantId = ${input.tenantId}
				  AND propertyId = ${input.propertyId}
				  AND roomTypeId = ${input.roomTypeId}
				  AND date = ${dateBind}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (!row) return null
			return {
				available: toNum(row.allotment) - toNum(row.sold),
				stopSell: row.stopSell,
			}
		},
	}
}
