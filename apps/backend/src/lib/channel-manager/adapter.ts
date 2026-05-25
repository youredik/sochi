/**
 * `ChannelManagerAdapter` canonical interface — M10 / A7.1.
 *
 * Behaviour-faithful Mock canon: same interface для Mock + Sandbox + Live.
 * Live-flip = factory binding swap, ZERO domain code branches (per
 * `feedback_behaviour_faithful_mock_canon.md` + `project_demo_strategy.md`).
 *
 * Implementations:
 *   - `domains/channel/travelline/travelline-mock.ts` (A7.2 — TL polling-based)
 *   - `domains/channel/yandex-travel/yandex-travel-mock.ts` (A7.3 — CM-emulation)
 *   - `domains/channel/ostrovok-etg/ostrovok-etg-mock.ts` (A7.4 — 5-stage SM)
 *
 * Methods reflect 2026 canonical PMS↔CM operations (Apaleo + Cloudbeds + Mews):
 *   - `pushAri(delta)` — outbound: emit rate/availability/restriction delta
 *   - `pushAriFull(snapshot)` — outbound: full property state (resync after disable)
 *   - `searchAvailability(query)` — read availability (TL canon: PMS reads, не pushes)
 *   - `readReservations(cursor)` — polling-based reservation reception (TL)
 *   - `verifyAndCreateBooking(input)` — outbound: TL-style two-step verify→create
 *   - `cancelReservation(input)` — outbound cancellation
 *   - `calculateCancellationPenalty(input)` — pre-cancel penalty calc
 *   - `receiveBookingWebhook(payload)` — inbound webhook (YT/ETG push)
 */

import type { SochiCloudEvent } from './cloud-events.ts'

export type ChannelMode = 'mock' | 'sandbox' | 'live'

export type ChannelRole = 'processor_with_dpa' | 'independent_operator' | 'foreign_recipient'

export interface ChannelMetadata {
	readonly channelId: string // 'TL' | 'YT' | 'ETG' | ...
	readonly mode: ChannelMode
	readonly role: ChannelRole
	readonly displayName: string
}

/**
 * Canonical error categories returned from adapter operations.
 * Round 8 canon (per `feedback_round_8_strict_sweep_canon_2026_05_25.md`):
 * adapters MUST classify failures into one of these categories so callers
 * (dispatcher, MCP layer, ops alerts) can route correctly.
 */
export type ChannelErrorCategory =
	| 'rate_limited' // 429-style; retry with backoff
	| 'invalid_credentials' // 401/403; alert ops, no retry
	| 'cross_border_blocked' // 152-ФЗ ст.18 ч.5 photo residency / sanctions shield
	| 'consent_missing' // 152-ФЗ granular 3-checkbox gap
	| 'reserved_test_range' // outbound shield short-circuit (RFC 2606/6761 / ITU-T E.164.3)
	| 'duplicate_idempotency_key' // already-seen — idempotent ack
	| 'invalid_payload' // schema/validation failure
	| 'not_found' // entity does not exist
	| 'transient' // transient upstream error; retry
	| 'unknown' // catch-all; alert ops

export interface ChannelAdapterError {
	readonly category: ChannelErrorCategory
	readonly message: string
	/** Index of the failed item in the input array (для batch operations). */
	readonly itemIndex?: number
	/** Originating channel's error code/key для debugging (NOT logged раw — sanitized). */
	readonly upstreamCode?: string
}

/**
 * Outbound ARI delta (push from PMS). Channels that pull-not-push (TravelLine)
 * may treat this as a no-op + return success synchronously.
 *
 * `sequenceNumber` (Round 8 canon): per-resource monotonic ordering signal —
 * каждое изменение для конкретной комбинации (tenant, property, roomType,
 * ratePlan, date) получает strictly-increasing sequence из nextSequenceNumber()
 * generator (typically `bigint` epoch-microseconds or DB-generated). Consumers
 * use it to detect gaps + drop out-of-order updates. Naш architectural leapfrog
 * vs Apaleo/Mews/Cloudbeds/Hostaway (memory canon
 * `project_2026_grade_architecture_canon_2026_05_25.md`).
 */
export interface AriDelta {
	readonly tenantId: string
	readonly propertyId: string
	readonly date: string // YYYY-MM-DD
	readonly roomTypeId: string
	readonly ratePlanId: string
	readonly availability: number
	readonly rateMicros: bigint
	readonly currency: 'RUB'
	readonly sequenceNumber: bigint
	readonly restrictions?: {
		readonly minLengthOfStay?: number
		readonly maxLengthOfStay?: number
		readonly closedOnArrival?: boolean
		readonly closedOnDeparture?: boolean
	}
}

export interface AvailabilityQuery {
	readonly tenantId: string
	readonly propertyId: string
	readonly checkIn: string // YYYY-MM-DD
	readonly checkOut: string // YYYY-MM-DD
	readonly guestCount: number
}

