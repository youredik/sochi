/**
 * Channel broadcast CDC handler — M10 / A7.5.
 *
 * Projects booking-domain CDC events → orchestrated channel dispatch fan-out
 * via `orchestrateAriBroadcast`. Each booking INSERT triggers per-channel
 * dispatch INSERT (gates D16-D20 applied), idempotent via deterministic key.
 *
 * Per `feedback_no_halfway.md`: handler wired в app.ts as new CDC consumer
 * `channel_broadcast_writer` on `booking/booking_events` topic (migration 0059).
 */

import type { TX } from '@ydbjs/query'
import type { createChannelConnectionRepo } from '../../domains/channel/connection.repo.ts'
import type { createChannelDispatchRepo } from '../../domains/channel/dispatch.repo.ts'
import { orchestrateAriBroadcast } from '../../domains/channel/sync-orchestrator.ts'
import { buildEventType, buildSourceUrn } from '../../lib/channel-manager/cloud-events.ts'
import { logger } from '../../logger.ts'
import { cdcStr, type CdcEvent } from '../cdc-handlers.ts'

export interface ChannelBroadcastDeps {
	readonly connectionRepo: ReturnType<typeof createChannelConnectionRepo>
	readonly dispatchRepo: ReturnType<typeof createChannelDispatchRepo>
}

/**
 * Build CDC projection — booking INSERT → per-channel `channelDispatch` rows.
 * Skipped channels logged at INFO with audit reason. Cross-table fan-out OK
 * outside tx because at-least-once + deterministic idempotencyKey makes
 * redelivery safe (D14 + D14.b).
 */
export function createChannelBroadcastHandler(deps: ChannelBroadcastDeps) {
	return async (_tx: TX, event: CdcEvent): Promise<void> => {
		const isInsert = !event.oldImage && !!event.newImage
		if (!isInsert || !event.newImage) return // only fan-out new bookings

		const newImage = event.newImage
		const tenantId = cdcStr(newImage.tenantId)
		const propertyId = cdcStr(newImage.propertyId)
		const bookingId = cdcStr(newImage.id ?? event.key?.[3])
		if (!tenantId || !propertyId || !bookingId) return

		const cdcVersion = event.ts ? `${event.ts[0]}-${event.ts[1]}` : Date.now().toString()

		const report = await orchestrateAriBroadcast(
			{ connectionRepo: deps.connectionRepo, dispatchRepo: deps.dispatchRepo },
			{
				tenantId,
				propertyId,
				eventSource: buildSourceUrn({ channelCode: 'PMS', organizationId: tenantId }),
				eventId: bookingId,
				eventType: buildEventType({ entity: 'booking', action: 'created', version: 'v1' }),
				idempotencyKeyBase: `${tenantId}:${bookingId}:${cdcVersion}`,
				payload: newImage,
			},
		)
		if (report.skipped.length > 0) {
			logger.info(
				{ tenantId, bookingId, skipped: report.skipped },
				'channel broadcast: gates skipped channels',
			)
		}
		if (report.enqueued.length > 0) {
			logger.info(
				{ tenantId, bookingId, enqueued: report.enqueued },
				'channel broadcast: dispatch enqueued',
			)
		}
	}
}
