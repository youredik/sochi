/**
 * TravelLine factory — M10 / A7.2 + Round 8 P0-1/P0-4/P1-5 fixes.
 *
 * Wires per-tenant TL Mock adapter + HTTP attempt handler в channelFactory.
 * Round 8 sweep landed:
 *
 *   - P0-1 (KILLER): handler now invokes the resolved adapter per `eventType`
 *     (was vacuous `{ok:true, httpStatus:200}` echo — `void adapter` antipattern
 *     across all 3 channel factories per Round 8 finding).
 *   - P0-4: reserved-test-range shield (RFC 2606/6761 emails + ITU-T E.164.3
 *     phones) per `feedback_outbound_side_effect_discipline_2026_05_22`.
 *     Short-circuits BEFORE adapter call → 0 burned upstream writes for
 *     synthetic test fixtures.
 *   - P1-5: `logger.error` sanitization — `err.message` capped + structured
 *     `errCategory/errMessage/errName` keys; never echo raw `err` (which may
 *     contain guest PII в upstream API error responses).
 *
 * Live-flip path: swap factory body to instantiate live TL HTTP client (signed
 * creds via YC Lockbox per D29). **TL polling-based canon (D1/D2)**: TravelLine
 * is **source-of-truth** для ARI и **polling-not-webhook** для reservations.
 * `pushAri` here exists для symmetry с the canonical `ChannelManagerAdapter`
 * interface — наш Mock validates sequenceNumber monotonicity per-resource
 * (Round 8 P1-1) and returns `accepted: count` so live-flip к real TL writer
 * is a no-op factory swap.
 *
 * Mirrors `yandex-travel.factory.ts` Round 8 convention так что dispatcher
 * sees uniform error envelope across all channels.
 */

import type {
	AriDelta,
	AriPushResult,
	ChannelAdapterError,
	ChannelErrorCategory,
	ChannelManagerAdapter,
} from '../../../lib/channel-manager/adapter.ts'
import { logger } from '../../../logger.ts'
import type { HttpAttemptResult } from '../../../workers/channel-dispatcher.ts'
import {
	isReservedTestDomain,
	isReservedTestPhone,
} from '../../../workers/lib/reserved-test-ranges.ts'
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
 * Cap on error-message length surfaced в HttpAttemptResult / logger payload.
 * Defends against upstream API echoing guest PII в free-text errors.
 */
const ERROR_MESSAGE_MAX_LENGTH = 200

/**
 * Map canonical `ChannelErrorCategory` → HTTP status used by the dispatcher
 * to choose retry vs DLQ (per `isRetryableFailure` in channel-dispatch.ts).
 */
function httpStatusForCategory(category: ChannelErrorCategory): number {
	switch (category) {
		case 'rate_limited':
			return 429
		case 'invalid_credentials':
			return 401
		case 'cross_border_blocked':
			return 451
		case 'consent_missing':
			return 422
		case 'reserved_test_range':
			return 200 // shielded — not a failure
		case 'duplicate_idempotency_key':
			return 200 // idempotent ack — treat as success
		case 'invalid_payload':
			return 422
		case 'not_found':
			return 404
		case 'transient':
			return 503
		case 'unknown':
			return 500
	}
}

/**
 * Map TL canonical errorCode → `ChannelErrorCategory`. TL surface is small —
 * checksum mismatch / token used / token expired / rate limited.
 */
function mapTravellineErrorCodeToCategory(code: string): ChannelErrorCategory {
	switch (code) {
		case 'CHECKSUM_MISMATCH':
		case 'INVALID_REQUEST':
			return 'invalid_payload'
		case 'TOKEN_USED':
			return 'duplicate_idempotency_key'
		case 'TOKEN_EXPIRED':
			return 'transient'
		case 'RATE_LIMITED':
			return 'rate_limited'
		default:
			return 'unknown'
	}
}

/**
 * Sanitize an Error instance for safe logging / surfacing. Never echoes raw
 * `err` (which может contain guest PII через upstream provider verbosity).
 */
