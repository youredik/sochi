/**
 * Ostrovok ETG factory — M10 / A7.4.
 *
 * Wires per-tenant ETG Mock + HTTP attempt handler в channelFactory.
 * Live-flip: swap factory body to instantiate raw HTTP client with Basic Auth
 * via YC Lockbox creds (ETG SDK does not exist on npm — confirmed empirical 2026-05-04).
 *
 * **Round 8 canon (per `feedback_round_8_strict_sweep_canon_2026_05_25.md`)**:
 *   - P0-1: httpAttempt INVOKES the resolved adapter (NOT vacuous `{ok:true}` echo).
 *     Map per eventType:
 *       - booking.created.v1     → verifyBooking → createBooking
 *       - booking.cancelled.v1   → cancelReservation(idempotencyKey)
 *       - inventory.adjusted.v1  → pushAri(deltas)
 *       - rate.changed.v1        → pushAri(deltas)
 *       - restriction.changed.v1 → pushAri(deltas)
 *       - ari.delta.v1           → pushAri(deltas) (legacy single-flag retained)
 *   - P0-4: reserved-test-range shield — short-circuit на RFC2606/E.164.3 ranges
 *     BEFORE adapter call (per `feedback_outbound_side_effect_discipline_2026_05_22`).
 *   - P1-5: sanitize errors at logger boundary — never log raw PII (email/phone).
 */

import {
	isReservedTestDomain,
	isReservedTestPhone,
} from '../../../workers/lib/reserved-test-ranges.ts'
import type { ChannelErrorCategory } from '../../../lib/channel-manager/adapter.ts'
import { resolveDemoPropertyId } from '../../../lib/demo-channel-seed.ts'
import { logger } from '../../../logger.ts'
import type { HttpAttemptResult } from '../../../workers/channel-dispatcher.ts'
import type { ChannelFactory } from '../channel.factory.ts'
import { createOstrovokEtgMock } from './ostrovok-etg-mock.ts'

export interface OstrovokEtgRegistrationOptions {
	/**
	 * Round 14.6.4 follow-up — DEPRECATED + IGNORED. Factory derives
	 * propertyId per-tenant via `resolveDemoPropertyId(orgId)` at adapter
	 * creation time (canonical 2026 multi-tenant pattern).
	 */
	readonly demoPropertyId?: string
	readonly mode?: 'sandbox' | 'live'
}

/**
 * Sanitize PII (email/phone) before logging. Per Round 8 P1-5 canon —
 * никогда не пускать raw PII в logger payloads. Replaces email-shaped
 * tokens с `<email>` and phone-shaped digit runs с `<phone>`.
 */
function sanitizePiiForLogging(input: string): string {
	const stripped = input
		// Email addresses (RFC 5322 simplified — local@domain.tld)
		.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '<email>')
		// International phone-like sequences: optional `+`, 7-15 digits, allow common separators
		.replace(/\+?\d[\d\s().-]{6,15}\d/g, '<phone>')
	return stripped
}

/**
 * Per-resource ARI shield: if any guest in the snapshot uses an email-domain
 * или phone in reserved-test ranges, the entire batch is shielded
 * (`reserved_test_range`). Returns true if shield triggered.
 */
function guestSnapshotShielded(
	guest: { readonly email?: unknown; readonly phone?: unknown } | undefined,
): boolean {
	if (!guest) return false
	if (typeof guest.email === 'string' && isReservedTestDomain(guest.email)) return true
	if (typeof guest.phone === 'string' && isReservedTestPhone(guest.phone)) return true
	return false
}

function shieldedOk(): HttpAttemptResult {
	return {
		ok: true,
		httpStatus: 200,
		responseBody: 'reserved_test_range_shielded',
	}
}

function classifyAdapterErrorMessage(message: string): ChannelErrorCategory {
	const lower = message.toLowerCase()
	if (lower.includes('rate_limited') || lower.includes('rate limit')) return 'rate_limited'
	if (lower.includes('credentials') || lower.includes('unauthorized')) return 'invalid_credentials'
	if (lower.includes('cross_border') || lower.includes('non_ru')) return 'cross_border_blocked'
	if (lower.includes('consent')) return 'consent_missing'
	if (lower.includes('cross_tenant') || lower.includes('not_found')) return 'not_found'
	if (lower.includes('idempot')) return 'duplicate_idempotency_key'
	if (lower.includes('invalid') || lower.includes('malformed')) return 'invalid_payload'
	return 'unknown'
}

