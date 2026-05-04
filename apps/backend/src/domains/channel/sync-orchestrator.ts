/**
 * Bidirectional sync orchestrator — M10 / A7.5.
 *
 * Coordinates ARI broadcast + booking events across enabled channels per tenant.
 * Enforces RU compliance gates (D16-D20) BEFORE any outbound dispatch.
 *
 * Per `plans/m10_canonical.md`:
 *   - D16: Sanctions HARD-DISABLE — Booking.com / Expedia / Airbnb factory-level
 *          (May 2026). Adapters refuse registration entirely; orchestrator
 *          double-checks при resolve.
 *   - D17: Granular consent — guest-side, NOT orchestrator (enforced в widget
 *          A2 + adapter receiveBookingWebhook).
 *   - D18: Operator/processor split — `channel.role` field. Foreign recipient
 *          requires cross-border notification.
 *   - D19: Cross-border-transfer gate — deny outbound PII to non-RU recipient
 *          unless `crossBorderNotification.{country, status:filed}` exists.
 *   - D20: МВД миграционный учёт — ALWAYS hotel-side. Orchestrator MUST NOT
 *          delegate миграционный учёт к channel adapter (separate domain).
 *
 * Architecture:
 *   - Caller (CDC consumer) emits ARI delta or booking event.
 *   - Orchestrator looks up `channelConnection` rows для tenant.
 *   - For each enabled connection: gate checks → enqueue dispatch.
 *   - Disabled / sanctioned / DPA-missing → skip with audit reason.
 *
 * Pure function helpers (no DB) для testability; full orchestration via
 * `orchestrateAriBroadcast` consumes repos.
 */

import type { ChannelConnection, createChannelConnectionRepo } from './connection.repo.ts'
import type { createChannelDispatchRepo } from './dispatch.repo.ts'

export type SyncSkipReason =
	| 'disabled'
	| 'sanctioned_channel'
	| 'dpa_required_but_missing'
	| 'cross_border_notification_missing'
	| 'cross_border_notification_denied'
	| 'auto_disabled'
	| 'mode_mismatch'

export interface SyncGateResult {
	readonly channelId: string
	readonly tenantId: string
	readonly propertyId: string
	readonly allowed: boolean
	readonly skipReason?: SyncSkipReason
}

/**
 * Sanctioned channel IDs HARD-DISABLED at orchestrator level (D16).
 *
 * Re-enable trigger: sanctions lift + RKN re-notify + manual code change.
 * Refused at orchestrator AND factory level (defense-in-depth).
 */
export const SANCTIONED_CHANNEL_IDS: ReadonlySet<string> = new Set([
	'BCOM', // Booking.com
	'EXP', // Expedia
	'ABN', // Airbnb
])

/**
 * Pure gate evaluator — given a channel connection + RU compliance state,
 * decide whether outbound dispatch is allowed.
 *
 * Tested directly via 8 SYNC tests; orchestrator delegates here.
 */
export function evaluateSyncGate(input: {
	readonly connection: ChannelConnection
	readonly crossBorderStatus?: 'filed' | 'pending' | 'denied' | null
	readonly currentMode?: 'mock' | 'sandbox' | 'live'
}): SyncGateResult {
	const { connection } = input
	const base = {
		channelId: connection.channelId,
		tenantId: connection.tenantId,
		propertyId: connection.propertyId,
	}

	// D16 sanctions HARD-DISABLE.
	if (SANCTIONED_CHANNEL_IDS.has(connection.channelId)) {
		return { ...base, allowed: false, skipReason: 'sanctioned_channel' }
	}

	// Connection-level disabled.
	if (!connection.isEnabled) {
		return { ...base, allowed: false, skipReason: 'disabled' }
	}

	// Auto-disabled circuit breaker (D14).
	if (connection.syncStatus === 'auto_disabled') {
		return { ...base, allowed: false, skipReason: 'auto_disabled' }
	}

	// D18: processor_with_dpa requires DPA signed.
	if (connection.role === 'processor_with_dpa' && connection.dpaSignedAt === null) {
		return { ...base, allowed: false, skipReason: 'dpa_required_but_missing' }
	}

	// D19: cross-border-transfer gate.
	if (connection.role === 'foreign_recipient') {
		const status = input.crossBorderStatus ?? connection.crossBorderNotificationStatus
		if (status === 'denied') {
			return { ...base, allowed: false, skipReason: 'cross_border_notification_denied' }
		}
		if (status !== 'filed') {
			return { ...base, allowed: false, skipReason: 'cross_border_notification_missing' }
		}
	}

	// Mode safety: production tenant с mock-mode connection — caller decides.
	if (input.currentMode !== undefined && input.currentMode !== connection.mode) {
		return { ...base, allowed: false, skipReason: 'mode_mismatch' }
	}

	return { ...base, allowed: true }
}

