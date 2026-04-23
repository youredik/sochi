import type {
	BookingCancelInput,
	BookingCreateInput,
	BookingStatus,
	BookingTimeSlice,
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
 * Booking service. Validates cross-domain parents (property/roomType/ratePlan),
 * builds the price snapshot (`timeSlices[]`) from `rate` rows, computes
 * tourism tax, then delegates the atomic inventory+booking write to the repo.
 *
 * Deferred to later M4 sub-phases (marked TODO(M4c/M4e)):
 *   - cancellationFee / noShowFee snapshot from ratePlan cancellationPolicy (M4c)
 *   - tourism tax floor (min ₽100 / night) and property.tourismTaxRateBps lookup (M4e)
 *   - registrationStatus derivation from guest citizenship (M4e)
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
				// TODO(M4c): snapshot cancellation/no-show fee from rp.cancellationHours /
				// non-refundable policy. Non-trivial; punting to keep M4b focused.
				cancellationFee: null,
				noShowFee: null,
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
	}
}
