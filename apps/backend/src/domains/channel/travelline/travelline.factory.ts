/**
 * TravelLine factory — M10 / A7.2.
 *
 * Wires per-tenant TL Mock adapter + HTTP attempt handler into channelFactory.
 *
 * **Usage in app.ts**:
 *   ```ts
 *   registerTravellineWithChannelFactory(channelFactory)
 *   ```
 *
 * Factory closure captures tenantId + propertyId at adapter resolution time.
 * Per `feedback_behaviour_faithful_mock_canon.md`: live-flip = swap factory body
 * to instantiate live TL HTTP client (with same `ChannelManagerAdapter` interface),
 * ZERO domain code changes.
 */

import { logger } from '../../../logger.ts'
import type { HttpAttemptResult } from '../../../workers/channel-dispatcher.ts'
import type { ChannelFactory } from '../channel.factory.ts'
import {
	createTravellineMock,
	TravellineApiError,
	TravellineRateLimitError,
} from './travelline-mock.ts'

export interface TravellineRegistrationOptions {
	/** Demo property fallback when tenant has no per-tenant config (Always-on demo). */
	readonly demoPropertyId?: string
}

/**
 * Register TravelLine adapter + HTTP attempt routing с channelFactory.
 *
 * Adapter is per-(organizationId, propertyId) singleton via channelFactory's
 * LRU cache (from A7.1.fix). HTTP attempt handler routes outbound dispatch
 * к the resolved adapter's method based on `eventType`.
 */
export function registerTravellineWithChannelFactory(
	channelFactory: ChannelFactory,
	opts: TravellineRegistrationOptions = {},
): void {
	const demoPropertyId = opts.demoPropertyId ?? 'demo-prop-sirius-main'

	channelFactory.registerAdapterFactory('TL', async ({ organizationId }) => {
		// In Mock mode, propertyId is per-tenant config; for demo tenant default fallback.
		// Live-flip: read TL credentials via channelFactory.secretRepo + Lockbox.
		return createTravellineMock({
			tenantId: organizationId,
			propertyId: demoPropertyId,
			seedAvailability: buildDemoAvailability(),
		})
	})

	channelFactory.registerHttpAttempt(
		'TL',
		async ({ tenantId, eventType, idempotencyKey, payload }) => {
			try {
				const adapter = await channelFactory.resolveAdapter({
					organizationId: tenantId,
					channelId: 'TL',
				})
				// Route per eventType — pure pass-through to canonical adapter methods.
				// CDC fan-out emits these; dispatcher delivers in tiered retry budget.
				switch (eventType) {
					case 'app.sochi.channel.booking.created.v1': {
						// PMS-side push of new booking → TL via two-step verify→create.
						// Payload is the canonical booking snapshot; live impl maps к TL API.
						// Mock: success no-op (TL is source-of-truth, not destination для PMS bookings).
						void adapter
						void idempotencyKey
						void payload
						return { ok: true, httpStatus: 200 }
					}
					case 'app.sochi.channel.booking.cancelled.v1': {
						// Cancellation broadcast.
						void adapter
						return { ok: true, httpStatus: 200 }
					}
					case 'app.sochi.channel.ari.delta.v1': {
						// ARI push (D1: TL is source-of-truth, no-op success).
						void adapter
						return { ok: true, httpStatus: 200 }
					}
					default: {
						// Unknown eventType for this channel — DLQ-immediate (4xx).
						return {
							ok: false,
							httpStatus: 400,
							errorMessage: `unknown_event_type: ${eventType}`,
						}
					}
				}
			} catch (err) {
				if (err instanceof TravellineRateLimitError) {
					return {
						ok: false,
						httpStatus: 429,
						errorMessage: `rate_limited; retry-after=${err.retryAfterSeconds}s`,
					}
				}
				if (err instanceof TravellineApiError) {
					return { ok: false, httpStatus: err.httpStatus, errorMessage: err.message }
				}
				logger.error({ err, tenantId, eventType }, 'TravelLine HTTP attempt unexpected error')
				return {
					ok: false,
					httpStatus: null,
					errorMessage: err instanceof Error ? err.message : 'unknown_error',
				} satisfies HttpAttemptResult
			}
		},
	)
}

function buildDemoAvailability() {
	const result: Array<{
		readonly roomTypeId: string
		readonly ratePlanId: string
		readonly date: string
		readonly availability: number
		readonly rateMicros: bigint
	}> = []
	const startMs = Date.now()
	for (let i = 0; i < 60; i++) {
		const dateMs = startMs + i * 24 * 60 * 60 * 1000
		const date = new Date(dateMs).toISOString().slice(0, 10)
		result.push({
			roomTypeId: 'tl_rt_deluxe',
			ratePlanId: 'tl_rp_bar_flex',
			date,
			availability: 5,
			rateMicros: 5_000_000n,
		})
	}
	return result
}
