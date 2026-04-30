/**
 * Public widget booking-create orchestration service (M9.widget.4 / Track A2).
 *
 * Per `plans/m9_widget_4_canonical.md` §3 integration map:
 *   - Widget = thin anonymous wrapper composing existing domain services.
 *   - NO domain rewrites. Existing booking/guest/payment services do all the
 *     heavy lifting (ARI invariants, fee snapshots, tourism tax, registration
 *     status, payment SM, idempotency UNIQUE dedup).
 *   - CDC consumers auto-trigger от `booking.created` event: folio_creator /
 *     tourism_tax / migration_registration_enqueuer / activity_writer /
 *     notification-dispatcher. NO manual call для these.
 *
 * Compliance hard-reqs (per `plans/m9_widget_4_canonical.md` §8):
 *   - 152-ФЗ ст. 9 — separate-document consent (`consents.acceptedDpa` mandatory).
 *   - 38-ФЗ ст. 18 — marketing opt-in optional.
 *   - 152-ФЗ ст. 22.1 — `consentLog` audit trail (real persistence даже на demo).
 *   - ПП РФ 1912 effective 2026-03-01 — refund canon enforced via existing
 *     booking domain feeSnapshot (reversed «невозвратный тариф»).
 *
 * D9 (placeholder pattern, see plan §4 + §12 #8):
 *   Existing `bookingGuestSnapshot` requires `documentType` + `documentNumber`,
 *   но widget anonymous flow не collects passport. Widget inserts placeholders:
 *     documentType: 'pending'
 *     documentNumber: 'pending_<guestId>'
 *   M8.A.6 magic-link guest portal completes via existing patch flows.
 *   Boundaried к widget-bookings (filterable by documentType='pending').
 *
 * Behaviour-faithful Mock canon (per `feedback_behaviour_faithful_mock_canon.md`):
 *   Same canonical contract works для Stub demo + live ЮKassa (Track C2).
 *   Live-flip = factory binding swap (PAYMENT_PROVIDER=yookassa), ZERO domain
 *   code changes. This service composes services (not provider-specific).
 */

import {
	newId,
	type PaymentStatus,
	type WidgetAddonSelection,
	type WidgetBookingCommitResult,
	type WidgetConsentFlags,
	type WidgetConsentSnapshot,
	type WidgetGuestInput,
	type WidgetPaymentMethod,
} from '@horeca/shared'
import { sql as defaultSql, type sql as SQL } from '../../db/index.ts'
import {
	StaleAvailabilityError,
	WidgetConsentMissingError,
	WidgetGuestInputError,
} from '../../errors/domain.ts'
import { recordConsents } from '../../lib/consent-record.ts'
import type { BookingService } from '../booking/booking.service.ts'
import type { GuestService } from '../guest/guest.service.ts'
import type { PaymentService } from '../payment/payment.service.ts'
import type { WidgetService } from './widget.service.ts'

type SqlInstance = typeof SQL

/** Re-export wire types — service consumers import from one place. */
export type {
	WidgetAddonSelection,
	WidgetConsentFlags,
	WidgetConsentSnapshot,
	WidgetGuestInput,
	WidgetPaymentMethod,
}

/**
 * Service-internal input — extends shared wire input с server-side fields
 * (tenantId resolved by middleware, IP/UA/idempotency from request headers).
 * Wire schema lives в `@horeca/shared/widget.ts` — single source of truth.
 */
export interface WidgetBookingCreateInput {
	readonly tenantId: string
	readonly tenantSlug: string
	readonly propertyId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly adults: number
	readonly children: number
	readonly roomTypeId: string
	readonly ratePlanId: string
	readonly expectedTotalKopecks: number
	readonly addons: readonly WidgetAddonSelection[]
	readonly guest: WidgetGuestInput
	readonly consents: WidgetConsentFlags
	readonly consentSnapshot: WidgetConsentSnapshot
	readonly paymentMethod: WidgetPaymentMethod
	readonly ipAddress: string
	readonly userAgent: string | null
	readonly idempotencyKey: string
}

/**
 * Service result — wider PaymentStatus enum than wire result (which restricts
 * via Zod schema). Service returns full payment domain status; route serialises
 * через shared `widgetBookingCommitResultSchema`.
 *
 * Re-exporting wire result type для consumers — same shape, only `paymentStatus`
 * type widens here.
 */
