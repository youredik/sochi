import type {
	BookingCancelInput,
	BookingCheckInInput,
	BookingCreateInput,
	BookingFeeSnapshot,
	BookingMarkNoShowInput,
	BookingStatus,
	BookingTimeSlice,
	RatePlan,
} from '@horeca/shared'
import { decimalToMicros } from '../../db/ydb-helpers.ts'
import {
	NoInventoryError,
	PropertyNotFoundError,
	RatePlanNotFoundError,
	RoomTypeNotFoundError,
} from '../../errors/domain.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RateRepo } from '../rate/rate.repo.ts'
import type { RatePlanService } from '../ratePlan/ratePlan.service.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import { __bookingRepoInternals, type BookingRepo } from './booking.repo.ts'

const { nightsBetween } = __bookingRepoInternals

/**
 * Subset of RatePlan fields used for fee-snapshot computation. Keeping the
 * dependency narrow makes `computeCancellationFeeSnapshot` cheap to unit-test.
 */
type FeePolicySource = Pick<
	RatePlan,
	'isRefundable' | 'cancellationHours' | 'currency' | 'updatedAt'
>

/**
 * Apaleo-style snapshot of the cancellation policy, frozen at booking-create time.
 * Fiscal audit (RU 54-ФЗ) + refund correctness both require reproducibility —
 * the guest agreed to THIS policy, not whatever the rate plan becomes later.
 *
 *   - Non-refundable (or unspecified grace window): 100% fee, no dueDate.
 *   - Refundable with `cancellationHours`: 100% fee, dueDate = checkIn minus
 *     the grace window. Actual fee at cancel time is computed by comparing
 *     the cancellation timestamp to dueDate (done in folio, Phase 3).
 *
 * `policyVersion` is the ratePlan's `updatedAt` at snapshot time — changes
 * whenever revenue manager edits the plan, giving us a monotonic marker.
 */
export function computeCancellationFeeSnapshot(
	totalMicros: bigint,
	rp: FeePolicySource,
	checkInDate: string,
): BookingFeeSnapshot {
	if (!rp.isRefundable || rp.cancellationHours === null) {
		return {
			amountMicros: totalMicros,
			currency: rp.currency,
			dueDate: null,
			policyCode: 'nonRefundable',
			policyVersion: rp.updatedAt,
		}
	}
	// Grace window expires `cancellationHours` before check-in. We store the
	// calendar date (UTC) — calling systems can refine to wall-clock in the
	// property's timezone; MVP keeps it simple and UTC-anchored.
	const dueAt = new Date(`${checkInDate}T00:00:00Z`)
	dueAt.setUTCHours(dueAt.getUTCHours() - rp.cancellationHours)
	return {
		amountMicros: totalMicros,
		currency: rp.currency,
		dueDate: dueAt.toISOString().slice(0, 10),
		policyCode: 'flexible',
		policyVersion: rp.updatedAt,
	}
}

/**
 * No-show fee is always 100% of the stay (industry default, Apaleo baseline).
 * `dueDate` is intentionally null — a no-show decision is made AT the check-in
 * date, so there's no grace window.
 */
export function computeNoShowFeeSnapshot(
	totalMicros: bigint,
	rp: Pick<RatePlan, 'currency' | 'updatedAt'>,
): BookingFeeSnapshot {
	return {
		amountMicros: totalMicros,
		currency: rp.currency,
		dueDate: null,
		policyCode: 'standardNoShow',
		policyVersion: rp.updatedAt,
	}
}

/**
 * Booking service. Validates cross-domain parents (property/roomType/ratePlan),
 * builds the price snapshot (`timeSlices[]`) from `rate` rows, computes
 * tourism tax, then delegates the atomic inventory+booking write to the repo.
 *
 * Deferred to later M4 sub-phase (marked TODO(M4e)):
 *   - tourism tax floor (min ₽100 / night) and property.tourismTaxRateBps lookup
 *   - registrationStatus derivation from guest citizenship
 */
