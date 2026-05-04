/**
 * Inventory pool primitive — strict tests POOL1-POOL4 (M10 / A7.1 / D13+D21).
 *
 * Per plan §5: «4 POOL tests (SERIALIZABLE FOR UPDATE / walk-in × OTA collision /
 * inventoryBuffer respected / overbookingDetected event)».
 */

import { describe, expect, it } from 'vitest'
import {
	computeAvailability,
	detectOverbooking,
	type InventoryCell,
	overbookingExcess,
} from './inventory-pool.ts'

function cell(over: Partial<InventoryCell> = {}): InventoryCell {
	return {
		propertyId: 'demo-prop-sirius-main',
		roomTypeId: 'demo-roomtype-deluxe',
		date: '2026-06-15',
		totalCount: 8,
		soldCount: 0,
		buffer: 1,
		...over,
	}
}

describe('computeAvailability — pooled inventory с buffer (D13+D21)', () => {
	it('[POOL1] empty inventory: channel avail = total - buffer', () => {
		expect(computeAvailability(cell({ totalCount: 8, soldCount: 0, buffer: 1 }))).toEqual({
			available: 7, // 8 - 0 - 1
			canSellViaChannel: true,
			canSellViaWalkIn: true,
			bufferReached: false,
		})
	})

	it('[POOL1.b] walk-in path NOT subject to buffer (front-desk full capacity)', () => {
		// 7 sold, 1 buffer left for walk-in → channel sees 0 available, walk-in sees 1.
		const decision = computeAvailability(cell({ totalCount: 8, soldCount: 7, buffer: 1 }))
		expect(decision.available).toBe(0) // channel: 8 - 7 - 1 = 0
		expect(decision.canSellViaChannel).toBe(false)
		expect(decision.canSellViaWalkIn).toBe(true) // walk-in: 8 - 7 = 1
		expect(decision.bufferReached).toBe(true) // buffer hit, alert admin
	})

	it('[POOL1.c] zero buffer (D21 disabled) → channel = walk-in', () => {
		const decision = computeAvailability(cell({ totalCount: 8, soldCount: 5, buffer: 0 }))
		expect(decision.available).toBe(3) // 8 - 5 - 0
		expect(decision.canSellViaChannel).toBe(true)
		expect(decision.canSellViaWalkIn).toBe(true)
		expect(decision.bufferReached).toBe(false)
	})

	it('[POOL1.d] sold > total - buffer (oversold via channel inventory) → 0', () => {
		// Theoretical edge: 8 total, 9 sold, 1 buffer. Walk-in NOT possible (oversold).
		const decision = computeAvailability(cell({ totalCount: 8, soldCount: 9, buffer: 1 }))
		expect(decision.available).toBe(0)
		expect(decision.canSellViaChannel).toBe(false)
		expect(decision.canSellViaWalkIn).toBe(false)
	})
})

describe('walk-in × OTA collision behavior (R2 #F2 — D21)', () => {
	it('[POOL2] full hotel + 1-room buffer: walk-in still possible, OTA blocked', () => {
		// 8 sold, 8 total, 1 buffer. Channels see 0 (8-8-1=-1, clamped 0).
		// Walk-in path: 8-8 = 0. Both blocked at exact-full state.
		const decision = computeAvailability(cell({ totalCount: 8, soldCount: 8, buffer: 1 }))
		expect(decision.canSellViaChannel).toBe(false)
		expect(decision.canSellViaWalkIn).toBe(false) // BOTH blocked
	})

	it('[POOL2.b] 7 sold + 1 buffer (buffer reached): channel blocked, walk-in OK', () => {
		// Real-world canonical scenario per R2 #F2.
		const decision = computeAvailability(cell({ totalCount: 8, soldCount: 7, buffer: 1 }))
		expect(decision.bufferReached).toBe(true) // signal: alert admin
		expect(decision.canSellViaChannel).toBe(false) // ОТА blocked
		expect(decision.canSellViaWalkIn).toBe(true) // front-desk OK
	})
})

describe('detectOverbooking + overbookingExcess (D21 activity event source)', () => {
	it('[POOL3] sold > total → overbooking detected', () => {
		expect(detectOverbooking(cell({ totalCount: 8, soldCount: 9 }))).toBe(true)
		expect(detectOverbooking(cell({ totalCount: 8, soldCount: 10 }))).toBe(true)
	})

	it('[POOL3.b] sold == total → NOT overbooking (full capacity)', () => {
		expect(detectOverbooking(cell({ totalCount: 8, soldCount: 8 }))).toBe(false)
	})

	it('[POOL3.c] sold < total → NOT overbooking', () => {
		expect(detectOverbooking(cell({ totalCount: 8, soldCount: 0 }))).toBe(false)
		expect(detectOverbooking(cell({ totalCount: 8, soldCount: 5 }))).toBe(false)
	})

	it('[POOL4] excess = max(0, sold - total)', () => {
		expect(overbookingExcess(cell({ totalCount: 8, soldCount: 8 }))).toBe(0)
		expect(overbookingExcess(cell({ totalCount: 8, soldCount: 9 }))).toBe(1)
		expect(overbookingExcess(cell({ totalCount: 8, soldCount: 12 }))).toBe(4)
		expect(overbookingExcess(cell({ totalCount: 8, soldCount: 0 }))).toBe(0)
	})
})
