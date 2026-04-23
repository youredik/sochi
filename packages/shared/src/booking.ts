import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Booking — the reservation record that ties a guest to a roomType for a stay.
 *
 * Per the ARI model (see memory `project_horeca_domain_model.md`):
 *   - Booking attaches to `roomType`, not a specific physical room. A concrete
 *     `assignedRoomId` is set at check-in (or earlier by an auto-assign job).
 *   - `status` is the materialized current state (5 values, Apaleo-canonical).
 *     State-transition timestamps (`confirmedAt`, `checkedInAt`, …) are the
 *     source-of-truth audit trail; CDC diffs them → `activity` rows.
 *   - `timeSlices` — per-night price snapshot frozen at create time. Fiscal
 *     correctness (RU 54-ФЗ) + refund safety: rate changes don't rewrite past.
 *   - `cancellationFee` / `noShowFee` — snapshot of the policy on the booked
 *     rate at create time (Apaleo pattern). Non-refundable rates lock 100% fee.
 *   - `guestSnapshot` — passport/document fields as-of booking time. МВД
 *     requires the data as it was at registration, not the guest's current profile.
 *   - Money uses Int64 micros (× 10^6) because @ydbjs/value 6.x lacks a
 *     Decimal wrapper (see memory `project_ydb_specifics.md` #13).
 *   - `externalId` + `channelCode`: UNIQUE `(tenantId, propertyId, externalId)`
 *     index dedupes OTA retries at the DB level. Nullable for walk-ins/direct.
 *   - `registrationStatus` / `rklCheckResult`: МВД reporting state-machine for
 *     foreign guests (see memory `project_ru_compliance_blockers.md` #1).
 *   - `tourismTax*`: 2% of accommodation base for Sochi 2026 (basis points on
 *     property), min ₽100/night per НК РФ ch.33.1 (replaces repealed курортный
 *     сбор; see memory `project_ru_compliance_blockers.md` #2).
 */

/** 5-state machine; Apaleo-canonical. `no_show` is TERMINAL and irreversible. */
const bookingStatusValues = [
	'confirmed',
	'in_house',
	'checked_out',
	'cancelled',
	'no_show',
] as const
export const bookingStatusSchema = z.enum(bookingStatusValues)
export type BookingStatus = z.infer<typeof bookingStatusSchema>

/** Channel of origin. `direct` = booking engine on this SaaS; `walkIn` = front desk. */
const bookingChannelCodeValues = [
	'direct',
	'walkIn',
	'yandexTravel',
	'ostrovok',
	'travelLine',
	'bnovo',
	'bookingCom',
	'expedia',
	'airbnb',
] as const
export const bookingChannelCodeSchema = z.enum(bookingChannelCodeValues)
export type BookingChannelCode = z.infer<typeof bookingChannelCodeSchema>

/** МВД registration lifecycle for foreign guests. */
const bookingRegistrationStatusValues = [
	'notRequired',
	'pending',
	'submitted',
	'registered',
	'failed',
] as const
export const bookingRegistrationStatusSchema = z.enum(bookingRegistrationStatusValues)
export type BookingRegistrationStatus = z.infer<typeof bookingRegistrationStatusSchema>

/** РКЛ (реестр контролируемых лиц) check — blocking at check-in if 'blocked'. */
const bookingRklCheckResultValues = ['unchecked', 'clear', 'blocked'] as const
export const bookingRklCheckResultSchema = z.enum(bookingRklCheckResultValues)
export type BookingRklCheckResult = z.infer<typeof bookingRklCheckResultSchema>

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const currencySchema = z
	.string()
	.length(3)
	.regex(/^[A-Z]{3}$/, 'Expected ISO 4217 currency code')
const bigIntMicrosSchema = z.coerce
	.bigint()
	.nonnegative()
	.refine((n) => n <= 9_223_372_036_854_775_807n, 'Overflow: exceeds Int64 max')

/** Per-night price snapshot. `ratePlanVersion` enables reproducing the policy. */
export const bookingTimeSliceSchema = z.object({
	date: dateSchema,
	grossMicros: bigIntMicrosSchema,
	ratePlanId: idSchema('ratePlan'),
	ratePlanVersion: z.string().min(1).max(50),
	currency: currencySchema,
})
export type BookingTimeSlice = z.infer<typeof bookingTimeSliceSchema>

/** Cancellation / no-show fee snapshot. `policyVersion` enables audit reproducibility. */
export const bookingFeeSnapshotSchema = z.object({
	amountMicros: bigIntMicrosSchema,
	currency: currencySchema,
	dueDate: dateSchema.nullable(),
	policyCode: z.string().min(1).max(50),
	policyVersion: z.string().min(1).max(50),
})
export type BookingFeeSnapshot = z.infer<typeof bookingFeeSnapshotSchema>

/** Embedded guest fields as-of-booking (immutable). */
export const bookingGuestSnapshotSchema = z.object({
	firstName: z.string().min(1).max(100),
	lastName: z.string().min(1).max(100),
	middleName: z.string().max(100).nullable().optional(),
	citizenship: z.string().min(2).max(3),
	documentType: z.string().min(1).max(50),
	documentNumber: z.string().min(1).max(50),
})
export type BookingGuestSnapshot = z.infer<typeof bookingGuestSnapshotSchema>

/** Multiple external IDs per reservation (Apaleo `externalReferences` pattern). */
export const bookingExternalReferencesSchema = z.object({
	channelManagerId: z.string().max(100).nullable().optional(),
	otaId: z.string().max(100).nullable().optional(),
	gdsId: z.string().max(100).nullable().optional(),
	loyaltyId: z.string().max(100).nullable().optional(),
})
export type BookingExternalReferences = z.infer<typeof bookingExternalReferencesSchema>

const guestsCountSchema = z.coerce.number().int().min(1).max(20)

/** POST /properties/:propertyId/bookings body. */
export const bookingCreateInput = z
	.object({
		roomTypeId: idSchema('roomType'),
		ratePlanId: idSchema('ratePlan'),
		checkIn: dateSchema,
		checkOut: dateSchema,
		guestsCount: guestsCountSchema,
		primaryGuestId: idSchema('guest'),
		guestSnapshot: bookingGuestSnapshotSchema,
		channelCode: bookingChannelCodeSchema,
		externalId: z.string().min(1).max(100).nullable().optional(),
		externalReferences: bookingExternalReferencesSchema.nullable().optional(),
		notes: z.string().max(2000).nullable().optional(),
	})
	.refine((v) => v.checkIn < v.checkOut, 'checkIn must be strictly before checkOut')
export type BookingCreateInput = z.infer<typeof bookingCreateInput>

/** PATCH /bookings/:id/cancel — cancel a non-terminal booking. */
export const bookingCancelInput = z.object({
	reason: z.string().min(1).max(500),
})
export type BookingCancelInput = z.infer<typeof bookingCancelInput>

// NOTE: markNoShow / checkIn / checkOut input schemas land with M4b-2 when the
// corresponding repo/service methods ship. Keeping this module tight until then
// (knip-clean, no hypothetical scaffolding).

export const bookingIdParam = z.object({ id: idSchema('booking') })
export const bookingPropertyParam = z.object({ propertyId: idSchema('property') })

/** GET /properties/:propertyId/bookings — optional filters. */
export const bookingListParams = z
	.object({
		from: dateSchema.optional(),
		to: dateSchema.optional(),
		status: bookingStatusSchema.optional(),
		roomTypeId: idSchema('roomType').optional(),
	})
	.refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, 'from must be <= to')

/** Domain row shape (read model). Money fields are string-serialized bigints for JSON. */
export type Booking = {
	tenantId: string
	propertyId: string
	checkIn: string
	id: string
	checkOut: string
	roomTypeId: string
	ratePlanId: string
	assignedRoomId: string | null
	guestsCount: number
	nightsCount: number
	primaryGuestId: string
	guestSnapshot: BookingGuestSnapshot
	status: BookingStatus
	confirmedAt: string
	checkedInAt: string | null
	checkedOutAt: string | null
	cancelledAt: string | null
	noShowAt: string | null
	cancelReason: string | null
	channelCode: BookingChannelCode
	externalId: string | null
	externalReferences: BookingExternalReferences | null
	totalMicros: string
	paidMicros: string
	currency: string
	timeSlices: BookingTimeSlice[]
	cancellationFee: BookingFeeSnapshot | null
	noShowFee: BookingFeeSnapshot | null
	registrationStatus: BookingRegistrationStatus
	registrationMvdId: string | null
	registrationSubmittedAt: string | null
	rklCheckResult: BookingRklCheckResult
	rklCheckedAt: string | null
	tourismTaxBaseMicros: string
	tourismTaxMicros: string
	notes: string | null
	createdAt: string
	updatedAt: string
	createdBy: string
	updatedBy: string
}
