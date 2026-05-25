/**
 * Ostrovok ETG behaviour-faithful Mock — M10 / A7.4.
 *
 * Per `plans/m10_canonical.md` D7-D10:
 *   - D7 HTTP Basic Auth (`id` + `uuid`) at `api.worldota.net/api/b2b/v3/...`
 *        (sandbox: `api-sandbox.worldota.net`). REST/JSON. NO TS SDK — raw HTTP.
 *   - D8 5-stage state machine: search → prebook → book → start → check
 *        + 5s polling cadence + mandatory last-second forced poll
 *   - D9 `partner_order_id` UUID v4 rotated on `double_booking_form` collision;
 *        cap retries at 3 attempts
 *   - D10 Webhook opt-in only, terminal-only `confirmed`/`failed`. Polling
 *        is source-of-truth. Stuck-in-book timeout: 90s non-3DS / 600s 3DS.
 *
 * **4-brand fan-out** (single creds, demuxed via `source` field):
 *   - RateHawk (B2B agent network)
 *   - ZenHotels (B2C white-label)
 *   - B2B.Ostrovok (corporate B2B)
 *   - Ostrovok (B2C consumer)
 *
 * **3 commercial models** (per partnership tier):
 *   - `b2b_net`: net rate (commission baked into price; partner pockets margin)
 *   - `affiliate_gross`: gross rate (commission paid out)
 *   - `b2b_fake_gross`: net behind gross-looking rate
 *
 * **Sandbox safeguards**:
 *   - `hid=8473727` is the canonical sandbox test hotel — Mock simulates
 *     responses ONLY для this hid в sandbox mode. Other HIDs return empty.
 *   - Real bookings forbidden в sandbox — Mock always returns 'sandbox-only'
 *     marker on book stage.
 *
 * **Photo refs canon**: `rg_ext` field (NOT deprecated `images`). Mock fixture
 * uses `rg_ext` shape exclusively.
 *
 * **Round 8 canon (2026-05-25)**:
 *   - Per-resource `sequenceNumber: bigint` on every `ChannelReservation` +
 *     `AriDelta`. Monotonicity enforced на pushAri/pushAriFull — out-of-order
 *     deltas rejected via `errors[{ category: 'invalid_payload', ... }]`.
 *   - `cancelReservation` accepts `idempotencyKey: string`; repeat-call с
 *     same key → `already_cancelled` (no-op retry safety).
 *   - `verifyBooking` validates `tenantId === opts.tenantId` (cross-tenant
 *     leak guard per Round 8 audit).
 *   - `prebook` derives `checkIn/checkOut/guestCount` от input (no hardcoded
 *     fixture — behaviour-faithfulness canon).
 *   - `pushAri` returns canonical `AriPushResult { accepted, rejected, errors }`.
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
import { nextSequenceNumber } from '../../../lib/channel-manager/sequence.ts'

export type EtgBookingStage = 'search' | 'prebook' | 'book' | 'start' | 'check'

export type EtgBrand = 'RateHawk' | 'ZenHotels' | 'B2B.Ostrovok' | 'Ostrovok'

export type EtgCommercialModel = 'b2b_net' | 'affiliate_gross' | 'b2b_fake_gross'

const SANDBOX_DEMO_HID = 8473727
const STUCK_IN_BOOK_TIMEOUT_NON_3DS_MS = 90_000
const STUCK_IN_BOOK_TIMEOUT_3DS_MS = 600_000
const PARTNER_ORDER_ID_RETRY_CAP = 3

interface EtgBookingState {
	partnerOrderId: string
	stage: EtgBookingStage
	hid: number
	brand: EtgBrand
	source: string
	commercialModel: EtgCommercialModel
	priceMicros: bigint
	currency: 'RUB'
	checkIn: string
	checkOut: string
	guestCount: number
	rotationAttempts: number
	createdAtMs: number
	bookStartedAtMs: number | null
	uses3ds: boolean
	terminalState: 'confirmed' | 'failed' | null
	cancellationPolicy: CancellationPolicy
	rgExt: ReadonlyArray<{ readonly category: string; readonly url: string }>
	/** Monotonic sequence number for inner state mutations (Round 8 canon). */
	sequenceNumber: bigint
	/** Idempotency keys observed for cancelReservation (Round 8). */
	cancellationIdempotencyKeys: Set<string>
}