export function createBookingService(
	repo: BookingRepo,
	rateRepo: RateRepo,
	propertyService: PropertyService,
	roomTypeService: RoomTypeService,
	ratePlanService: RatePlanService,
) {
	return {
		getById: (tenantId: string, id: string) => repo.getById(tenantId, id),

		listByProperty: async (
			tenantId: string,
			propertyId: string,
			opts: { from?: string; to?: string; status?: BookingStatus; roomTypeId?: string },
		) => {
			const prop = await propertyService.getById(tenantId, propertyId)
			if (!prop) throw new PropertyNotFoundError(propertyId)
			return repo.listByProperty(tenantId, propertyId, opts)
		},

		create: async (
			tenantId: string,
			propertyId: string,
			input: BookingCreateInput,
			actorUserId: string,
		) => {
			const prop = await propertyService.getById(tenantId, propertyId)
			if (!prop) throw new PropertyNotFoundError(propertyId)

			const rt = await roomTypeService.getById(tenantId, input.roomTypeId)
			if (!rt || rt.propertyId !== propertyId) {
				throw new RoomTypeNotFoundError(input.roomTypeId)
			}

			const rp = await ratePlanService.getById(tenantId, input.ratePlanId)
			if (!rp || rp.propertyId !== propertyId || rp.roomTypeId !== input.roomTypeId) {
				throw new RatePlanNotFoundError(input.ratePlanId)
			}

			const nights = nightsBetween(input.checkIn, input.checkOut)
			if (nights.length === 0) {
				throw new NoInventoryError('checkIn must be strictly before checkOut')
			}

			const rates = await rateRepo.listRange(
				tenantId,
				propertyId,
				input.roomTypeId,
				input.ratePlanId,
				{ from: nights[0] ?? '', to: nights[nights.length - 1] ?? '' },
			)
			const rateByDate = new Map(rates.map((r) => [r.date, r]))

			const timeSlices: BookingTimeSlice[] = []
			for (const night of nights) {
				const r = rateByDate.get(night)
				if (!r) throw new NoInventoryError(`no rate row for ${night}`)
				timeSlices.push({
					date: night,
					grossMicros: decimalToMicros(r.amount),
					ratePlanId: r.ratePlanId,
					// TODO(M4c): proper policy-versioning on ratePlan. For now the ISO
					// updatedAt acts as a monotonic version marker — changes on any edit.
					ratePlanVersion: rp.updatedAt,
					currency: r.currency,
				})
			}

			const totalMicros = timeSlices.reduce((acc, s) => acc + s.grossMicros, 0n)

			return repo.create(tenantId, propertyId, input, {
				actorUserId,
				timeSlices,
				cancellationFee: computeCancellationFeeSnapshot(totalMicros, rp, input.checkIn),
				noShowFee: computeNoShowFeeSnapshot(totalMicros, rp),
				tourismTaxBaseMicros: totalMicros,
				// TODO(M4e): fetch property.tourismTaxRateBps + apply min ₽100/night floor.
				tourismTaxMicros: 0n,
				// TODO(M4e): derive from primaryGuest.citizenship (non-RU ⇒ 'pending').
				registrationStatus: 'notRequired',
				rklCheckResult: 'unchecked',
			})
		},

		cancel: async (tenantId: string, id: string, input: BookingCancelInput, actorUserId: string) =>
			repo.cancel(tenantId, id, input.reason, actorUserId),

		checkIn: async (
			tenantId: string,
			id: string,
			input: BookingCheckInInput,
			actorUserId: string,
		) =>
			repo.checkIn(
				tenantId,
				id,
				'assignedRoomId' in input ? { assignedRoomId: input.assignedRoomId ?? null } : {},
				actorUserId,
			),

		checkOut: async (tenantId: string, id: string, actorUserId: string) =>
			repo.checkOut(tenantId, id, actorUserId),

		markNoShow: async (
			tenantId: string,
			id: string,
			input: BookingMarkNoShowInput,
			actorUserId: string,
		) => repo.markNoShow(tenantId, id, input.reason ?? null, actorUserId),
	}
}
