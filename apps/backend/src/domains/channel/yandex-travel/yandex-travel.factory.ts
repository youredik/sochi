/**
 * Yandex.Travel factory — M10 / A7.3 + Round 8 P0-1/P0-4/P1-5 fixes.
 *
 * Wires per-tenant YT Mock adapter (Bnovo CM passthrough emulation) +
 * HTTP attempt handler в channelFactory. Round 8 sweep landed:
 *
 *   - P0-1 (KILLER): handler now invokes the resolved adapter per `eventType`
 *     (was vacuous `{ok:true, httpStatus:200}` echo — `void adapter` antipattern
 *     across all 3 channel factories per Round 8 finding).
 *   - P0-4: reserved-test-range shield (RFC 2606/6761 emails + ITU-T E.164.3
 *     phones) per `feedback_outbound_side_effect_discipline_2026_05_22`.
 *     Short-circuits BEFORE adapter call → 0 burned upstream writes for
 *     synthetic test fixtures (Round 7 empirical: 32 × 5 deploys = 160 burned
 *     Postbox writes pre-shield).
 *   - P1-5: `logger.error` sanitization — `err.message` capped + structured
 *     `errCategory/errMessage/errName` keys; never echo raw `err` (which may
 *     contain guest PII в upstream API error responses).
 *
 * Live-flip path: swap factory body to instantiate a Bnovo HTTP client
 * (signed creds via YC Lockbox per D29). YT direct API self-build is FORBIDDEN
 * (breach of YT partner agreement per D6 + R2 #F4 research).
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
import { resolveDemoPropertyId } from '../../../lib/demo-channel-seed.ts'
import type { ChannelFactory } from '../channel.factory.ts'
import { createYandexTravelMock, YandexTravelApiError } from './yandex-travel-mock.ts'

export interface YandexTravelRegistrationOptions {
	/**
	 * Round 14.6.4 follow-up — `demoPropertyId` is DEPRECATED and IGNORED.
	 * Factory derives propertyId per-tenant via `resolveDemoPropertyId(orgId)`
	 * at adapter creation time (canon `feedback_round_14_6_per_tenant_demo_canon`
	 * — «derive identifiers from auth token, never mount-time»). Retained as
	 * optional field только для backward source-compat; future cleanup will drop
	 * the interface entirely once no external callers reference it.
	 */
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
 * Sanitize an Error instance for safe logging / surfacing. Never echoes raw
 * `err` (which может contain guest PII через upstream provider verbosity).
 */
function sanitizeError(err: unknown): {
	errName: string
	errMessage: string
	errCategory: ChannelErrorCategory
} {
	if (err instanceof YandexTravelApiError) {
		return {
			errName: err.name,
			errMessage: err.message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
			errCategory: err.category,
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
 * Narrow `payload` for guestSnapshot lookup (Round 8 P0-4 shield input).
 * Returns null when payload shape does not expose a guest — shield passes
 * through to adapter (e.g. ARI-only events have no guest).
 */
function extractGuestSnapshot(payload: unknown): GuestSnapshot | null {
	if (payload === null || typeof payload !== 'object') return null
	const p = payload as { guestSnapshot?: unknown }
	if (!p.guestSnapshot || typeof p.guestSnapshot !== 'object') return null
	const g = p.guestSnapshot as { email?: unknown; phone?: unknown }
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

function parseBookingCreatedPayload(
	payload: unknown,
	tenantId: string,
): BookingCreatedPayload | null {
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
	void tenantId
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
	// Trust caller's shape (interface enforced upstream by CDC fan-out emitter).
	// Light-weight guard: every entry MUST have sequenceNumber, otherwise reject.
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
			errorCategory: category,
			errorMessage: (firstError?.message ?? 'rejected').slice(0, ERROR_MESSAGE_MAX_LENGTH),
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
	const parsed = parseBookingCreatedPayload(payload, tenantId)
	if (parsed === null) {
		return {
			ok: false,
			httpStatus: 400,
			errorCategory: 'invalid_payload',
			errorMessage: 'booking.created payload missing required fields',
		}
	}
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
			errorCategory: 'invalid_payload',
			errorMessage: 'booking.cancelled payload missing externalId',
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
			errorCategory: 'not_found',
			errorMessage: 'reservation not found',
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
			errorCategory: 'invalid_payload',
			errorMessage: 'ari payload missing deltas[]',
		}
	}
	const result = await adapter.pushAri(deltas)
	return pushAriResultToHttpAttempt(result)
}

export function registerYandexTravelWithChannelFactory(
	channelFactory: ChannelFactory,
	_opts: YandexTravelRegistrationOptions = {},
): void {
	// Round 14.6.4 follow-up — derive propertyId per-tenant inside the factory
	// lambda. `opts.demoPropertyId` (deprecated) is intentionally ignored —
	// canonical 2026 pattern: never trust mount-time identifiers for per-tenant
	// state (см. `feedback_round_14_6_per_tenant_demo_canon`).
	channelFactory.registerAdapterFactory('YT', async ({ organizationId }) => {
		return createYandexTravelMock({
			tenantId: organizationId,
			propertyId: resolveDemoPropertyId(organizationId),
		})
	})

	channelFactory.registerHttpAttempt(
		'YT',
		async ({ tenantId, eventType, idempotencyKey, payload }) => {
			try {
				// P0-4 Round 8 — reserved-test-range shield BEFORE adapter call.
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
					channelId: 'YT',
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
							errorCategory: 'invalid_payload',
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
					'YandexTravel HTTP attempt error',
				)
				const httpStatus =
					err instanceof YandexTravelApiError
						? err.httpStatus
						: httpStatusForCategory(sanitized.errCategory)
				return {
					ok: false,
					httpStatus,
					errorCategory: sanitized.errCategory,
					errorMessage: sanitized.errMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH),
				}
			}
		},
	)
}