function sanitizeError(err: unknown): {
	errName: string
	errMessage: string
	errCategory: ChannelErrorCategory
} {
	if (err instanceof TravellineRateLimitError) {
		return {
			errName: err.name,
			errMessage: err.message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
			errCategory: 'rate_limited',
		}
	}
	if (err instanceof TravellineApiError) {
		return {
			errName: err.name,
			errMessage: err.message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
			errCategory: mapTravellineErrorCodeToCategory(err.errorCode),
		}
	}
	if (err instanceof Error) {
		return {
			errName: err.name,
			errMessage: err.message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
			errCategory: 'unknown',
		}
	}
	return { errName: 'NonError', errMessage: 'unknown_error', errCategory: 'unknown' }
}

interface GuestSnapshot {
	readonly email?: string
	readonly phone?: string
}

/**
 * Narrow `payload` для guestSnapshot lookup (Round 8 P0-4 shield input).
 * Returns null when payload shape does not expose a guest — shield passes
 * through to adapter (e.g. ARI-only events have no guest).
 *
 * Accepts both `payload.guestSnapshot.{email,phone}` and `payload.guest.{...}`
 * shapes so any upstream emitter convention works.
 */
function extractGuestSnapshot(payload: unknown): GuestSnapshot | null {
	if (payload === null || typeof payload !== 'object') return null
	const p = payload as { guestSnapshot?: unknown; guest?: unknown }
	const src = p.guestSnapshot ?? p.guest
	if (!src || typeof src !== 'object') return null
	const g = src as { email?: unknown; phone?: unknown }
	const out: { email?: string; phone?: string } = {}
	if (typeof g.email === 'string') out.email = g.email
	if (typeof g.phone === 'string') out.phone = g.phone
	return out
}

/**
 * Reserved-test-range shield (P0-4). Returns true if outbound dispatch must
 * short-circuit because guest contact info is в RFC 2606/6761 / ITU-T E.164.3
 * reserved space — guaranteed never deliverable, MTA reputation damage avoided.
 */
function isShieldedTestRecipient(snap: GuestSnapshot | null): boolean {
	if (snap === null) return false
	if (snap.email !== undefined && isReservedTestDomain(snap.email)) return true
	if (snap.phone !== undefined && isReservedTestPhone(snap.phone)) return true
	return false
}

