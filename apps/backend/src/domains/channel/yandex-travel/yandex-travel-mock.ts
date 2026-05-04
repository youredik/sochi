/**
 * Yandex.Travel behaviour-faithful Mock — M10 / A7.3.
 *
 * Per `plans/m10_canonical.md` D6:
 *   "NO direct PMS API — Mock impersonates downstream of certified CM
 *    (canonical: Bnovo passthrough). Live-flip = onboard via partnered CM,
 *    not direct (self-build = breach of YT partner agreement)."
 *
 * **Architecture canon (post 2026-05-04 research)**:
 *
 *   - YT does NOT expose direct PMS API. Production access requires routing
 *     через one of 18 certified CMs (Bnovo, Channex, RateRunner, etc).
 *   - This Mock simulates the Bnovo passthrough surface: PMS → Bnovo → YT.
 *     Outbound: signed JSON POST с HMAC-SHA256, 300s replay window,
 *     IP-allowlist gate (production canon).
 *   - Inbound: YT pushes booking webhook via Bnovo gateway (D11 CloudEvents
 *     1.0.2 envelope). Mock receives, validates signature + envelope, returns
 *     idempotent acceptance.
 *   - Live-flip: swap factory body для real Bnovo connectivity (signed creds
 *     loaded from YC Lockbox per D29). Same canonical adapter interface.
 *
 * **152-ФЗ compliance gate (D17 + D19)**:
 *   - Storage residency: photo URLs MUST point to RU-resident hosts (yandex.ru,
 *     storage.yandexcloud.net). Non-RU URLs rejected (cross-border-transfer
 *     gate per D19).
 *   - Granular consent 3-checkbox per 1 Sept 2025 ст.10 152-ФЗ:
 *     (a) обработка ПДн / (b) передача отелю / (c) маркетинг.
 *
 * **Алиса AI discoverability** (D6.b — YT/Алиса 2026 canon):
 *   Hotel metadata MUST include `aiCompatibility.alisaSearchable=true` for
 *   conversational search. Fixture metadata exposes this.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
	AriDelta,
	AvailabilityQuery,
	AvailabilityRow,
	CancellationPolicy,
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
	parseCloudEvent,
	type SochiCloudEvent,
} from '../../../lib/channel-manager/cloud-events.ts'

const REPLAY_WINDOW_SECONDS = 300
const REPLAY_WINDOW_MS = REPLAY_WINDOW_SECONDS * 1000
const RU_RESIDENT_HOSTS = new Set([
	'yandex.ru',
	'yandex.cloud',
	'storage.yandexcloud.net',
	'avatars.mds.yandex.net',
	'mc.yandex.ru',
])

interface InternalReservation {
	readonly externalId: string
	readonly tenantId: string
	readonly propertyId: string
	readonly roomTypeId: string
	readonly ratePlanId: string
	readonly arrivalDate: string
	readonly departureDate: string
	readonly guestCount: number
	readonly totalAmountMicros: bigint
	readonly status: 'Confirmed' | 'Cancelled'
	readonly lastModificationUtc: string
	readonly guest: {
		readonly firstName: string
		readonly lastName: string
		readonly email?: string
		readonly phone?: string
	}
	/**
	 * Granular consent (D17). Booking flow MUST collect all 3 separately.
	 * Mock rejects on consent gap при receiveBookingWebhook.
	 */
	readonly consent: {
		readonly processing: boolean
		readonly transferToHotel: boolean
		readonly marketing: boolean
	}
}

interface PushedAriEntry {
	readonly idempotencyKey: string
	readonly delta: AriDelta
	readonly acceptedAtMs: number
}

const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
	referencePoint: 'GuestArrivalTime',
	hoursBeforeRef: 48,
	penaltyKind: 'first_night',
	penaltyValue: 1,
}

export interface YandexTravelMockOptions {
	readonly tenantId: string
	readonly propertyId: string
	/** Bnovo gateway HMAC secret. Mock generates if omitted. */
	readonly hmacSecret?: string
	/** Allowed inbound IPs (production canon). Empty default — Mock skips IP gate. */
	readonly allowedInboundIps?: ReadonlyArray<string>
	/** Default rate (RUB micros per night) used at verifyBooking. */
	readonly nightRateMicros?: bigint
	readonly seedAvailability?: ReadonlyArray<AvailabilityRow>
	readonly nowMs?: () => number
}