export interface WidgetBookingCreateResult
	extends Omit<WidgetBookingCommitResult, 'paymentStatus'> {
	readonly paymentStatus: PaymentStatus
}

export const WIDGET_ACTOR_USER_ID = 'system:public_widget'
const PLACEHOLDER_DOCUMENT_TYPE = 'pending'

export interface WidgetBookingCreateServiceDeps {
	readonly widgetService: WidgetService
	readonly guestService: GuestService
	readonly bookingService: BookingService
	readonly paymentService: PaymentService
	/** Optional SQL instance — defaults to project default. Tests override. */
	readonly sql?: SqlInstance | undefined
}

export type WidgetBookingCreateService = ReturnType<typeof createWidgetBookingCreateService>

export function createWidgetBookingCreateService(deps: WidgetBookingCreateServiceDeps) {
	const sql = deps.sql ?? defaultSql

	return {
		/**
		 * Orchestrate widget booking commit:
		 *   1. Re-validate availability (stale-cache detect).
		 *   2. Verify 152-ФЗ consent (mandatory).
		 *   3. Create guest с placeholder document fields (D9 path B).
		 *   4. Record consents (152-ФЗ + 38-ФЗ если accepted).
		 *   5. Create booking — existing service handles ARI invariants, fee
		 *      snapshots, tourism tax, registration status. CDC auto-fires.
		 *   6. Create payment intent — Stub provider returns synchronous-success
		 *      snapshot. Live provider (Track C2) returns pending + webhook.
		 *
		 * Errors propagate: TenantNotFoundError / PublicPropertyNotFoundError
		 * (timing-safe), StaleAvailabilityError (price changed since quote),
		 * WidgetConsentMissingError (152-ФЗ not accepted), Zod validation
		 * errors (route-level), domain errors from underlying services.
		 *
		 * Compensation: каждый service call atomic. Если step 6 (payment)
		 * fails, orphan booking/guest exists в 'pending' status. Cleanup via
		 * cancel-fee finalizer cron (existing CDC consumer).
		 */
		async commit(input: WidgetBookingCreateInput): Promise<WidgetBookingCreateResult> {
			// 1. Re-validate availability — existing widget.service does all checks
			// (occupancy, sellable, rate present, tourism tax, free-cancel deadline).
			const availability = await deps.widgetService.getAvailability({
				tenantSlug: input.tenantSlug,
				propertyId: input.propertyId,
				checkIn: input.checkIn,
				checkOut: input.checkOut,
				adults: input.adults,
				children: input.children,
			})

			const offering = availability.offerings.find((o) => o.roomType.id === input.roomTypeId)
			if (!offering) {
				throw new StaleAvailabilityError(
					'roomType not found in current availability — refresh quote',
				)
			}
			if (!offering.sellable) {
				throw new StaleAvailabilityError(
					`roomType not sellable: ${offering.unsellableReason ?? 'unknown'}`,
				)
			}
			const rate = offering.rateOptions.find((r) => r.ratePlanId === input.ratePlanId)
			if (!rate) {
				throw new StaleAvailabilityError(
					'ratePlan not found in current availability — refresh quote',
				)
			}
			if (rate.totalKopecks !== input.expectedTotalKopecks) {
				throw new StaleAvailabilityError(
					`price changed: expected ${input.expectedTotalKopecks}, current ${rate.totalKopecks}`,
				)
			}

			// 2. Mandatory 152-ФЗ consent gate (ЗоЗПП ст. 16 ч. 3.1 opt-in).
			if (!input.consents.acceptedDpa) {
				throw new WidgetConsentMissingError('152fz_pd')
			}

			// 3. Validate guest input (Zod-level should have caught most, but
			// defensive — service layer doesn't trust upstream).
			validateGuestInput(input.guest)

			// 4. Create guest с placeholder document fields (D9 path B).
			// M8.A.6 magic-link guest portal completes documentType + documentNumber
			// via existing guest patch flow before check-in.
			//
			// Pre-generate placeholder docNumber using ULID-style nonce (NOT
			// guest.id, which is generated server-side во время repo.create).
			// `pending_w_<26-char>` shape filterable as widget-origin via prefix.
			const placeholderDocNumber = `pending_w_${newId('guest').replace(/^gst_/, '')}`

			const guest = await deps.guestService.create(input.tenantId, {
				lastName: input.guest.lastName,
				firstName: input.guest.firstName,
				middleName: input.guest.middleName ?? null,
				birthDate: null,
				citizenship: input.guest.citizenship,
				documentType: PLACEHOLDER_DOCUMENT_TYPE,
				documentSeries: null,
				documentNumber: placeholderDocNumber,
				documentIssuedBy: null,
				documentIssuedDate: null,
				registrationAddress: null,
				phone: input.guest.phone,
				email: input.guest.email,
				notes: input.guest.specialRequests ?? null,
				visaNumber: null,
				visaType: null,
				visaExpiresAt: null,
				migrationCardNumber: null,
				arrivalDate: null,
				stayUntil: null,
			})
			// Use REAL guest.id from server-generated row (NOT pre-generated nonce).
			const guestId = guest.id

			// 5. Record consents (152-ФЗ obligated, 38-ФЗ optional).
			// Per `feedback_behaviour_faithful_mock_canon.md`: real persistence даже
			// на demo тенанте — compliance не зависит от Mock vs Live.
			const consents: Array<{
				type: '152fz_pd' | '38fz_marketing'
				textSnapshot: string
				version: string
			}> = [
				{
					type: '152fz_pd',
					textSnapshot: input.consentSnapshot.dpaText,
					version: input.consentSnapshot.version,
				},
			]
			if (input.consents.acceptedMarketing) {
				consents.push({
					type: '38fz_marketing',
					textSnapshot: input.consentSnapshot.marketingText,
					version: input.consentSnapshot.version,
				})
			}
			await recordConsents(sql, {
				tenantId: input.tenantId,
				guestId,
				ipAddress: input.ipAddress,
				userAgent: input.userAgent,
				consents,
				grantedAt: new Date(),
			})

			// 6. Create booking — existing service does ARI / fee snapshots /
			// tourism tax / registration status. CDC consumers auto-trigger от
			// `booking.created` event: folio_creator / tourism_tax /
			// migration_registration_enqueuer / activity_writer / notification.
			const booking = await deps.bookingService.create(
				input.tenantId,
				input.propertyId,
				{
					roomTypeId: input.roomTypeId,
					ratePlanId: input.ratePlanId,
					checkIn: input.checkIn,
					checkOut: input.checkOut,
					guestsCount: input.adults + input.children,
					primaryGuestId: guestId,
					guestSnapshot: {
						firstName: input.guest.firstName,
						lastName: input.guest.lastName,
						middleName: input.guest.middleName ?? null,
						citizenship: input.guest.citizenship,
						documentType: PLACEHOLDER_DOCUMENT_TYPE,
						documentNumber: placeholderDocNumber,
					},
					channelCode: 'direct',
					externalId: null,
					externalReferences: null,
					notes: input.guest.specialRequests ?? null,
				},
				WIDGET_ACTOR_USER_ID,
			)

			// 7. Create payment intent. Existing payment.service handles
			// idempotency UNIQUE dedup at DB level + provider invocation +
			// state machine transition. Stub provider returns synchronous-success
			// (created → pending → succeeded). Live provider (Track C2) returns
			// pending + webhook completes flow.
			const paymentResult = await deps.paymentService.createIntent(
				input.tenantId,
				{
					propertyId: input.propertyId,
					bookingId: booking.id,
					folioId: null, // CDC `folio_creator` materializes folio async
					providerCode: 'stub',
					method: input.paymentMethod,
					amountMinor: BigInt(input.expectedTotalKopecks),
					currency: 'RUB',
					idempotencyKey: input.idempotencyKey,
					saleChannel: 'direct',
					payerInn: null,
				},
				WIDGET_ACTOR_USER_ID,
			)

			return {
				bookingId: booking.id,
				guestId,
				paymentId: paymentResult.payment.id,
				paymentStatus: paymentResult.payment.status,
				confirmationToken: paymentResult.payment.providerPaymentId ?? paymentResult.payment.id,
				totalKopecks: input.expectedTotalKopecks,
			}
		},
	}
}

function validateGuestInput(guest: WidgetGuestInput): void {
	if (!guest.firstName.trim()) throw new WidgetGuestInputError('firstName empty')
	if (!guest.lastName.trim()) throw new WidgetGuestInputError('lastName empty')
	if (!guest.email.trim()) throw new WidgetGuestInputError('email empty')
	if (!guest.phone.trim()) throw new WidgetGuestInputError('phone empty')
	if (!guest.citizenship.trim()) throw new WidgetGuestInputError('citizenship empty')
}