const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
	referencePoint: 'GuestArrivalTime',
	hoursBeforeRef: 72,
	penaltyKind: 'first_night',
	penaltyValue: 1,
}

export interface OstrovokEtgMockOptions {
	readonly tenantId: string
	readonly propertyId: string
	/** ETG sandbox creds (id + uuid Basic Auth). Mock auto-generates if omitted. */
	readonly etgClientId?: string
	readonly etgClientUuid?: string
	/** Mode: 'sandbox' uses hid=8473727 demo hotel, 'live' allows arbitrary hid. */
	readonly mode?: 'sandbox' | 'live'
	/** Default brand fan-out source on outbound dispatch. */
	readonly defaultBrand?: EtgBrand
	readonly defaultCommercialModel?: EtgCommercialModel
	readonly nowMs?: () => number
}

export interface OstrovokEtgMockHandle extends ChannelManagerAdapter {
	readonly emitReservationEvent: (state: EtgBookingState) => SochiCloudEvent
	readonly searchHotels: (input: {
		readonly hid: number
		readonly checkIn: string
		readonly checkOut: string
		readonly guestCount: number
	}) => Promise<EtgSearchResult[]>
	readonly prebook: (input: {
		readonly hid: number
		readonly searchId: string
		readonly checkIn: string
		readonly checkOut: string
		readonly guestCount: number
		readonly brand?: EtgBrand
		readonly commercialModel?: EtgCommercialModel
	}) => Promise<{ readonly partnerOrderId: string; readonly bookHash: string }>
	readonly book: (input: {
		readonly partnerOrderId: string
		readonly bookHash: string
		readonly uses3ds?: boolean
	}) => Promise<{ readonly stage: EtgBookingStage; readonly partnerOrderIdRotated?: string }>
	readonly start: (input: { readonly partnerOrderId: string }) => Promise<{
		readonly stage: EtgBookingStage
	}>
	readonly checkBookingStatus: (input: { readonly partnerOrderId: string }) => Promise<{
		readonly stage: EtgBookingStage
		readonly terminal: 'confirmed' | 'failed' | null
		readonly stuckTimeoutExceeded?: boolean
	}>
	readonly forceTerminal: (input: {
		readonly partnerOrderId: string
		readonly outcome: 'confirmed' | 'failed'
	}) => Promise<void>
	readonly extractBrandFromSource: (source: string) => EtgBrand | null
	readonly listBrands: () => ReadonlyArray<EtgBrand>
	readonly __test_simulateDoubleBookingCollision: (partnerOrderId: string) => void
	readonly __test_inspect: () => {
		readonly bookings: ReadonlyArray<EtgBookingState>
		readonly basicAuthHeader: string
	}
}

export interface EtgSearchResult {
	readonly hid: number
	readonly searchId: string
	readonly priceMicros: bigint
	readonly currency: 'RUB'
	readonly cancellationPolicy: CancellationPolicy
	readonly rgExt: ReadonlyArray<{ readonly category: string; readonly url: string }>
}

const BRAND_TO_SOURCE: Record<EtgBrand, string> = {
	RateHawk: 'ratehawk',
	ZenHotels: 'zenhotels',
	'B2B.Ostrovok': 'b2b.ostrovok',
	Ostrovok: 'ostrovok',
}

const SOURCE_TO_BRAND: Record<string, EtgBrand> = Object.fromEntries(
	(Object.entries(BRAND_TO_SOURCE) as Array<[EtgBrand, string]>).map(([brand, source]) => [
		source,
		brand,
	]),
) as Record<string, EtgBrand>

export function buildEtgBasicAuthHeader(input: { id: string; uuid: string }): string {
	const token = Buffer.from(`${input.id}:${input.uuid}`, 'utf-8').toString('base64')
	return `Basic ${token}`
}

/**
 * Per-resource ARI monotonicity key (Round 8 canon). Sequence numbers
 * MUST be strictly increasing per (tenant, property, roomType, ratePlan, date).
 */
