/**
 * TravelLine behaviour-faithful Mock — M10 / A7.2.
 *
 * Implements `ChannelManagerAdapter` per `feedback_behaviour_faithful_mock_canon.md`:
 * same canonical interface для Mock + Sandbox + Live. Live-flip = factory binding
 * swap, ZERO domain code changes.
 *
 * **Behavior reproduced (per plans/m10_canonical.md D1-D5)**:
 *
 *   D1 — TL is source-of-truth ARI. PMS reads via `searchAvailability()`,
 *        NEVER pushes (`pushAri` / `pushAriFull` are no-ops returning success).
 *
 *   D2 — Polling-not-webhook reservation reception. `readReservations()`
 *        accepts continueToken cursor; if absent, replays via `lastModificationUtc − 2d`.
 *        Mock idempotently dedups by `tlReservationId` across cursors.
 *
 *   D3 — OAuth Client-Credentials → JWT 15-min TTL. Mock simulates token
 *        issuance + auto-refresh on `expiresAtMs - 60s`. Per-IP rate-limit
 *        budget: 3 rps / 15 rpm / 300 rph. `429 Too Many Requests` when bucket
 *        exhausted (with `Retry-After` header).
 *
 *   D4 — Two-step verify→create. `verifyBooking()` issues `createBookingToken`
 *        (UUID v4) с 24h TTL + `checksum` (sha256 of stable shape). `createBooking()`
 *        validates token unused / not expired / checksum match; mismatch → 409.
 *
 *   D5 — TL-canonical IDs. Mock returns `tlRoomTypeId`/`tlRatePlanId` from
 *        seeded fixture; mapping resolution is caller's responsibility (PMS
 *        looks up via `roomType.tlRoomTypeId` migration 0054 column).
 *
 * **Mock data**: in-memory fixture seeded by factory. Deterministic seed
 * supports stable demo (always-on) — same query → same result. Reservation
 * stream is a fixed-cadence simulation (one new reservation every N minutes
 * in demo tenant; manual `__test_seedReservation()` для tests).
 */

import { createHash, randomUUID } from 'node:crypto'
import type {
	AriDelta,
	AriPushResult,
	AvailabilityQuery,
	AvailabilityRow,
	CancellationPolicy,
	ChannelAdapterError,
	ChannelManagerAdapter,
	ChannelMetadata,
	ChannelReservation,
	CreateBookingInput,
	ReservationReadCursor,
	VerifyBookingInput,
	VerifyBookingResult,
} from '../../../lib/channel-manager/adapter.ts'
import {
	buildCloudEvent,
	buildEventType,
	buildSourceUrn,
	type SochiCloudEvent,
} from '../../../lib/channel-manager/cloud-events.ts'
import { nextSequenceNumber, sequenceKey } from '../../../lib/channel-manager/sequence.ts'

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const JWT_TTL_MS = 15 * 60 * 1000
const JWT_REFRESH_BEFORE_EXPIRY_MS = 60 * 1000
const RATE_LIMIT_PER_SECOND = 3
const RATE_LIMIT_PER_MINUTE = 15
const RATE_LIMIT_PER_HOUR = 300

interface InternalReservation {
	readonly tlReservationId: string
	readonly tenantId: string
	readonly propertyId: string
	readonly hotelId: string
	readonly tlRoomTypeId: string
	readonly tlRatePlanId: string
	readonly arrivalDate: string
	readonly departureDate: string
	readonly guestCount: number
	readonly totalPriceMicros: bigint
	readonly status: 'Confirmed' | 'Cancelled'
	readonly lastModificationUtc: string
	/**
	 * Round 8 canon: per-resource monotonic sequence number. Каждая modification
	 * для конкретного tlReservationId увеличивает sequence strictly. Consumers
	 * detect gaps + drop out-of-order updates (наш architectural leapfrog vs
	 * Apaleo/Mews/Cloudbeds/Hostaway). Derived from `nextSequenceNumber()`
	 * (epoch-microseconds + sub-microsecond counter); on rebuild from external
	 * timestamps Mock uses `lastModificationUtc * 1000 + tiebreaker`.
	 */
	readonly sequenceNumber: bigint
	readonly guest: { firstName: string; lastName: string; email?: string; phone?: string }
	readonly cancellationPolicy: CancellationPolicy
}