export interface YandexTravelMockHandle extends ChannelManagerAdapter {
	readonly emitReservationEvent: (reservation: InternalReservation) => SochiCloudEvent
	readonly signRequest: (input: { rawBody: Uint8Array | string; timestampSec: number }) => string
	readonly __test_seedReservation: (reservation: InternalReservation) => void
	readonly __test_listAriPushes: () => ReadonlyArray<PushedAriEntry>
	readonly __test_inspect: () => {
		readonly hmacSecret: string
		readonly reservations: ReadonlyArray<InternalReservation>
	}
}

/**
 * Compute canonical signature: HMAC-SHA256 over `${timestamp}.${rawBody}` —
 * Bnovo gateway canon (mirrors Standard Webhooks shape без `webhookId` part,
 * since YT/Bnovo identifies каналы via authenticated TLS endpoint).
 */
export function computeYtSignature(input: {
	timestampSec: number
	rawBody: Uint8Array | string
	secret: string
}): string {
	const bodyBuf =
		typeof input.rawBody === 'string'
			? Buffer.from(input.rawBody, 'utf-8')
			: Buffer.from(input.rawBody)
	const signedString = Buffer.concat([Buffer.from(`${input.timestampSec}.`, 'utf-8'), bodyBuf])
	return createHmac('sha256', input.secret).update(signedString).digest('base64')
}

/**
 * Verify photo URLs are RU-resident (152-ФЗ ст. 18 ч. 5 since 1 July 2025).
 * Returns first non-RU host found, or null if all clean.
 */
export function findNonRuHost(urls: ReadonlyArray<string>): string | null {
	for (const u of urls) {
		try {
			const parsed = new URL(u)
			const host = parsed.hostname.toLowerCase()
			const matchedRu = Array.from(RU_RESIDENT_HOSTS).some(
				(ru) => host === ru || host.endsWith(`.${ru}`),
			)
			if (!matchedRu) return host
		} catch {
			return u // malformed URL → reject as non-RU
		}
	}
	return null
}