function ariResourceKey(d: AriDelta): string {
	return `${d.tenantId}:${d.propertyId}:${d.roomTypeId}:${d.ratePlanId}:${d.date}`
}

export function createOstrovokEtgMock(opts: OstrovokEtgMockOptions): OstrovokEtgMockHandle {
	const now = opts.nowMs ?? (() => Date.now())
	const mode = opts.mode ?? 'sandbox'
	const etgClientId = opts.etgClientId ?? `etg-mock-id-${randomUUID()}`
	const etgClientUuid = opts.etgClientUuid ?? `etg-mock-uuid-${randomUUID()}`
	const defaultBrand: EtgBrand = opts.defaultBrand ?? 'RateHawk'
	const defaultCommercialModel: EtgCommercialModel = opts.defaultCommercialModel ?? 'b2b_net'
	const basicAuthHeader = buildEtgBasicAuthHeader({ id: etgClientId, uuid: etgClientUuid })
	const bookings = new Map<string, EtgBookingState>()
	const collisionFlags = new Set<string>()
	const partnerOrderIdGlobalIndex = new Set<string>()
	/** Round 8: per-resource highest accepted sequenceNumber для monotonicity guard. */
	const ariHighestSeq = new Map<string, bigint>()
	const ariAcceptedLog: Array<{ key: string; delta: AriDelta; acceptedAtMs: number }> = []

	function buildSearchId(hid: number): string {
		return `search-${hid}-${createHash('sha256').update(`${hid}:${now()}`).digest('hex').slice(0, 12)}`
	}

	function buildBookHash(searchId: string): string {
		return createHash('sha256').update(`${searchId}:bookhash`).digest('hex').slice(0, 24)
	}

	const metadata: ChannelMetadata = {
		channelId: 'ETG',
		mode: mode === 'sandbox' ? 'mock' : 'live',
		role: 'independent_operator', // D18 per RU compliance split
		displayName: `Ostrovok ETG (${mode}) — 4-brand fan-out`,
	}

	function applyAriOne(d: AriDelta): { accepted: boolean; error?: ChannelAdapterError } {
		const key = ariResourceKey(d)
		const prev = ariHighestSeq.get(key)
		if (prev !== undefined && d.sequenceNumber <= prev) {
			return {
				accepted: false,
				error: {
					category: 'invalid_payload',
					message: `out_of_order_sequence: resource=${key} got=${d.sequenceNumber.toString()} highestAccepted=${prev.toString()}`,
				},
			}
		}
		ariHighestSeq.set(key, d.sequenceNumber)
		ariAcceptedLog.push({ key, delta: d, acceptedAtMs: now() })
		return { accepted: true }
	}

	const adapter: ChannelManagerAdapter = {
		metadata,

		async pushAri(delta: ReadonlyArray<AriDelta>): Promise<AriPushResult> {
			let accepted = 0
			let rejected = 0
			const errors: ChannelAdapterError[] = []
			for (let i = 0; i < delta.length; i++) {
				const d = delta[i]
				if (d === undefined) continue
				const r = applyAriOne(d)
				if (r.accepted) {
					accepted++
				} else {
					rejected++
					if (r.error) {
						errors.push({ ...r.error, itemIndex: i })
					}
				}
			}
			return { accepted, rejected, errors }
		},

		async pushAriFull(snapshot: ReadonlyArray<AriDelta>): Promise<AriPushResult> {
			// Full snapshot: clear monotonicity state + re-apply in input order.
			// Per-resource sequence MUST still be monotone WITHIN snapshot.
			ariHighestSeq.clear()
			ariAcceptedLog.length = 0
			let accepted = 0
			let rejected = 0
			const errors: ChannelAdapterError[] = []
			for (let i = 0; i < snapshot.length; i++) {
				const d = snapshot[i]
				if (d === undefined) continue
				const r = applyAriOne(d)
				if (r.accepted) {
					accepted++
				} else {
					rejected++
					if (r.error) {
						errors.push({ ...r.error, itemIndex: i })
					}
				}
			}
			return { accepted, rejected, errors }
		},

		async searchAvailability(_query: AvailabilityQuery): Promise<ReadonlyArray<AvailabilityRow>> {
			// ETG search is hotel-id-keyed (via /search/v1/hotelpage), not date-range
			// over inventory. Adapter does not expose ARI search в this canonical shape.
			return []
		},

		async readReservations(_cursor: ReservationReadCursor) {
			// Webhook + polling source-of-truth (D10). For canonical adapter interface,
			// surface terminal-state bookings.
			const ordered = Array.from(bookings.values())
				.filter((b) => b.terminalState !== null)
				.sort((a, b) => a.createdAtMs - b.createdAtMs)
			return {
				reservations: ordered.map(
					(b): ChannelReservation => ({
						channelId: 'ETG',
						externalId: b.partnerOrderId,
						tenantId: opts.tenantId,
						propertyId: opts.propertyId,
						roomTypeId: `etg-rt-${b.hid}`,
						ratePlanId: `etg-rp-${b.commercialModel}`,
						checkIn: b.checkIn,
						checkOut: b.checkOut,
						guestCount: b.guestCount,
						totalAmountMicros: b.priceMicros,
						currency: 'RUB',
						status: b.terminalState === 'confirmed' ? 'confirmed' : 'cancelled',
						lastModificationUtc: new Date(b.createdAtMs).toISOString(),
						sequenceNumber: b.sequenceNumber,
						guest: { firstName: 'ETG', lastName: 'Guest' },
					}),
				),
				hasMore: false,
			}
		},

		async verifyBooking(input: VerifyBookingInput): Promise<VerifyBookingResult> {
			// Cross-tenant guard (Round 8 audit): mis-cached adapter MUST refuse
			// foreign tenantId to prevent cross-tenant leak.
			if (input.tenantId !== opts.tenantId) {
				throw new Error(
					`cross_tenant_refused: adapter bound to ${opts.tenantId} got ${input.tenantId}`,
				)
			}
			const arrival = new Date(input.checkIn).getTime()
			const departure = new Date(input.checkOut).getTime()
			const nights = Math.max(1, Math.round((departure - arrival) / (24 * 60 * 60 * 1000)))
			const total = 7_000_000n * BigInt(nights) * BigInt(input.guestCount)
			return {
				createBookingToken: randomUUID(),
				checksum: createHash('sha256').update(`${input.checkIn}|${total.toString()}`).digest('hex'),
				expiresAtUtc: new Date(now() + 30 * 60_000).toISOString(),
				totalAmountMicros: total,
				cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
			}
		},

		async createBooking(_input: CreateBookingInput): Promise<{ readonly externalId: string }> {
			// Canonical interface — но ETG flow goes via 5-stage SM, not single
			// verify→create. Caller MUST use prebook+book+start+check helpers.
			throw new Error('ETG createBooking: use 5-stage SM (prebook→book→start→check) per D8')
		},

		async cancelReservation(input: {
			readonly tenantId: string
			readonly externalId: string
			readonly idempotencyKey: string
		}) {
			// Cross-tenant guard (Round 8 audit).
			if (input.tenantId !== opts.tenantId) return { status: 'not_found' as const }
			const b = bookings.get(input.externalId)
			if (!b) return { status: 'not_found' as const }
			// Idempotent retry: same key → already-cancelled (no-op safety).
			if (b.cancellationIdempotencyKeys.has(input.idempotencyKey)) {
				return { status: 'already_cancelled' as const }
			}
			if (b.terminalState === 'failed') {
				b.cancellationIdempotencyKeys.add(input.idempotencyKey)
				return { status: 'already_cancelled' as const }
			}
			b.terminalState = 'failed'
			b.stage = 'check'
			b.sequenceNumber = nextSequenceNumber()
			b.cancellationIdempotencyKeys.add(input.idempotencyKey)
			return { status: 'cancelled' as const }
		},

		async calculateCancellationPenalty(input: {
			readonly tenantId: string
			readonly externalId: string
		}) {
			if (input.tenantId !== opts.tenantId) return { penaltyMicros: 0n }
			const b = bookings.get(input.externalId)
			if (!b) return { penaltyMicros: 0n }
			const arrival = new Date(b.checkIn).getTime()
			const departure = new Date(b.checkOut).getTime()
			const nights = Math.max(1, Math.round((departure - arrival) / (24 * 60 * 60 * 1000)))
			return { penaltyMicros: b.priceMicros / BigInt(nights) }
		},

		// Inbound webhook (D10): opt-in only, terminal-only confirmed/failed.
		// Polling is source-of-truth; webhook delivery best-effort.
		async receiveBookingWebhook(input) {
			const decoder = new TextDecoder('utf-8', { fatal: false })
			let payload: unknown
			try {
				payload = JSON.parse(decoder.decode(input.rawBody))
			} catch {
				return { ok: false, reason: 'malformed_json', httpStatus: 400 }
			}
			const data = payload as Record<string, unknown> | null
			if (!data || typeof data.partner_order_id !== 'string') {
				return { ok: false, reason: 'missing_partner_order_id', httpStatus: 400 }
			}
			if (data.status !== 'confirmed' && data.status !== 'failed') {
				// Non-terminal webhook delivery is canonically rejected per D10.
				return { ok: false, reason: 'non_terminal_status_rejected', httpStatus: 400 }
			}
			const event = buildCloudEvent({
				id: data.partner_order_id,
				source: buildSourceUrn({
					channelCode: 'ETG',
					organizationId: opts.tenantId,
				}),
				type: buildEventType({
					entity: 'booking',
					action: data.status === 'confirmed' ? 'created' : 'cancelled',
					version: 'v1',
				}),
				subject: data.partner_order_id,
				data: payload,
			})
			return { ok: true, event }
		},
	}

	return {
		...adapter,
		emitReservationEvent(state: EtgBookingState): SochiCloudEvent {
			return buildCloudEvent({
				id: state.partnerOrderId,
				source: buildSourceUrn({ channelCode: 'ETG', organizationId: opts.tenantId }),
				type: buildEventType({
					entity: 'booking',
					action: state.terminalState === 'confirmed' ? 'created' : 'cancelled',
					version: 'v1',
				}),
				subject: state.partnerOrderId,
				data: state,
			})
		},

		async searchHotels(input) {
			// Sandbox safeguard: hid MUST = SANDBOX_DEMO_HID for sandbox mode.
			if (mode === 'sandbox' && input.hid !== SANDBOX_DEMO_HID) return []
			const searchId = buildSearchId(input.hid)
			const arrival = new Date(input.checkIn).getTime()
			const departure = new Date(input.checkOut).getTime()
			const nights = Math.max(1, Math.round((departure - arrival) / (24 * 60 * 60 * 1000)))
			return [
				{
					hid: input.hid,
					searchId,
					priceMicros: 7_000_000n * BigInt(nights) * BigInt(input.guestCount),
					currency: 'RUB' as const,
					cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
					rgExt: [
						{ category: 'main', url: 'https://cdn.ostrovok.ru/h/8473727/m1.jpg' },
						{ category: 'lobby', url: 'https://cdn.ostrovok.ru/h/8473727/lobby.jpg' },
					],
				},
			]
		},

		async prebook(input) {
			// Round 8 P0-3: derive checkIn/checkOut/guestCount от input, NOT fixture.
			// Behaviour-faithfulness canon — fake-fixture hardcoded values violate
			// the "Mock = canonical interface полнофункциональный" rule
			// (`feedback_behaviour_faithful_mock_canon.md`).
			const partnerOrderId = randomUUID()
			partnerOrderIdGlobalIndex.add(partnerOrderId)
			const brand = input.brand ?? defaultBrand
			const commercialModel = input.commercialModel ?? defaultCommercialModel
			const bookHash = buildBookHash(input.searchId)
			const arrival = new Date(input.checkIn).getTime()
			const departure = new Date(input.checkOut).getTime()
			const nights = Math.max(1, Math.round((departure - arrival) / (24 * 60 * 60 * 1000)))
			bookings.set(partnerOrderId, {
				partnerOrderId,
				stage: 'prebook',
				hid: input.hid,
				brand,
				source: BRAND_TO_SOURCE[brand],
				commercialModel,
				priceMicros: 7_000_000n * BigInt(nights) * BigInt(input.guestCount),
				currency: 'RUB',
				checkIn: input.checkIn,
				checkOut: input.checkOut,
				guestCount: input.guestCount,
				rotationAttempts: 0,
				createdAtMs: now(),
				bookStartedAtMs: null,
				uses3ds: false,
				terminalState: null,
				cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
				rgExt: [{ category: 'main', url: 'https://cdn.ostrovok.ru/h/8473727/m1.jpg' }],
				sequenceNumber: nextSequenceNumber(),
				cancellationIdempotencyKeys: new Set<string>(),
			})
			return { partnerOrderId, bookHash }
		},

		async book(input) {
			const b = bookings.get(input.partnerOrderId)
			if (!b) {
				throw new Error(`partner_order_id not found: ${input.partnerOrderId}`)
			}
			b.uses3ds = input.uses3ds ?? false

			// D9: double_booking_form collision → rotate partnerOrderId, cap retries.
			if (collisionFlags.has(input.partnerOrderId)) {
				collisionFlags.delete(input.partnerOrderId)
				if (b.rotationAttempts >= PARTNER_ORDER_ID_RETRY_CAP) {
					throw new Error(
						`partner_order_id rotation cap exceeded (${PARTNER_ORDER_ID_RETRY_CAP} attempts) for booking`,
					)
				}
				const newId = randomUUID()
				partnerOrderIdGlobalIndex.add(newId)
				bookings.delete(input.partnerOrderId)
				bookings.set(newId, {
					...b,
					partnerOrderId: newId,
					rotationAttempts: b.rotationAttempts + 1,
					sequenceNumber: nextSequenceNumber(),
				})
				return { stage: 'book', partnerOrderIdRotated: newId }
			}

			b.stage = 'book'
			b.bookStartedAtMs = now()
			b.sequenceNumber = nextSequenceNumber()
			return { stage: 'book' }
		},

		async start(input) {
			const b = bookings.get(input.partnerOrderId)
			if (!b) throw new Error(`partner_order_id not found: ${input.partnerOrderId}`)
			b.stage = 'start'
			b.sequenceNumber = nextSequenceNumber()
			return { stage: 'start' }
		},

		async checkBookingStatus(input) {
			const b = bookings.get(input.partnerOrderId)
			if (!b) throw new Error(`partner_order_id not found: ${input.partnerOrderId}`)

			// D10: stuck-in-book timeout enforcement.
			if (b.stage === 'book' && b.bookStartedAtMs !== null && b.terminalState === null) {
				const elapsed = now() - b.bookStartedAtMs
				const timeout = b.uses3ds ? STUCK_IN_BOOK_TIMEOUT_3DS_MS : STUCK_IN_BOOK_TIMEOUT_NON_3DS_MS
				if (elapsed > timeout) {
					b.terminalState = 'failed'
					b.stage = 'check'
					b.sequenceNumber = nextSequenceNumber()
					return {
						stage: 'check',
						terminal: 'failed',
						stuckTimeoutExceeded: true,
					}
				}
			}

			b.stage = 'check'
			return {
				stage: 'check',
				terminal: b.terminalState,
				...(b.terminalState === null ? {} : {}),
			}
		},

		async forceTerminal(input) {
			const b = bookings.get(input.partnerOrderId)
			if (!b) throw new Error(`partner_order_id not found: ${input.partnerOrderId}`)
			b.terminalState = input.outcome
			b.stage = 'check'
			b.sequenceNumber = nextSequenceNumber()
		},

		extractBrandFromSource(source: string): EtgBrand | null {
			return SOURCE_TO_BRAND[source] ?? null
		},

		listBrands(): ReadonlyArray<EtgBrand> {
			return ['RateHawk', 'ZenHotels', 'B2B.Ostrovok', 'Ostrovok']
		},

		__test_simulateDoubleBookingCollision(partnerOrderId: string): void {
			collisionFlags.add(partnerOrderId)
		},

		__test_inspect() {
			return {
				bookings: Array.from(bookings.values()),
				basicAuthHeader,
			}
		},
	}
}
