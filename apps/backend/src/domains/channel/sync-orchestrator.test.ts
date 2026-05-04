/**
 * Sync orchestrator — strict tests SYNC1-SYNC9 (M10 / A7.5 / D16-D20).
 *
 * Pure-function tests of evaluateSyncGate + detectPooledOverbooking.
 * Verifies RU compliance gates per plan §2 D16-D20:
 *   - Sanctions HARD-DISABLE (Booking.com / Expedia / Airbnb)
 *   - DPA-required check before activation (processor_with_dpa role)
 *   - Cross-border-transfer gate (foreign_recipient + filed status)
 *   - Disabled / auto-disabled circuit breaker
 *   - Pooled inventory overbooking detection с inventoryBuffer
 */

import { describe, expect, it } from 'vitest'
import type { ChannelConnection } from './connection.repo.ts'
import {
	detectPooledOverbooking,
	evaluateSyncGate,
	SANCTIONED_CHANNEL_IDS,
} from './sync-orchestrator.ts'

function buildConnection(overrides: Partial<ChannelConnection> = {}): ChannelConnection {
	return {
		tenantId: 'org_a',
		propertyId: 'prop_main',
		channelId: 'TL',
		mode: 'mock',
		role: 'processor_with_dpa',
		credentialsLockboxRef: null,
		dpaSignedAt: '2026-05-01T00:00:00.000Z',
		rknOperatorId: null,
		crossBorderNotificationStatus: null,
		syncStatus: 'idle',
		lastSyncAt: null,
		autoDisabledReason: null,
		autoDisabledAt: null,
		isEnabled: true,
		createdAt: '2026-05-01T00:00:00.000Z',
		updatedAt: '2026-05-01T00:00:00.000Z',
		...overrides,
	}
}

describe('Sync gate — D16 sanctions HARD-DISABLE (SYNC1-SYNC2)', () => {
	it('[SYNC1] Booking.com / Expedia / Airbnb HARD-DISABLED at orchestrator level', () => {
		expect(SANCTIONED_CHANNEL_IDS.has('BCOM')).toBe(true)
		expect(SANCTIONED_CHANNEL_IDS.has('EXP')).toBe(true)
		expect(SANCTIONED_CHANNEL_IDS.has('ABN')).toBe(true)
		// TL/YT/ETG NOT sanctioned.
		expect(SANCTIONED_CHANNEL_IDS.has('TL')).toBe(false)
		expect(SANCTIONED_CHANNEL_IDS.has('YT')).toBe(false)
		expect(SANCTIONED_CHANNEL_IDS.has('ETG')).toBe(false)
	})

	it('[SYNC2] evaluateSyncGate refuses sanctioned channel even с DPA + filed cross-border', () => {
		const result = evaluateSyncGate({
			connection: buildConnection({
				channelId: 'BCOM',
				role: 'foreign_recipient',
				crossBorderNotificationStatus: 'filed',
			}),
		})
		expect(result.allowed).toBe(false)
		expect(result.skipReason).toBe('sanctioned_channel')
	})
})

describe('Sync gate — D18 DPA + role checks (SYNC3-SYNC4)', () => {
	it('[SYNC3] processor_with_dpa без dpaSignedAt → dpa_required_but_missing', () => {
		const result = evaluateSyncGate({
			connection: buildConnection({
				role: 'processor_with_dpa',
				dpaSignedAt: null,
			}),
		})
		expect(result.allowed).toBe(false)
		expect(result.skipReason).toBe('dpa_required_but_missing')
	})

	it('[SYNC4] independent_operator не требует DPA → allowed', () => {
		const result = evaluateSyncGate({
			connection: buildConnection({
				channelId: 'YT',
				role: 'independent_operator',
				dpaSignedAt: null,
			}),
		})
		expect(result.allowed).toBe(true)
	})
})

describe('Sync gate — D19 cross-border-transfer gate (SYNC5-SYNC6)', () => {
	it('[SYNC5] foreign_recipient без cross-border-notification → cross_border_notification_missing', () => {
		const result = evaluateSyncGate({
			connection: buildConnection({
				channelId: 'CUSTOM_FOREIGN',
				role: 'foreign_recipient',
				crossBorderNotificationStatus: null,
			}),
		})
		expect(result.allowed).toBe(false)
		expect(result.skipReason).toBe('cross_border_notification_missing')
	})

	it('[SYNC6] foreign_recipient с status=denied → cross_border_notification_denied', () => {
		const result = evaluateSyncGate({
			connection: buildConnection({
				channelId: 'CUSTOM_FOREIGN',
				role: 'foreign_recipient',
				crossBorderNotificationStatus: 'denied',
			}),
		})
		expect(result.allowed).toBe(false)
		expect(result.skipReason).toBe('cross_border_notification_denied')
	})

	it('[SYNC6.b] foreign_recipient с status=filed → allowed', () => {
		const result = evaluateSyncGate({
			connection: buildConnection({
				channelId: 'CUSTOM_FOREIGN',
				role: 'foreign_recipient',
				crossBorderNotificationStatus: 'filed',
			}),
		})
		expect(result.allowed).toBe(true)
	})
})

describe('Sync gate — disabled / auto-disabled (SYNC7-SYNC8)', () => {
	it('[SYNC7] connection.isEnabled=false → disabled', () => {
		const result = evaluateSyncGate({
			connection: buildConnection({ isEnabled: false }),
		})
		expect(result.allowed).toBe(false)
		expect(result.skipReason).toBe('disabled')
	})

	it('[SYNC8] auto-disabled circuit breaker → auto_disabled', () => {
		const result = evaluateSyncGate({
			connection: buildConnection({ syncStatus: 'auto_disabled' }),
		})
		expect(result.allowed).toBe(false)
		expect(result.skipReason).toBe('auto_disabled')
	})
})

describe('Pooled inventory overbooking detection (SYNC9)', () => {
	it('[SYNC9] sum bookings > allotment - inventoryBuffer → overbooked с excess', () => {
		const result = detectPooledOverbooking({
			allotment: 10,
			inventoryBuffer: 2,
			bookingsByChannel: [
				{ channelId: 'TL', count: 5 },
				{ channelId: 'YT', count: 3 },
				{ channelId: 'ETG', count: 2 }, // total 10, effective capacity 8
			],
		})
		expect(result.overbooked).toBe(true)
		expect(result.excess).toBe(2)
		expect(result.effectiveCapacity).toBe(8)
		expect(result.totalBookings).toBe(10)
	})

	it('[SYNC9.b] sum bookings ≤ effective capacity → not overbooked', () => {
		const result = detectPooledOverbooking({
			allotment: 10,
			inventoryBuffer: 2,
			bookingsByChannel: [
				{ channelId: 'TL', count: 5 },
				{ channelId: 'YT', count: 2 }, // total 7, capacity 8
			],
		})
		expect(result.overbooked).toBe(false)
		expect(result.excess).toBe(0)
	})

	it('[SYNC9.c] inventoryBuffer 0 — full allotment usable', () => {
		const result = detectPooledOverbooking({
			allotment: 10,
			inventoryBuffer: 0,
			bookingsByChannel: [{ channelId: 'TL', count: 10 }],
		})
		expect(result.effectiveCapacity).toBe(10)
		expect(result.overbooked).toBe(false)
	})
})