interface BookingCreatedPayload {
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

function parseBookingCreatedPayload(payload: unknown): BookingCreatedPayload | null {
	if (payload === null || typeof payload !== 'object') return null
	const p = payload as Record<string, unknown>
	const snap = (p.guestSnapshot ?? p.guest) as Record<string, unknown> | undefined
	if (!snap) return null
	const firstName = typeof snap.firstName === 'string' ? snap.firstName : null
	const lastName = typeof snap.lastName === 'string' ? snap.lastName : null
	const email = typeof snap.email === 'string' ? snap.email : null
	const phone = typeof snap.phone === 'string' ? snap.phone : null
	if (!firstName || !lastName || !email || !phone) return null
	if (typeof p.propertyId !== 'string') return null
	if (typeof p.roomTypeId !== 'string') return null
	if (typeof p.ratePlanId !== 'string') return null
	if (typeof p.checkIn !== 'string') return null
	if (typeof p.checkOut !== 'string') return null
	const guestCount = typeof p.guestCount === 'number' ? p.guestCount : null
	if (guestCount === null) return null
	return {
		propertyId: p.propertyId,
		roomTypeId: p.roomTypeId,
		ratePlanId: p.ratePlanId,
		checkIn: p.checkIn,
		checkOut: p.checkOut,
		guestCount,
		guest: { firstName, lastName, email, phone },
	}
}

function parseDeltasPayload(payload: unknown): ReadonlyArray<AriDelta> | null {
	if (payload === null || typeof payload !== 'object') return null
	const p = payload as { deltas?: unknown }
	if (!Array.isArray(p.deltas)) return null
	const out: AriDelta[] = []
	for (const d of p.deltas) {
		if (d === null || typeof d !== 'object') return null
		const dd = d as Record<string, unknown>
		// sequenceNumber може быть bigint OR string (JSON serialization). Coerce.
		const seqRaw = dd.sequenceNumber
		let seq: bigint
		if (typeof seqRaw === 'bigint') seq = seqRaw
		else if (typeof seqRaw === 'string') {
			try {
				seq = BigInt(seqRaw)
			} catch {
				return null
			}
		} else if (typeof seqRaw === 'number') seq = BigInt(seqRaw)
		else return null
		const rateRaw = dd.rateMicros
		let rate: bigint
		if (typeof rateRaw === 'bigint') rate = rateRaw
		else if (typeof rateRaw === 'string') {
			try {
				rate = BigInt(rateRaw)
			} catch {
				return null
			}
		} else if (typeof rateRaw === 'number') rate = BigInt(rateRaw)
		else return null
		if (
			typeof dd.tenantId !== 'string' ||
			typeof dd.propertyId !== 'string' ||
			typeof dd.date !== 'string' ||
			typeof dd.roomTypeId !== 'string' ||
			typeof dd.ratePlanId !== 'string' ||
			typeof dd.availability !== 'number' ||
			dd.currency !== 'RUB'
		) {
			return null
		}
		const base = {
			tenantId: dd.tenantId,
			propertyId: dd.propertyId,
			date: dd.date,
			roomTypeId: dd.roomTypeId,
			ratePlanId: dd.ratePlanId,
			availability: dd.availability,
			rateMicros: rate,
			currency: 'RUB' as const,
			sequenceNumber: seq,
		}
		const entry: AriDelta =
			dd.restrictions !== undefined && typeof dd.restrictions === 'object'
				? {
						...base,
						restrictions: dd.restrictions as NonNullable<AriDelta['restrictions']>,
					}
				: base
		out.push(entry)
	}
	return out
}

interface BookingCancelledPayload {
	readonly externalId: string
}

function parseBookingCancelledPayload(payload: unknown): BookingCancelledPayload | null {
	if (payload === null || typeof payload !== 'object') return null
	const p = payload as { externalId?: unknown }
	if (typeof p.externalId !== 'string' || p.externalId.length === 0) return null
	return { externalId: p.externalId }
}

function pushAriResultToHttpAttempt(result: AriPushResult): HttpAttemptResult {
	if (result.rejected === 0) {
		return {
			ok: true,
			httpStatus: 200,
			responseBody: { accepted: result.accepted, rejected: 0 },
		}
	}
	if (result.accepted === 0) {
		// All rejected — treat as 4xx so dispatcher DLQs without retry.
		const firstError: ChannelAdapterError | undefined = result.errors[0]
		const category: ChannelErrorCategory = firstError?.category ?? 'invalid_payload'
		const httpStatus = httpStatusForCategory(category)
		return {
			ok: false,
			httpStatus,
			errorMessage: `[category=${category}] ${firstError?.message ?? 'rejected'}`.slice(
				0,
				ERROR_MESSAGE_MAX_LENGTH,
			),
			responseBody: {
				accepted: 0,
				rejected: result.rejected,
				errors: result.errors.map((e) => ({ category: e.category, itemIndex: e.itemIndex })),
			},
		}
	}
	// Partial success — treat as 200 (mark sent), но surface counts.
	return {
		ok: true,
		httpStatus: 200,
		responseBody: {
			accepted: result.accepted,
			rejected: result.rejected,
			errors: result.errors.map((e) => ({ category: e.category, itemIndex: e.itemIndex })),
		},
	}
}

async function dispatchBookingCreated(
	adapter: ChannelManagerAdapter,
	tenantId: string,
	idempotencyKey: string,
	payload: unknown,
): Promise<HttpAttemptResult> {
	const parsed = parseBookingCreatedPayload(payload)
	if (parsed === null) {
		return {
			ok: false,
			httpStatus: 400,
			errorMessage: '[category=invalid_payload] booking.created payload missing required fields',
		}
	}
	// TL canonical D4: verify → create two-step.
	const verify = await adapter.verifyBooking({
		tenantId,
		propertyId: parsed.propertyId,
		roomTypeId: parsed.roomTypeId,
		ratePlanId: parsed.ratePlanId,
		checkIn: parsed.checkIn,
		checkOut: parsed.checkOut,
		guestCount: parsed.guestCount,
		guest: parsed.guest,
	})
	const created = await adapter.createBooking({ verifyResult: verify, idempotencyKey })
	return {
		ok: true,
		httpStatus: 200,
		responseBody: { externalId: created.externalId },
	}
}

async function dispatchBookingCancelled(
	adapter: ChannelManagerAdapter,
	tenantId: string,
	idempotencyKey: string,
	payload: unknown,
): Promise<HttpAttemptResult> {
	const parsed = parseBookingCancelledPayload(payload)
	if (parsed === null) {
		return {
			ok: false,
			httpStatus: 400,
			errorMessage: '[category=invalid_payload] booking.cancelled payload missing externalId',
		}
	}
	const result = await adapter.cancelReservation({
		tenantId,
		externalId: parsed.externalId,
		idempotencyKey,
	})
	if (result.status === 'not_found') {
		return {
			ok: false,
			httpStatus: 404,
			errorMessage: '[category=not_found] reservation not found',
			responseBody: { status: 'not_found' },
		}
	}
	// `cancelled` and `already_cancelled` both → 200 (idempotent ack).
	return {
		ok: true,
		httpStatus: 200,
		responseBody: { status: result.status },
	}
}

async function dispatchAriDelta(
	adapter: ChannelManagerAdapter,
	payload: unknown,
): Promise<HttpAttemptResult> {
	const deltas = parseDeltasPayload(payload)
	if (deltas === null) {
		return {
			ok: false,
			httpStatus: 400,
			errorMessage: '[category=invalid_payload] ari payload missing deltas[]',
		}
	}
	const result = await adapter.pushAri(deltas)
	return pushAriResultToHttpAttempt(result)
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
				// P0-4 Round 8 — reserved-test-range shield BEFORE adapter call.
				// Defense-in-depth: даже Mock mode защищён, so test fixtures behave
				// identically pre- и post- live-flip.
				const guestSnap = extractGuestSnapshot(payload)
				if (isShieldedTestRecipient(guestSnap)) {
					return {
						ok: true,
						httpStatus: 200,
						responseBody: 'reserved_test_range_shielded',
					}
				}

				const adapter = await channelFactory.resolveAdapter({
					organizationId: tenantId,
					channelId: 'TL',
				})

				switch (eventType) {
					case 'app.sochi.channel.booking.created.v1':
						return await dispatchBookingCreated(adapter, tenantId, idempotencyKey, payload)
					case 'app.sochi.channel.booking.cancelled.v1':
						return await dispatchBookingCancelled(adapter, tenantId, idempotencyKey, payload)
					case 'app.sochi.channel.ari.delta.v1':
					case 'app.sochi.channel.inventory.adjusted.v1':
					case 'app.sochi.channel.rate.changed.v1':
					case 'app.sochi.channel.restriction.changed.v1':
						return await dispatchAriDelta(adapter, payload)
					default:
						return {
							ok: false,
							httpStatus: 400,
							errorMessage: `unknown_event_type: ${eventType}`,
						}
				}
			} catch (err) {
				const sanitized = sanitizeError(err)
				// P1-5 Round 8 — no raw `err` (may contain upstream PII echo).
				logger.error(
					{
						tenantId,
						eventType,
						idempotencyKey,
						errName: sanitized.errName,
						errMessage: sanitized.errMessage,
						errCategory: sanitized.errCategory,
					},
					'TravelLine HTTP attempt error',
				)
				const httpStatus =
					err instanceof TravellineApiError
						? err.httpStatus
						: err instanceof TravellineRateLimitError
							? 429
							: httpStatusForCategory(sanitized.errCategory)
				return {
					ok: false,
					httpStatus,
					errorMessage: `[category=${sanitized.errCategory}] ${sanitized.errMessage}`.slice(
						0,
						ERROR_MESSAGE_MAX_LENGTH,
					),
				}
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