interface CreateBookingTokenEntry {
	readonly token: string
	readonly checksum: string
	readonly issuedAtMs: number
	readonly expiresAtMs: number
	readonly hotelId: string
	readonly tlRoomTypeId: string
	readonly tlRatePlanId: string
	readonly arrivalDate: string
	readonly departureDate: string
	readonly guest: { firstName: string; lastName: string; email: string; phone: string }
	readonly totalPriceMicros: bigint
	readonly cancellationPolicy: CancellationPolicy
	used: boolean
}

interface JwtTokenState {
	readonly accessToken: string
	readonly issuedAtMs: number
	readonly expiresAtMs: number
}

interface RateLimiterBucket {
	secondCount: number
	secondResetAtMs: number
	minuteCount: number
	minuteResetAtMs: number
	hourCount: number
	hourResetAtMs: number
}

export interface TravellineMockOptions {
	readonly tenantId: string
	readonly propertyId: string
	/** TL hotel id (от extranet config). Mock generates `tl-hotel-${tenantId}` if omitted. */
	readonly hotelId?: string
	/** Initial reservations to seed (test fixture). */
	readonly seedReservations?: ReadonlyArray<InternalReservation>
	/** Rate plan fixture for searchAvailability. Default = single BAR-flex plan with 5 units/day. */
	readonly seedAvailability?: ReadonlyArray<AvailabilityRow>
	readonly nowMs?: () => number
	/**
	 * Test seam: skip rate-limit enforcement. Production code MUST never set true.
	 * Used for unit tests focused on behavior unrelated к rate limits.
	 */
	readonly __test_disableRateLimit?: boolean
}

const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
	referencePoint: 'GuestArrivalTime',
	hoursBeforeRef: 24,
	penaltyKind: 'first_night',
	penaltyValue: 1,
}

/**
 * Compute deterministic Checksum по canonical shape — D4 verify→create binding.
 * Caller in step 2 MUST send back this checksum verbatim.
 *
 * Hash inputs: hotelId + tlRoomTypeId + tlRatePlanId + arrivalDate +
 * departureDate + totalPriceMicros + guest emails (joined). Any drift →
 * checksum changes → 409 на createBooking.
 */
export function computeChecksum(input: {
	hotelId: string
	tlRoomTypeId: string
	tlRatePlanId: string
	arrivalDate: string
	departureDate: string
	totalPriceMicros: bigint
	guestEmails: ReadonlyArray<string>
}): string {
	const canonical = [
		input.hotelId,
		input.tlRoomTypeId,
		input.tlRatePlanId,
		input.arrivalDate,
		input.departureDate,
		input.totalPriceMicros.toString(),
		...input.guestEmails.slice().sort(),
	].join('|')
	return createHash('sha256').update(canonical, 'utf-8').digest('hex')
}