export interface AvailabilityRow {
	readonly roomTypeId: string
	readonly ratePlanId: string
	readonly date: string
	readonly availability: number
	readonly rateMicros: bigint
}

export interface ReservationReadCursor {
	readonly tenantId: string
	readonly propertyId: string
	readonly continueToken?: string
	/**
	 * lastModification timestamp. When restoring after continueToken loss,
	 * caller should use `lastModification - 2 days` overlap to avoid missing
	 * reservations (TL canon).
	 */
	readonly lastModificationUtc?: string
}

export interface ChannelReservation {
	readonly channelId: string
	readonly externalId: string
	readonly tenantId: string
	readonly propertyId: string
	readonly roomTypeId: string
	readonly ratePlanId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly guestCount: number
	readonly totalAmountMicros: bigint
	readonly currency: 'RUB'
	readonly status: 'confirmed' | 'cancelled'
	readonly lastModificationUtc: string
	/**
	 * Per-resource monotonic sequence number (Round 8 canon). Каждая
	 * модификация конкретного externalId получает strictly-increasing
	 * sequence. Consumers detect gaps + drop out-of-order updates.
	 * Channels that don't expose native sequence — derive from
	 * `lastModificationUtc` epoch-microseconds + tiebreaker.
	 */
	readonly sequenceNumber: bigint
	readonly guest: {
		readonly firstName: string
		readonly lastName: string
		readonly email?: string
		readonly phone?: string
	}
}

export interface VerifyBookingInput {
	readonly tenantId: string
	readonly propertyId: string
	readonly roomTypeId: string
	readonly ratePlanId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly guestCount: number
	readonly guest: {
		readonly firstName: string
		readonly lastName: string
		readonly email: string
		readonly phone: string
	}
}

export interface VerifyBookingResult {
	readonly createBookingToken: string
	readonly checksum: string
	readonly expiresAtUtc: string
	readonly totalAmountMicros: bigint
	readonly cancellationPolicy: CancellationPolicy
}

export interface CancellationPolicy {
	readonly referencePoint:
		| 'ProviderArrivalTime'
		| 'GuestArrivalTime'
		| 'CustomArrivalTime'
		| 'BookingCreationTime'
	readonly hoursBeforeRef: number
	readonly penaltyKind: 'percent' | 'fixed_amount' | 'first_night'
	readonly penaltyValue: number // % (0-100) or absolute amount
}

export interface CreateBookingInput {
	readonly verifyResult: VerifyBookingResult
	readonly idempotencyKey: string
}

/**
 * Batch operation result with canonical error reporting.
 * Round 8 canon: `errors[]` enables ops triage + dispatcher routing.
 */
export interface AriPushResult {
	readonly accepted: number
	readonly rejected: number
	readonly errors: ReadonlyArray<ChannelAdapterError>
}

export interface ChannelManagerAdapter {
	readonly metadata: ChannelMetadata

	pushAri(delta: ReadonlyArray<AriDelta>): Promise<AriPushResult>
	pushAriFull(snapshot: ReadonlyArray<AriDelta>): Promise<AriPushResult>
	searchAvailability(query: AvailabilityQuery): Promise<ReadonlyArray<AvailabilityRow>>
	readReservations(cursor: ReservationReadCursor): Promise<{
		readonly reservations: ReadonlyArray<ChannelReservation>
		readonly nextContinueToken?: string
		readonly hasMore: boolean
	}>
	verifyBooking(input: VerifyBookingInput): Promise<VerifyBookingResult>
	createBooking(input: CreateBookingInput): Promise<{ readonly externalId: string }>
	cancelReservation(input: {
		readonly tenantId: string
		readonly externalId: string
		/**
		 * Idempotency key (Round 8 canon). Repeated calls with same key MUST be
		 * no-ops returning `already_cancelled`. Caller generates UUID + retains
		 * 24h для retry safety.
		 */
		readonly idempotencyKey: string
	}): Promise<{ readonly status: 'cancelled' | 'not_found' | 'already_cancelled' }>
	calculateCancellationPenalty(input: {
		readonly tenantId: string
		readonly externalId: string
	}): Promise<{ readonly penaltyMicros: bigint }>

	/**
	 * Inbound webhook payload consumer. Returns CloudEvent envelope для inbox
	 * write (idempotency tuple = `(source, id)`). Adapter parses channel-specific
	 * payload into canonical envelope; inbox layer handles dedup + storage.
	 */
	receiveBookingWebhook(input: {
		readonly rawBody: Uint8Array
		readonly headers: Record<string, string>
		readonly clientIp: string | undefined
	}): Promise<
		| { readonly ok: true; readonly event: SochiCloudEvent }
		| { readonly ok: false; readonly reason: string; readonly httpStatus: number }
	>
}