/**
 * Inventory pool overbooking detector. Pure helper for SYNC test.
 *
 * Pooled inventory canon (D13): all rate plans on a (property, roomType, date)
 * cell share availability. Sum of bookings across channels MUST NOT exceed
 * `allotment - inventoryBuffer`.
 */
export function detectPooledOverbooking(input: {
	readonly allotment: number
	readonly inventoryBuffer: number
	readonly bookingsByChannel: ReadonlyArray<{ readonly channelId: string; readonly count: number }>
}): {
	readonly overbooked: boolean
	readonly excess: number
	readonly effectiveCapacity: number
	readonly totalBookings: number
} {
	const total = input.bookingsByChannel.reduce((sum, b) => sum + b.count, 0)
	const effective = Math.max(0, input.allotment - input.inventoryBuffer)
	const excess = Math.max(0, total - effective)
	return {
		overbooked: excess > 0,
		excess,
		effectiveCapacity: effective,
		totalBookings: total,
	}
}

/**
 * Orchestrate ARI broadcast across enabled channels. Single-flight per
 * (tenant, property): caller enqueues into channelDispatch table per allowed
 * channel. Disabled / sanctioned / DPA-missing channels skipped with audit
 * reason returned in the report.
 */
export interface OrchestrationReport {
	readonly enqueued: ReadonlyArray<{ readonly channelId: string; readonly dispatchId: string }>
	readonly skipped: ReadonlyArray<{ readonly channelId: string; readonly reason: SyncSkipReason }>
}

export interface OrchestrationDeps {
	readonly connectionRepo: ReturnType<typeof createChannelConnectionRepo>
	readonly dispatchRepo: ReturnType<typeof createChannelDispatchRepo>
}

export async function orchestrateAriBroadcast(
	deps: OrchestrationDeps,
	input: {
		readonly tenantId: string
		readonly propertyId: string
		readonly eventSource: string
		readonly eventId: string
		readonly eventType: string
		readonly idempotencyKeyBase: string
		readonly payload: unknown
	},
): Promise<OrchestrationReport> {
	const all = await deps.connectionRepo.listByTenant(input.tenantId)
	const forProperty = all.filter((c) => c.propertyId === input.propertyId)
	const enqueued: Array<{ channelId: string; dispatchId: string }> = []
	const skipped: Array<{ channelId: string; reason: SyncSkipReason }> = []

	for (const connection of forProperty) {
		const gate = evaluateSyncGate({ connection })
		if (!gate.allowed) {
			if (gate.skipReason !== undefined) {
				skipped.push({ channelId: connection.channelId, reason: gate.skipReason })
			}
			continue
		}
		const result = await deps.dispatchRepo.enqueue({
			tenantId: input.tenantId,
			channelId: connection.channelId,
			eventSource: input.eventSource,
			eventId: input.eventId,
			eventType: input.eventType,
			idempotencyKey: `${input.idempotencyKeyBase}:${connection.channelId}`,
			payload: input.payload,
		})
		enqueued.push({ channelId: connection.channelId, dispatchId: result.dispatchId })
	}

	return { enqueued, skipped }
}