export function registerOstrovokEtgWithChannelFactory(
	channelFactory: ChannelFactory,
	opts: OstrovokEtgRegistrationOptions = {},
): void {
	const mode = opts.mode ?? 'sandbox'

	// Round 14.6.4 follow-up — derive propertyId per-tenant. `opts.demoPropertyId`
	// (deprecated) is intentionally ignored (см. interface docstring).
	channelFactory.registerAdapterFactory('ETG', async ({ organizationId }) => {
		return createOstrovokEtgMock({
			tenantId: organizationId,
			propertyId: resolveDemoPropertyId(organizationId),
			mode,
		})
	})

	channelFactory.registerHttpAttempt(
		'ETG',
		async ({ tenantId, eventType, idempotencyKey, payload }): Promise<HttpAttemptResult> => {
			try {
				const adapter = await channelFactory.resolveAdapter({
					organizationId: tenantId,
					channelId: 'ETG',
				})
				const data = (payload ?? {}) as Record<string, unknown>

				switch (eventType) {
					case 'app.sochi.channel.booking.created.v1': {
						const guestSnapshot = data.guestSnapshot as Record<string, unknown> | undefined
						// P0-4 reserved-test-range shield: short-circuit BEFORE adapter call.
						if (guestSnapshotShielded(guestSnapshot)) {
							return shieldedOk()
						}
						const checkIn = data.checkIn as string | undefined
						const checkOut = data.checkOut as string | undefined
						const propertyId = data.propertyId as string | undefined
						const roomTypeId = data.roomTypeId as string | undefined
						const ratePlanId = data.ratePlanId as string | undefined
						const guestCount = data.guestCount as number | undefined
						if (
							!checkIn ||
							!checkOut ||
							!propertyId ||
							!roomTypeId ||
							!ratePlanId ||
							typeof guestCount !== 'number' ||
							!guestSnapshot
						) {
							return {
								ok: false,
								httpStatus: 400,
								errorMessage: 'invalid_payload: missing required booking fields',
								errorCategory: 'invalid_payload',
							}
						}
						const verifyResult = await adapter.verifyBooking({
							tenantId,
							propertyId,
							roomTypeId,
							ratePlanId,
							checkIn,
							checkOut,
							guestCount,
							guest: {
								firstName: String(guestSnapshot.firstName ?? ''),
								lastName: String(guestSnapshot.lastName ?? ''),
								email: String(guestSnapshot.email ?? ''),
								phone: String(guestSnapshot.phone ?? ''),
							},
						})
						const createResult = await adapter.createBooking({
							verifyResult,
							idempotencyKey,
						})
						return {
							ok: true,
							httpStatus: 200,
							responseBody: { externalId: createResult.externalId },
						}
					}

					case 'app.sochi.channel.booking.cancelled.v1': {
						const externalId = data.externalId as string | undefined
						if (!externalId || typeof externalId !== 'string') {
							return {
								ok: false,
								httpStatus: 400,
								errorMessage: 'invalid_payload: missing externalId',
								errorCategory: 'invalid_payload',
							}
						}
						const cancelResult = await adapter.cancelReservation({
							tenantId,
							externalId,
							idempotencyKey,
						})
						return {
							ok: true,
							httpStatus: 200,
							responseBody: { status: cancelResult.status },
						}
					}

					case 'app.sochi.channel.inventory.adjusted.v1':
					case 'app.sochi.channel.rate.changed.v1':
					case 'app.sochi.channel.restriction.changed.v1':
					case 'app.sochi.channel.ari.delta.v1': {
						const rawDeltas = data.deltas
						if (!Array.isArray(rawDeltas)) {
							return {
								ok: false,
								httpStatus: 400,
								errorMessage: 'invalid_payload: missing deltas[]',
								errorCategory: 'invalid_payload',
							}
						}
						// AriDelta carries no PII — no shield needed.
						const pushResult = await adapter.pushAri(rawDeltas)
						if (pushResult.accepted === 0 && pushResult.rejected > 0) {
							// All rejected — treat as 4xx for dispatcher (no retry на bad payload).
							const firstErr = pushResult.errors[0]
							const category: ChannelErrorCategory = firstErr?.category ?? 'invalid_payload'
							return {
								ok: false,
								httpStatus: 422,
								errorMessage: `pushAri all rejected: ${category} (${pushResult.rejected} item(s))`,
								errorCategory: category,
								responseBody: {
									accepted: pushResult.accepted,
									rejected: pushResult.rejected,
								},
							}
						}
						return {
							ok: true,
							httpStatus: 200,
							responseBody: {
								accepted: pushResult.accepted,
								rejected: pushResult.rejected,
							},
						}
					}

					default:
						return {
							ok: false,
							httpStatus: 400,
							errorMessage: `unknown_event_type: ${eventType}`,
							errorCategory: 'invalid_payload',
						}
				}
			} catch (err) {
				const rawMsg = err instanceof Error ? err.message : 'unknown_error'
				const sanitizedMsg = sanitizePiiForLogging(rawMsg)
				const category = classifyAdapterErrorMessage(rawMsg)
				logger.error(
					{ tenantId, eventType, errorMessage: sanitizedMsg, errorCategory: category },
					'OstrovokEtg HTTP attempt failed',
				)
				return {
					ok: false,
					httpStatus: null,
					errorMessage: sanitizedMsg,
					errorCategory: category,
				}
			}
		},
	)
}
