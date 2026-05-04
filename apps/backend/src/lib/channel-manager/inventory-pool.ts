/**
 * Inventory pool primitive — M10 / A7.1 / D13 + D21.
 *
 * Per `plans/m10_canonical.md` §2:
 *   - D13: POOLED inventory (Apaleo-style); single `inventory(propertyId,
 *          unitGroupId, date)` row, all rate plans derive
 *   - D21: `inventoryBuffer` field per ratePlan (default 1 room held back from
 *          OTAs) + `overbookingDetected` activity event + manual relocation SOP
 *
 * Pure functions для inventory math. DB I/O happens в repo layer (existing
 * `availability.repo.ts` + new `inventory-buffer.repo.ts` в A7.5).
 *
 * Walk-in × OTA collision (R2 #F2 from R-rounds): real hotels use buffer +
 * manual SOP, NOT «100% sync magic». Mock реализация surfaces this honestly.
 */

export interface InventoryCell {
	readonly propertyId: string
	readonly roomTypeId: string
	readonly date: string // YYYY-MM-DD
	readonly totalCount: number // total physical rooms
	readonly soldCount: number // counted bookings (across all rate plans + channels + walk-ins)
	readonly buffer: number // rooms held back from OTAs (D21 default 1)
}

export interface InventoryDecision {
	readonly available: number
	readonly canSellViaChannel: boolean
	readonly canSellViaWalkIn: boolean
	readonly bufferReached: boolean
}

/**
 * Compute selling capacity per channel with buffer applied.
 *
 * Channels see `(total - sold - buffer)` — buffer protects against
 * walk-in × OTA collision. Walk-ins (front-desk) see `(total - sold)` — full
 * capacity.
 *
 * **Buffer reaches zero** → `bufferReached: true` → admin alert recommended.
 */
export function computeAvailability(cell: InventoryCell): InventoryDecision {
	const channelAvail = Math.max(0, cell.totalCount - cell.soldCount - cell.buffer)
	const walkInAvail = Math.max(0, cell.totalCount - cell.soldCount)
	return {
		available: channelAvail,
		canSellViaChannel: channelAvail > 0,
		canSellViaWalkIn: walkInAvail > 0,
		bufferReached: channelAvail === 0 && walkInAvail > 0,
	}
}

/**
 * Detect overbooking. Returns true if soldCount exceeds totalCount —
 * indicates: (a) walk-in + OTA collision; (b) manual override; (c) data race.
 *
 * Caller emits `overbookingDetected` activity event (D21) + admin alert.
 */
export function detectOverbooking(cell: InventoryCell): boolean {
	return cell.soldCount > cell.totalCount
}

/**
 * Compute overbooking magnitude — how many rooms in excess.
 * Returns 0 если no overbooking.
 */
export function overbookingExcess(cell: InventoryCell): number {
	return Math.max(0, cell.soldCount - cell.totalCount)
}
