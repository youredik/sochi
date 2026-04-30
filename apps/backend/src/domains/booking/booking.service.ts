import type {
	BookingCancelInput,
	BookingCheckInInput,
	BookingCreateInput,
	BookingFeeSnapshot,
	BookingMarkNoShowInput,
	BookingStatus,
	BookingTimeSlice,
	RatePlan,
	TourismTaxOrgReport,
	TourismTaxOrgReportMonthly,
	TourismTaxOrgReportParams,
	TourismTaxOrgReportRow,
	TourismTaxReport,
	TourismTaxReportParams,
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
	// property's timezone; первый этап держит it simple and UTC-anchored.
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
 * Russian tourism-tax compute per НК РФ ст.418.5 (verified 2026-04):
 *
 *   tax = max(accommodationBaseMicros * rateBps / 10000, minPerNight * nights)
 *
 * `minPerNight` = ₽100 = `100_000_000` micros (federal floor). Sochi 2026
 * rateBps = 200 (2%); federal roadmap 2026→2029: 2% → 3% → 4% → 5% (we
 * persist bps per-property so changing the rate is an UPDATE, not a
 * migration).
 *
 * Returns 0n when the property has no rate configured (rateBps === null) —
 * unconfigured = not applicable (e.g. properties outside the tourist-tax
 * zone). If configured as 0 bps, the floor still kicks in for the "minimum
 * charge even on below-threshold rates" case per a literal reading of the
 * code — so we gate on `rateBps === null` specifically.
 */
const MIN_TAX_PER_NIGHT_MICROS = 100_000_000n // ₽100

export function computeTourismTax(
	accommodationBaseMicros: bigint,
	rateBps: number | null,
	nightsCount: number,
): bigint {
	if (rateBps === null) return 0n
	if (nightsCount <= 0) return 0n
	const proportional = (accommodationBaseMicros * BigInt(rateBps)) / 10_000n
	const floor = MIN_TAX_PER_NIGHT_MICROS * BigInt(nightsCount)
	return proportional > floor ? proportional : floor
}

/** Derive registration flow per primary guest's citizenship.
 *  'RU' citizenship → `'notRequired'`; foreign → `'pending'` (awaiting МВД). */
export function deriveRegistrationStatus(citizenship: string): 'notRequired' | 'pending' {
	return citizenship.toUpperCase() === 'RU' ? 'notRequired' : 'pending'
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

			const nightsCount = nights.length
			return repo.create(tenantId, propertyId, input, {
				actorUserId,
				timeSlices,
				cancellationFee: computeCancellationFeeSnapshot(totalMicros, rp, input.checkIn),
				noShowFee: computeNoShowFeeSnapshot(totalMicros, rp),
				tourismTaxBaseMicros: totalMicros,
				tourismTaxMicros: computeTourismTax(totalMicros, prop.tourismTaxRateBps, nightsCount),
				registrationStatus: deriveRegistrationStatus(input.guestSnapshot.citizenship),
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

		/**
		 * Aggregate tourism-tax liability for quarterly fiscal reporting.
		 *
		 * - Filters by booking.checkIn within `[from, to]`; checkIn is the
		 *   fiscal event date (stay is delivered starting then). NK RF §418
		 *   doesn't explicitly standardize — common practice is to attribute
		 *   to the stay's commencement date; we follow that.
		 * - Excludes `cancelled` bookings — they never accrued tax
		 *   (markNoShow DOES retain liability per domain decision; see
		 *   booking.repo.markNoShow docstring).
		 */
		getTourismTaxReport: async (
			tenantId: string,
			propertyId: string,
			input: TourismTaxReportParams,
		): Promise<TourismTaxReport> => {
			const prop = await propertyService.getById(tenantId, propertyId)
			if (!prop) throw new PropertyNotFoundError(propertyId)
			const bookings = await repo.listByProperty(tenantId, propertyId, {
				from: input.from,
				to: input.to,
			})
			const included = bookings.filter((b) => b.status !== 'cancelled')
			const tax = included.reduce((acc, b) => acc + BigInt(b.tourismTaxMicros), 0n)
			const base = included.reduce((acc, b) => acc + BigInt(b.tourismTaxBaseMicros), 0n)
			return {
				propertyId,
				from: input.from,
				to: input.to,
				bookingsCount: included.length,
				tourismTaxMicros: tax.toString(),
				accommodationBaseMicros: base.toString(),
			}
		},

		/**
		 * Organisation-level tourism-tax report — aggregates across all properties
		 * of the tenant within `[from, to]` (inclusive on both ends).
		 *
		 *   - Optional `propertyId` narrows the scan to a single property; when
		 *     provided, validated against the tenant (cross-tenant 404 surfaces
		 *     as PropertyNotFoundError).
		 *   - Includes deactivated properties (`includeInactive: true`) so a
		 *     property hidden from the operator UI does NOT silently disappear
		 *     from a tax report covering the period when it was active. Tax
		 *     liability follows the booking, not the current property flag.
		 *   - Excludes `status === 'cancelled'` (no tax accrued); `no_show`
		 *     rows are RETAINED — domain rule (booking.repo.markNoShow docstring).
		 *   - Buckets by **YYYY-MM of `checkIn`**: matches КНД 1153008 line 005
		 *     (number of month inside the quarter, per Order ФНС ЕД-7-3/1228@
		 *     2025-12-19, see memory `project_ru_tax_form_2026q1.md`).
		 */
		getTourismTaxOrgReport: async (
			tenantId: string,
			input: TourismTaxOrgReportParams,
		): Promise<TourismTaxOrgReport> => {
			const properties = await propertyService.list(tenantId, true)
			let scope = properties
			if (input.propertyId) {
				scope = properties.filter((p) => p.id === input.propertyId)
				if (scope.length === 0) throw new PropertyNotFoundError(input.propertyId)
			}

			const propNameById = new Map(scope.map((p) => [p.id, p.name]))

			const allRows: TourismTaxOrgReportRow[] = []
			for (const p of scope) {
				const bookings = await repo.listByProperty(tenantId, p.id, {
					from: input.from,
					to: input.to,
				})
				for (const b of bookings) {
					if (b.status === 'cancelled') continue
					const g = b.guestSnapshot
					const guestName = [g.lastName, g.firstName, g.middleName ?? '']
						.filter(Boolean)
						.join(' ')
						.trim()
					allRows.push({
						bookingId: b.id,
						propertyId: p.id,
						propertyName: propNameById.get(p.id) ?? p.id,
						checkIn: b.checkIn,
						checkOut: b.checkOut,
						nightsCount: b.nightsCount,
						guestName,
						channelCode: b.channelCode,
						status: b.status,
						accommodationBaseMicros: b.tourismTaxBaseMicros,
						tourismTaxMicros: b.tourismTaxMicros,
					})
				}
			}

			allRows.sort((a, b) => {
				if (a.checkIn !== b.checkIn) return a.checkIn < b.checkIn ? -1 : 1
				return a.bookingId < b.bookingId ? -1 : 1
			})

			const monthlyMap = new Map<string, TourismTaxOrgReportMonthly>()
			let totalBase = 0n
			let totalTax = 0n
			let totalNights = 0
			for (const r of allRows) {
				const month = r.checkIn.slice(0, 7)
				const cur = monthlyMap.get(month) ?? {
					month,
					bookingsCount: 0,
					totalNights: 0,
					accommodationBaseMicros: '0',
					tourismTaxMicros: '0',
				}
				cur.bookingsCount += 1
				cur.totalNights += r.nightsCount
				cur.accommodationBaseMicros = (
					BigInt(cur.accommodationBaseMicros) + BigInt(r.accommodationBaseMicros)
				).toString()
				cur.tourismTaxMicros = (
					BigInt(cur.tourismTaxMicros) + BigInt(r.tourismTaxMicros)
				).toString()
				monthlyMap.set(month, cur)
				totalBase += BigInt(r.accommodationBaseMicros)
				totalTax += BigInt(r.tourismTaxMicros)
				totalNights += r.nightsCount
			}

			const monthly = Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month))

			return {
				period: { from: input.from, to: input.to },
				propertyId: input.propertyId ?? null,
				kpi: {
					bookingsCount: allRows.length,
					totalNights,
					accommodationBaseMicros: totalBase.toString(),
					tourismTaxMicros: totalTax.toString(),
				},
				monthly,
				rows: allRows,
			}
		},
	}
}

export type BookingService = ReturnType<typeof createBookingService>