export function createYandexTravelMock(opts: YandexTravelMockOptions): YandexTravelMockHandle {
	const now = opts.nowMs ?? (() => Date.now())
	const hmacSecret = opts.hmacSecret ?? `yt-mock-secret-${randomUUID()}`
	const nightRateMicros = opts.nightRateMicros ?? 6_000_000n
	const seedAvailability = opts.seedAvailability ?? []
	const reservations = new Map<string, InternalReservation>()
	const ariPushes: PushedAriEntry[] = []
	const ariIdempotencyIndex = new Set<string>()

	const metadata: ChannelMetadata = {
		channelId: 'YT',
		mode: 'mock',
		role: 'independent_operator', // D18: YT/Ostrovok = independent operator
		displayName: 'Яндекс.Путешествия (Mock — Bnovo passthrough)',
	}

	function buildAriIdempotencyKey(delta: AriDelta): string {
		return `${delta.tenantId}:${delta.propertyId}:${delta.roomTypeId}:${delta.ratePlanId}:${delta.date}`
	}

	function pushOne(delta: AriDelta): { accepted: boolean; idempotencyKey: string } {
		const key = buildAriIdempotencyKey(delta)
		if (ariIdempotencyIndex.has(key)) {
			return { accepted: false, idempotencyKey: key } // already-seen → idempotent ack
		}
		ariIdempotencyIndex.add(key)
		ariPushes.push({ idempotencyKey: key, delta, acceptedAtMs: now() })
		return { accepted: true, idempotencyKey: key }
	}

	const adapter: ChannelManagerAdapter = {
		metadata,

		async pushAri(delta: ReadonlyArray<AriDelta>) {
			let accepted = 0
			for (const d of delta) {
				const r = pushOne(d)
				if (r.accepted) accepted++
			}
			return { accepted, rejected: 0 }
		},

		async pushAriFull(snapshot: ReadonlyArray<AriDelta>) {
			// Full snapshot — clear idempotency index, re-push everything.
			ariIdempotencyIndex.clear()
			ariPushes.length = 0
			for (const d of snapshot) pushOne(d)
			return { accepted: snapshot.length, rejected: 0 }
		},

		// YT не exposes search-availability к partners (PMS sets ARI; users see).
		// Mock returns from seed fixture for symmetry с TL.
		async searchAvailability(query: AvailabilityQuery): Promise<ReadonlyArray<AvailabilityRow>> {
			return seedAvailability.filter((row) => {
				return row.date >= query.checkIn && row.date < query.checkOut
			})
		},

		// YT pushes reservations via webhook (NOT polling) → readReservations empty.
		async readReservations(_cursor: ReservationReadCursor) {
			return { reservations: [] as ReadonlyArray<ChannelReservation>, hasMore: false }
		},

		async verifyBooking(input: VerifyBookingInput): Promise<VerifyBookingResult> {
			const arrival = new Date(input.checkIn).getTime()
			const departure = new Date(input.checkOut).getTime()
			const nights = Math.max(1, Math.round((departure - arrival) / (24 * 60 * 60 * 1000)))
			const total = nightRateMicros * BigInt(nights) * BigInt(input.guestCount)
			return {
				createBookingToken: randomUUID(),
				checksum: createHmac('sha256', hmacSecret)
					.update(`${input.checkIn}|${input.checkOut}|${total.toString()}`)
					.digest('hex'),
				expiresAtUtc: new Date(now() + 30 * 60_000).toISOString(),
				totalAmountMicros: total,
				cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
			}
		},

		async createBooking(input: CreateBookingInput): Promise<{ readonly externalId: string }> {
			const externalId = `yt-res-${randomUUID().slice(0, 12)}`
			reservations.set(externalId, {
				externalId,
				tenantId: opts.tenantId,
				propertyId: opts.propertyId,
				roomTypeId: 'yt_rt',
				ratePlanId: 'yt_rp',
				arrivalDate: '2027-06-15',
				departureDate: '2027-06-17',
				guestCount: 1,
				totalAmountMicros: input.verifyResult.totalAmountMicros,
				status: 'Confirmed',
				lastModificationUtc: new Date(now()).toISOString(),
				guest: { firstName: 'YT', lastName: 'Guest' },
				consent: { processing: true, transferToHotel: true, marketing: false },
			})
			return { externalId }
		},

		async cancelReservation(input: { readonly tenantId: string; readonly externalId: string }) {
			if (input.tenantId !== opts.tenantId) return { status: 'not_found' as const }
			const r = reservations.get(input.externalId)
			if (!r) return { status: 'not_found' as const }
			if (r.status === 'Cancelled') return { status: 'already_cancelled' as const }
			reservations.set(input.externalId, {
				...r,
				status: 'Cancelled',
				lastModificationUtc: new Date(now()).toISOString(),
			})
			return { status: 'cancelled' as const }
		},

		async calculateCancellationPenalty(input: {
			readonly tenantId: string
			readonly externalId: string
		}) {
			if (input.tenantId !== opts.tenantId) return { penaltyMicros: 0n }
			const r = reservations.get(input.externalId)
			if (!r) return { penaltyMicros: 0n }
			const arrival = new Date(r.arrivalDate).getTime()
			const departure = new Date(r.departureDate).getTime()
			const nights = Math.max(1, Math.round((departure - arrival) / (24 * 60 * 60 * 1000)))
			return { penaltyMicros: r.totalAmountMicros / BigInt(nights) }
		},

		// Inbound webhook (YT → Bnovo → us). Validates signature, replay window,
		// IP allowlist (when configured), CloudEvents envelope, granular consent.
		async receiveBookingWebhook(input) {
			// Step 1 — signature verify (HMAC-SHA256 + 300s replay window).
			const tsHeader = input.headers['x-yt-timestamp'] ?? input.headers['X-YT-Timestamp']
			const sigHeader = input.headers['x-yt-signature'] ?? input.headers['X-YT-Signature']
			if (typeof tsHeader !== 'string' || tsHeader.length === 0) {
				return { ok: false, reason: 'missing_timestamp', httpStatus: 400 }
			}
			if (typeof sigHeader !== 'string' || sigHeader.length === 0) {
				return { ok: false, reason: 'missing_signature', httpStatus: 400 }
			}
			const ts = Number.parseInt(tsHeader, 10)
			if (!Number.isFinite(ts)) {
				return { ok: false, reason: 'malformed_timestamp', httpStatus: 400 }
			}
			const skewMs = Math.abs(now() - ts * 1000)
			if (skewMs > REPLAY_WINDOW_MS) {
				return { ok: false, reason: 'replay_window_exceeded', httpStatus: 403 }
			}
			const expectedSig = computeYtSignature({
				timestampSec: ts,
				rawBody: input.rawBody,
				secret: hmacSecret,
			})
			const expectedBuf = Buffer.from(expectedSig, 'base64')
			const providedBuf = Buffer.from(sigHeader, 'base64')
			if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
				return { ok: false, reason: 'invalid_signature', httpStatus: 401 }
			}

			// Step 2 — IP-allowlist gate (D25.c, production canon).
			if (opts.allowedInboundIps && opts.allowedInboundIps.length > 0) {
				if (input.clientIp === undefined || !opts.allowedInboundIps.includes(input.clientIp)) {
					return { ok: false, reason: 'ip_not_allowed', httpStatus: 401 }
				}
			}

			// Step 3 — CloudEvents envelope parse.
			const decoder = new TextDecoder('utf-8', { fatal: false })
			let parsed: unknown
			try {
				parsed = JSON.parse(decoder.decode(input.rawBody))
			} catch {
				return { ok: false, reason: 'malformed_json', httpStatus: 400 }
			}
			const event = parseCloudEvent(parsed)
			if (event === null) {
				return { ok: false, reason: 'malformed_envelope', httpStatus: 400 }
			}

			// Step 4 — payload guard: granular consent 3-checkbox (D17) + photo
			// residency (152-ФЗ ст. 18 ч. 5) when provided.
			const data = event.data as Record<string, unknown> | undefined
			if (data) {
				const consent = data.consent as Record<string, unknown> | undefined
				if (!consent || consent.processing !== true || consent.transferToHotel !== true) {
					return { ok: false, reason: 'consent_missing_required_checkboxes', httpStatus: 422 }
				}
				const photos = Array.isArray(data.photoUrls) ? (data.photoUrls as string[]) : []
				const nonRu = findNonRuHost(photos)
				if (nonRu !== null) {
					return {
						ok: false,
						reason: `non_ru_photo_host:${nonRu}`,
						httpStatus: 422,
					}
				}
				// Currency must be RUB (Russian market exclusive).
				if (data.currency !== undefined && data.currency !== 'RUB') {
					return { ok: false, reason: 'non_rub_currency', httpStatus: 422 }
				}
			}

			return { ok: true, event }
		},
	}

	return {
		...adapter,
		emitReservationEvent(reservation: InternalReservation): SochiCloudEvent {
			return buildCloudEvent({
				id: reservation.externalId,
				source: buildSourceUrn({ channelCode: 'YT', organizationId: opts.tenantId }),
				type: buildEventType({
					entity: 'booking',
					action: reservation.status === 'Confirmed' ? 'created' : 'cancelled',
					version: 'v1',
				}),
				subject: reservation.externalId,
				datacontenttype: 'application/json',
				data: reservation,
			})
		},
		signRequest(input) {
			return computeYtSignature({
				timestampSec: input.timestampSec,
				rawBody: input.rawBody,
				secret: hmacSecret,
			})
		},
		__test_seedReservation(reservation: InternalReservation) {
			reservations.set(reservation.externalId, reservation)
		},
		__test_listAriPushes(): ReadonlyArray<PushedAriEntry> {
			return ariPushes.slice()
		},
		__test_inspect() {
			return {
				hmacSecret,
				reservations: Array.from(reservations.values()),
			}
		},
	}
}