export function createTravellineMock(opts: TravellineMockOptions): ChannelManagerAdapter & {
	readonly emitReservationEvent: (reservation: InternalReservation) => SochiCloudEvent
	readonly __test_seedReservation: (reservation: InternalReservation) => void
	readonly __test_simulateRateLimitExhaustion: () => void
	readonly __test_invalidateJwt: () => void
	readonly __test_inspect: () => {
		readonly reservations: ReadonlyArray<InternalReservation>
		readonly tokens: ReadonlyMap<string, CreateBookingTokenEntry>
		readonly jwt: JwtTokenState | null
		readonly ariSequenceHighWater: ReadonlyMap<string, bigint>
		readonly cancelIdempotencyIndex: ReadonlyMap<
			string,
			'cancelled' | 'already_cancelled' | 'not_found'
		>
	}
} {
	const now = opts.nowMs ?? (() => Date.now())
	const hotelId = opts.hotelId ?? `tl-hotel-${opts.tenantId}`
	const reservations = new Map<string, InternalReservation>()
	for (const r of opts.seedReservations ?? []) reservations.set(r.tlReservationId, r)
	const seedAvailability = opts.seedAvailability ?? []
	const tokens = new Map<string, CreateBookingTokenEntry>()
	let jwt: JwtTokenState | null = null
	const rateLimiter: RateLimiterBucket = {
		secondCount: 0,
		secondResetAtMs: now() + 1000,
		minuteCount: 0,
		minuteResetAtMs: now() + 60_000,
		hourCount: 0,
		hourResetAtMs: now() + 3_600_000,
	}
	/**
	 * Round 8 P1-1: per-resource ARI sequence high-water mark. Keyed by
	 * (tenantId|propertyId|roomTypeId|ratePlanId|date) — каждое pushAri
	 * delta MUST have strictly-increasing sequenceNumber per this key,
	 * else rejected с `category: 'invalid_payload'`. Defense-in-depth для
	 * out-of-order updates (CDC fan-out может deliver across-partition).
	 */
	const ariSequenceHighWater = new Map<string, bigint>()
	/**
	 * Round 8 cancelReservation idempotency: keyed by `idempotencyKey` →
	 * cached final status. Repeated call с same key short-circuits к cached
	 * answer (mirrors Stripe-style idempotency contract).
	 */
	const cancelIdempotencyIndex = new Map<string, 'cancelled' | 'already_cancelled' | 'not_found'>()

	function ensureJwt(): JwtTokenState {
		const t = now()
		if (jwt !== null && t < jwt.expiresAtMs - JWT_REFRESH_BEFORE_EXPIRY_MS) {
			return jwt
		}
		jwt = {
			accessToken: `eyJtb2NrIjp0cnVlfQ.${randomUUID()}.sig`,
			issuedAtMs: t,
			expiresAtMs: t + JWT_TTL_MS,
		}
		return jwt
	}

	function consumeRateLimitOrThrow(): void {
		if (opts.__test_disableRateLimit === true) return
		const t = now()
		if (t >= rateLimiter.secondResetAtMs) {
			rateLimiter.secondCount = 0
			rateLimiter.secondResetAtMs = t + 1000
		}
		if (t >= rateLimiter.minuteResetAtMs) {
			rateLimiter.minuteCount = 0
			rateLimiter.minuteResetAtMs = t + 60_000
		}
		if (t >= rateLimiter.hourResetAtMs) {
			rateLimiter.hourCount = 0
			rateLimiter.hourResetAtMs = t + 3_600_000
		}
		if (rateLimiter.secondCount >= RATE_LIMIT_PER_SECOND) {
			const retryAfterSec = Math.ceil((rateLimiter.secondResetAtMs - t) / 1000)
			throw createRateLimitError(retryAfterSec)
		}
		if (rateLimiter.minuteCount >= RATE_LIMIT_PER_MINUTE) {
			const retryAfterSec = Math.ceil((rateLimiter.minuteResetAtMs - t) / 1000)
			throw createRateLimitError(retryAfterSec)
		}
		if (rateLimiter.hourCount >= RATE_LIMIT_PER_HOUR) {
			const retryAfterSec = Math.ceil((rateLimiter.hourResetAtMs - t) / 1000)
			throw createRateLimitError(retryAfterSec)
		}
		rateLimiter.secondCount++
		rateLimiter.minuteCount++
		rateLimiter.hourCount++
	}

	const metadata: ChannelMetadata = {
		channelId: 'TL',
		mode: 'mock',
		role: 'processor_with_dpa', // D18: TL is processor with DPA
		displayName: 'TravelLine (Mock)',
	}

	const adapter: ChannelManagerAdapter = {
		metadata,

		// D1: PMS reads-only; pushAri is no-op success (TL ignores; PMS owns the source).
		// Round 8 P1-1: even though TL is polling-based + ignores PMS pushes,
		// the adapter MUST validate sequenceNumber monotonicity per-resource so
		// downstream live-flip к real TL writer (or any consumer of pushAri) gets
		// canonical gap-detection + drop-out-of-order semantics. Out-of-order
		// deltas are REJECTED here with category 'invalid_payload'; this is
		// canonical contract per `feedback_round_8_strict_sweep_canon_2026_05_25.md`.
		async pushAri(delta: ReadonlyArray<AriDelta>): Promise<AriPushResult> {
			ensureJwt()
			consumeRateLimitOrThrow()
			let accepted = 0
			let rejected = 0
			const errors: ChannelAdapterError[] = []
			for (let i = 0; i < delta.length; i++) {
				// biome-ignore lint/style/noNonNullAssertion: bounded loop, index in range
				const d = delta[i]!
				const key = ariResourceKey(d)
				const prev = ariSequenceHighWater.get(key)
				if (prev !== undefined && d.sequenceNumber <= prev) {
					rejected++
					errors.push({
						category: 'invalid_payload',
						message: 'sequence_number_not_monotonic',
						itemIndex: i,
						upstreamCode: 'TL_SEQUENCE_NOT_MONOTONIC',
					})
					continue
				}
				ariSequenceHighWater.set(key, d.sequenceNumber)
				accepted++
			}
			return { accepted, rejected, errors }
		},

		async pushAriFull(snapshot: ReadonlyArray<AriDelta>): Promise<AriPushResult> {
			ensureJwt()
			consumeRateLimitOrThrow()
			// Full-resync semantics: clear high-water + replay в order.
			ariSequenceHighWater.clear()
			let accepted = 0
			let rejected = 0
			const errors: ChannelAdapterError[] = []
			for (let i = 0; i < snapshot.length; i++) {
				// biome-ignore lint/style/noNonNullAssertion: bounded loop, index in range
				const d = snapshot[i]!
				const key = ariResourceKey(d)
				const prev = ariSequenceHighWater.get(key)
				if (prev !== undefined && d.sequenceNumber <= prev) {
					rejected++
					errors.push({
						category: 'invalid_payload',
						message: 'sequence_number_not_monotonic_within_snapshot',
						itemIndex: i,
						upstreamCode: 'TL_SEQUENCE_NOT_MONOTONIC',
					})
					continue
				}
				ariSequenceHighWater.set(key, d.sequenceNumber)
				accepted++
			}
			return { accepted, rejected, errors }
		},

		// D1: Read availability from TL fixture. Filter by date range от query.
		async searchAvailability(query: AvailabilityQuery): Promise<ReadonlyArray<AvailabilityRow>> {
			ensureJwt()
			consumeRateLimitOrThrow()
			return seedAvailability.filter((row) => {
				return row.date >= query.checkIn && row.date < query.checkOut
			})
		},

		// D2: Polling reception. continueToken honored if present; else replay via lastModification−2d.
		async readReservations(cursor: ReservationReadCursor) {
			ensureJwt()
			consumeRateLimitOrThrow()

			const allOrdered = Array.from(reservations.values()).sort((a, b) =>
				a.lastModificationUtc.localeCompare(b.lastModificationUtc),
			)

			let filtered = allOrdered
			if (cursor.continueToken !== undefined) {
				// Mock continueToken format: `cursor|<lastModificationUtc>|<id>`.
				// Pipe separator (NOT `:`) because ISO timestamps contain colons.
				const parts = cursor.continueToken.split('|')
				if (parts.length === 3 && parts[0] === 'cursor') {
					const cursorAt = parts[1] ?? ''
					const cursorId = parts[2] ?? ''
					filtered = allOrdered.filter(
						(r) =>
							r.lastModificationUtc > cursorAt ||
							(r.lastModificationUtc === cursorAt && r.tlReservationId > cursorId),
					)
				}
			} else if (cursor.lastModificationUtc !== undefined) {
				// D2: lastModification−2d overlap (canonical TL guidance).
				const overlapStart = new Date(
					new Date(cursor.lastModificationUtc).getTime() - 2 * 24 * 60 * 60 * 1000,
				).toISOString()
				filtered = allOrdered.filter((r) => r.lastModificationUtc >= overlapStart)
			}

			const PAGE_SIZE = 100
			const page = filtered.slice(0, PAGE_SIZE)
			const hasMore = filtered.length > PAGE_SIZE
			const last = page[page.length - 1]
			const result: {
				readonly reservations: ReadonlyArray<ChannelReservation>
				readonly hasMore: boolean
				readonly nextContinueToken?: string
			} = {
				reservations: page.map((r) => ({
					channelId: 'TL',
					externalId: r.tlReservationId,
					tenantId: r.tenantId,
					propertyId: r.propertyId,
					roomTypeId: r.tlRoomTypeId,
					ratePlanId: r.tlRatePlanId,
					checkIn: r.arrivalDate,
					checkOut: r.departureDate,
					guestCount: r.guestCount,
					totalAmountMicros: r.totalPriceMicros,
					currency: 'RUB' as const,
					status: r.status === 'Confirmed' ? ('confirmed' as const) : ('cancelled' as const),
					lastModificationUtc: r.lastModificationUtc,
					// Round 8 P1-1: per-resource monotonic sequence number forwarded к caller
					// — каждое pull через polling cursor carries the same sequence so PMS
					// can detect duplicates / out-of-order updates idempotently.
					sequenceNumber: r.sequenceNumber,
					guest: r.guest,
				})),
				hasMore,
				...(hasMore && last !== undefined
					? {
							nextContinueToken: `cursor|${last.lastModificationUtc}|${last.tlReservationId}`,
						}
					: {}),
			}
			return result
		},

		// D4 step 1: verify → issue createBookingToken + checksum.
		async verifyBooking(input: VerifyBookingInput): Promise<VerifyBookingResult> {
			ensureJwt()
			consumeRateLimitOrThrow()
			const totalPriceMicros = computeMockPrice(input)
			const checksum = computeChecksum({
				hotelId,
				tlRoomTypeId: input.roomTypeId,
				tlRatePlanId: input.ratePlanId,
				arrivalDate: input.checkIn,
				departureDate: input.checkOut,
				totalPriceMicros,
				guestEmails: [input.guest.email],
			})
			const token = randomUUID()
			const issued = now()
			tokens.set(token, {
				token,
				checksum,
				issuedAtMs: issued,
				expiresAtMs: issued + TOKEN_TTL_MS,
				hotelId,
				tlRoomTypeId: input.roomTypeId,
				tlRatePlanId: input.ratePlanId,
				arrivalDate: input.checkIn,
				departureDate: input.checkOut,
				guest: input.guest,
				totalPriceMicros,
				cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
				used: false,
			})
			return {
				createBookingToken: token,
				checksum,
				expiresAtUtc: new Date(issued + TOKEN_TTL_MS).toISOString(),
				totalAmountMicros: totalPriceMicros,
				cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
			}
		},

		// D4 step 2: create. Validates token (exists / not used / not expired / checksum match).
		async createBooking(input: CreateBookingInput): Promise<{ readonly externalId: string }> {
			ensureJwt()
			consumeRateLimitOrThrow()
			const entry = tokens.get(input.verifyResult.createBookingToken)
			if (!entry) {
				throw createTlError('TOKEN_USED', 410, 'createBookingToken not found OR already consumed')
			}
			if (entry.used) {
				throw createTlError('TOKEN_USED', 410, 'createBookingToken already consumed (single-use)')
			}
			if (now() > entry.expiresAtMs) {
				throw createTlError('TOKEN_EXPIRED', 410, 'createBookingToken expired (24h TTL)')
			}
			if (entry.checksum !== input.verifyResult.checksum) {
				throw createTlError(
					'CHECKSUM_MISMATCH',
					409,
					'Checksum mismatch between verify and create steps',
				)
			}
			entry.used = true
			const tlReservationId = `tl-res-${randomUUID().slice(0, 12)}`
			const created = new Date(now()).toISOString()
			reservations.set(tlReservationId, {
				tlReservationId,
				tenantId: opts.tenantId,
				propertyId: opts.propertyId,
				hotelId: entry.hotelId,
				tlRoomTypeId: entry.tlRoomTypeId,
				tlRatePlanId: entry.tlRatePlanId,
				arrivalDate: entry.arrivalDate,
				departureDate: entry.departureDate,
				guestCount: 1,
				totalPriceMicros: entry.totalPriceMicros,
				status: 'Confirmed',
				lastModificationUtc: created,
				sequenceNumber: nextSequenceNumber(
					sequenceKey({ tenantId: opts.tenantId, propertyId: opts.propertyId, channelId: 'TL' }),
				),
				guest: entry.guest,
				cancellationPolicy: entry.cancellationPolicy,
			})
			return { externalId: tlReservationId }
		},

		async cancelReservation(input: {
			readonly tenantId: string
			readonly externalId: string
			readonly idempotencyKey: string
		}) {
			ensureJwt()
			consumeRateLimitOrThrow()
			// Round 8 canon: repeated calls с same idempotencyKey MUST return cached
			// outcome без side-effect. Cache spans all status terminals so a retry
			// после network blip cannot accidentally double-cancel a freshly-revived
			// booking (no-op on already-cancelled is provided separately by status).
			const cached = cancelIdempotencyIndex.get(input.idempotencyKey)
			if (cached !== undefined) return { status: cached }
			if (input.tenantId !== opts.tenantId) {
				cancelIdempotencyIndex.set(input.idempotencyKey, 'not_found')
				return { status: 'not_found' as const }
			}
			const r = reservations.get(input.externalId)
			if (!r) {
				cancelIdempotencyIndex.set(input.idempotencyKey, 'not_found')
				return { status: 'not_found' as const }
			}
			if (r.status === 'Cancelled') {
				cancelIdempotencyIndex.set(input.idempotencyKey, 'already_cancelled')
				return { status: 'already_cancelled' as const }
			}
			reservations.set(input.externalId, {
				...r,
				status: 'Cancelled',
				lastModificationUtc: new Date(now()).toISOString(),
				sequenceNumber: nextSequenceNumber(
					sequenceKey({ tenantId: opts.tenantId, propertyId: opts.propertyId, channelId: 'TL' }),
				),
			})
			cancelIdempotencyIndex.set(input.idempotencyKey, 'cancelled')
			return { status: 'cancelled' as const }
		},

		async calculateCancellationPenalty(input: {
			readonly tenantId: string
			readonly externalId: string
		}) {
			ensureJwt()
			consumeRateLimitOrThrow()
			if (input.tenantId !== opts.tenantId) return { penaltyMicros: 0n }
			const r = reservations.get(input.externalId)
			if (!r) return { penaltyMicros: 0n }
			// Mock: first_night = 1/N nights of total price.
			const arrival = new Date(r.arrivalDate).getTime()
			const departure = new Date(r.departureDate).getTime()
			const nights = Math.max(1, Math.round((departure - arrival) / (24 * 60 * 60 * 1000)))
			return { penaltyMicros: r.totalPriceMicros / BigInt(nights) }
		},

		// TL has no inbound webhook (D2: polling-not-webhook). Adapter rejects.
		async receiveBookingWebhook(_input) {
			return {
				ok: false,
				reason: 'TL does not support webhooks (canonical polling-not-webhook per D2)',
				httpStatus: 501,
			}
		},
	}

	return {
		...adapter,
		emitReservationEvent(reservation: InternalReservation): SochiCloudEvent {
			return buildCloudEvent({
				id: reservation.tlReservationId,
				source: buildSourceUrn({
					channelCode: 'TL',
					organizationId: opts.tenantId,
				}),
				type: buildEventType({
					entity: 'booking',
					action: reservation.status === 'Confirmed' ? 'created' : 'cancelled',
					version: 'v1',
				}),
				subject: reservation.tlReservationId,
				data: reservation,
			})
		},
		__test_seedReservation(reservation: InternalReservation) {
			reservations.set(reservation.tlReservationId, reservation)
		},
		__test_simulateRateLimitExhaustion() {
			rateLimiter.secondCount = RATE_LIMIT_PER_SECOND
			rateLimiter.minuteCount = RATE_LIMIT_PER_MINUTE
			rateLimiter.hourCount = RATE_LIMIT_PER_HOUR
			rateLimiter.secondResetAtMs = now() + 1000
			rateLimiter.minuteResetAtMs = now() + 60_000
			rateLimiter.hourResetAtMs = now() + 3_600_000
		},
		__test_invalidateJwt() {
			jwt = null
		},
		__test_inspect() {
			return {
				reservations: Array.from(reservations.values()),
				tokens: new Map(tokens),
				jwt,
				ariSequenceHighWater: new Map(ariSequenceHighWater),
				cancelIdempotencyIndex: new Map(cancelIdempotencyIndex),
			}
		},
	}
}

