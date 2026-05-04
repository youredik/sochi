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
 * Outbound ARI delta (push from PMS). Channels that pull-not-push (TravelLine)
 * may treat this as a no-op + return success synchronously.
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

export interface ChannelManagerAdapter {
	readonly metadata: ChannelMetadata

	pushAri(delta: ReadonlyArray<AriDelta>): Promise<{ accepted: number; rejected: number }>
	pushAriFull(snapshot: ReadonlyArray<AriDelta>): Promise<{ accepted: number; rejected: number }>
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