/**
 * Round 8 P1-1: derive per-resource ARI key for sequenceNumber monotonicity
 * tracking. Resource identity = (tenant, property, roomType, ratePlan, date).
 * Used by pushAri / pushAriFull to enforce strictly-increasing sequence
 * per-resource — out-of-order updates rejected as `invalid_payload`.
 */
function ariResourceKey(delta: AriDelta): string {
	return `${delta.tenantId}|${delta.propertyId}|${delta.roomTypeId}|${delta.ratePlanId}|${delta.date}`
}

function computeMockPrice(input: VerifyBookingInput): bigint {
	const arrival = new Date(input.checkIn).getTime()
	const departure = new Date(input.checkOut).getTime()
	const nights = Math.max(1, Math.round((departure - arrival) / (24 * 60 * 60 * 1000)))
	const RATE_PER_NIGHT_MICROS = 5_000_000n
	return RATE_PER_NIGHT_MICROS * BigInt(nights) * BigInt(input.guestCount)
}

export class TravellineRateLimitError extends Error {
	readonly httpStatus = 429
	readonly retryAfterSeconds: number
	constructor(retryAfterSeconds: number) {
		super(`TravelLine rate-limit exhausted; retry after ${retryAfterSeconds}s`)
		this.name = 'TravellineRateLimitError'
		this.retryAfterSeconds = retryAfterSeconds
	}
}

function createRateLimitError(retryAfterSec: number): TravellineRateLimitError {
	return new TravellineRateLimitError(retryAfterSec)
}

export class TravellineApiError extends Error {
	readonly httpStatus: number
	readonly errorCode: string
	constructor(errorCode: string, httpStatus: number, message: string) {
		super(message)
		this.name = 'TravellineApiError'
		this.errorCode = errorCode
		this.httpStatus = httpStatus
	}
}

function createTlError(
	errorCode: 'CHECKSUM_MISMATCH' | 'TOKEN_EXPIRED' | 'TOKEN_USED',
	httpStatus: number,
	message: string,
): TravellineApiError {
	return new TravellineApiError(errorCode, httpStatus, message)
}
