import type {
	BookingAssignRoomInput,
	BookingAutoAssignResult,
	BookingCancelInput,
	BookingChangeGuestsCountInput,
	BookingChangeRatePlanInput,
	BookingChangeRoomTypeInput,
	BookingCheckInInput,
	BookingCreateInput,
	BookingFeeSnapshot,
	BookingMarkNoShowInput,
	BookingMoveDatesInput,
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
import { isRussianCitizenship } from '@horeca/shared'
import { decimalToMicros } from '../../db/ydb-helpers.ts'
import {
	InvalidBookingAmendStateError,
	NoInventoryError,
	PassportScanRequiredError,
	PropertyNotFoundError,
	RatePlanNotFoundError,
	RoomAssignmentConflictError,
	RoomTypeNotFoundError,
} from '../../errors/domain.ts'
import { planAutoAssign } from './auto-assign.ts'
import type { GuestDocumentRepo } from '../guest/guest-document.repo.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RateRepo } from '../rate/rate.repo.ts'
import type { RatePlanService } from '../ratePlan/ratePlan.service.ts'
import type { RoomService } from '../room/room.service.ts'
import type { RoomTypeService } from '../roomType/roomType.service.ts'
import type { TenantComplianceRepo } from '../tenant/compliance.repo.ts'
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
 *  RU citizenship → `'notRequired'`; foreign → `'pending'` (awaiting МВД).
 *
 *  **G4.bis fix (2026-05-15)**: `citizenshipSchema` accepts ISO-3166 alpha-2
 *  ('RU') AND alpha-3 ('RUS'). Прежде проверял только 'RU' → operator typing
 *  'RUS' silently triggered МВД pipeline для actual RU citizen. Использует
 *  shared `isRussianCitizenship()` helper для both encodings.
 */
export function deriveRegistrationStatus(citizenship: string): 'notRequired' | 'pending' {
	return isRussianCitizenship(citizenship) ? 'notRequired' : 'pending'
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
	// G8 (2026-05-16) — optional roomService для assign-room + auto-assign.
	// Backward-compat undefined для legacy callers (returns 501 at runtime
	// if endpoints invoked sans wiring).
	roomService?: RoomService,
	// Sprint C+ Round 6 Legal P0 fix 2026-05-24 — ПП-1951 КСР registry hard-
	// gate. Optional с default undefined для backward-compat tests. Production
	// app.ts always wires it. Undefined → gate skipped (test mode only).
	complianceRepo?: TenantComplianceRepo,
	// Sprint C+ Round 7 Senior P0 fix 2026-05-24 — server-side mirror of
	// booking-edit-sheet hard-gate. Throws `PassportScanRequiredError` (HTTP
	// 428) для foreign-citizen check-in без active guestDocument. Per 109-ФЗ
	// ст. 22 ч. 3 + ПП РФ № 9 — уведомление в МВД ОВМ в течение 1 рабочего
	// дня → штраф 400-500k ₽ ст. 18.9 КоАП. Frontend gate ≠ enough; direct
	// API POST bypass = legal liability. Optional → test mode skip; production
	// app.ts always wires.
	guestDocumentRepo?: GuestDocumentRepo,
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
			// Sprint C+ Round 6 Legal P0 fix 2026-05-24 — ПП-1951 от 27.12.2024
			// (ред. 27.11.2025) hard-gate. Hotel MUST have реестровый номер
			// (Росаккредитация ФГИС «Гостеприимство») чтобы принимать брони
			// после 01.09.2025. Throws `KsrRegistryNumberMissingError` → 428.
			// Gate skipped когда complianceRepo undefined (test mode).
			if (complianceRepo) {
				await complianceRepo.assertKsrRegistryNumberPresent(tenantId)
			}

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
		) => {
			// Sprint C+ Round 7 Senior P0 fix 2026-05-24 — server-side mirror of
			// booking-edit-sheet hard-gate. Foreign-citizen check-in without active
			// guestDocument → 428 PassportScanRequiredError. Defence-in-depth: UI
			// gate prevents button click, this prevents direct curl POST bypass.
			//
			// Per 109-ФЗ ст. 22 ч. 3 + ПП РФ № 9 от 15.01.2007: middle размещения
			// обязано подать уведомление о прибытии в МВД ОВМ в течение 1 рабочего
			// дня. Document scan = canonical prerequisite (migration_registration_
			// enqueuer CDC handler reads guestDocument для XML archive). Штраф ст.
			// 18.9 КоАП: 400-500 тыс. ₽ per violation (юр. лицо).
			//
			// Gate skipped когда guestDocumentRepo undefined (test mode only).
			if (guestDocumentRepo) {
				const current = await repo.getById(tenantId, id)
				if (current && !isRussianCitizenship(current.guestSnapshot.citizenship)) {
					const active = await guestDocumentRepo.findActiveForGuest(
						tenantId,
						current.primaryGuestId,
					)
					if (active === null) {
						throw new PassportScanRequiredError(current.primaryGuestId)
					}
				}
			}
			return repo.checkIn(
				tenantId,
				id,
				'assignedRoomId' in input ? { assignedRoomId: input.assignedRoomId ?? null } : {},
				actorUserId,
			)
		},

		checkOut: async (tenantId: string, id: string, actorUserId: string) =>
			repo.checkOut(tenantId, id, actorUserId),

		markNoShow: async (
			tenantId: string,
			id: string,
			input: BookingMarkNoShowInput,
			actorUserId: string,
		) => repo.markNoShow(tenantId, id, input.reason ?? null, actorUserId),

		// -----------------------------------------------------------------
		// G5 Apaleo Amend-Stay 2026-05-15 — pre-arrival booking modifications.
		// Each method does cross-domain validation + recompute then delegates
		// к repo для atomic write. Same shape as `create` flow для consistency.
		// -----------------------------------------------------------------

		/**
		 * Move stay window. Recompute timeSlices / fees / tax from new rate
		 * rows; repo handles inventory rebalance + atomic UPSERT.
		 */
		moveDates: async (
			tenantId: string,
			id: string,
			input: BookingMoveDatesInput,
			actorUserId: string,
		) => {
			const current = await repo.getById(tenantId, id)
			if (!current) return null
			// Pre-check status so service surfaces canonical error BEFORE
			// hitting repo (repo also re-checks под tx, defense-in-depth).
			if (current.status !== 'confirmed') {
				throw new InvalidBookingAmendStateError(current.status, 'move-dates')
			}
			const prop = await propertyService.getById(tenantId, current.propertyId)
			if (!prop) throw new PropertyNotFoundError(current.propertyId)
			const rp = await ratePlanService.getById(tenantId, current.ratePlanId)
			if (!rp) throw new RatePlanNotFoundError(current.ratePlanId)

			const nights = nightsBetween(input.checkIn, input.checkOut)
			if (nights.length === 0) {
				throw new NoInventoryError('checkIn must be strictly before checkOut')
			}
			const rates = await rateRepo.listRange(
				tenantId,
				current.propertyId,
				current.roomTypeId,
				current.ratePlanId,
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
					ratePlanVersion: rp.updatedAt,
					currency: r.currency,
				})
			}
			const totalMicros = timeSlices.reduce((acc, s) => acc + s.grossMicros, 0n)
			return repo.moveDates(tenantId, id, {
				newCheckIn: input.checkIn,
				newCheckOut: input.checkOut,
				timeSlices,
				cancellationFee: computeCancellationFeeSnapshot(totalMicros, rp, input.checkIn),
				noShowFee: computeNoShowFeeSnapshot(totalMicros, rp),
				tourismTaxBaseMicros: totalMicros,
				tourismTaxMicros: computeTourismTax(totalMicros, prop.tourismTaxRateBps, nights.length),
				actorUserId,
			})
		},

		/**
		 * Switch rate plan (same dates). Validates new plan belongs к same
		 * property + roomType; recomputes price snapshots; no inventory move.
		 */
		changeRatePlan: async (
			tenantId: string,
			id: string,
			input: BookingChangeRatePlanInput,
			actorUserId: string,
		) => {
			const current = await repo.getById(tenantId, id)
			if (!current) return null
			if (current.status !== 'confirmed') {
				throw new InvalidBookingAmendStateError(current.status, 'change-rate-plan')
			}
			if (input.ratePlanId === current.ratePlanId) {
				// No-op shortcut: return current row unchanged. Idempotent.
				return current
			}
			const prop = await propertyService.getById(tenantId, current.propertyId)
			if (!prop) throw new PropertyNotFoundError(current.propertyId)
			const newRp = await ratePlanService.getById(tenantId, input.ratePlanId)
			if (
				!newRp ||
				newRp.propertyId !== current.propertyId ||
				newRp.roomTypeId !== current.roomTypeId
			) {
				throw new RatePlanNotFoundError(input.ratePlanId)
			}

			const nights = nightsBetween(current.checkIn, current.checkOut)
			const rates = await rateRepo.listRange(
				tenantId,
				current.propertyId,
				current.roomTypeId,
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
					ratePlanVersion: newRp.updatedAt,
					currency: r.currency,
				})
			}
			const totalMicros = timeSlices.reduce((acc, s) => acc + s.grossMicros, 0n)
			return repo.changeRatePlan(tenantId, id, {
				newRatePlanId: input.ratePlanId,
				timeSlices,
				cancellationFee: computeCancellationFeeSnapshot(totalMicros, newRp, current.checkIn),
				noShowFee: computeNoShowFeeSnapshot(totalMicros, newRp),
				tourismTaxBaseMicros: totalMicros,
				tourismTaxMicros: computeTourismTax(totalMicros, prop.tourismTaxRateBps, nights.length),
				actorUserId,
			})
		},

		/**
		 * Adjust head-count. Schema enforces 1..20 bounds. No price-recompute
		 * (allotment counts rooms not guests). Allowed на `in_house` ALSO per
		 * Apaleo walk-up companions canon.
		 */
		changeGuestsCount: async (
			tenantId: string,
			id: string,
			input: BookingChangeGuestsCountInput,
			actorUserId: string,
		) =>
			repo.changeGuestsCount(tenantId, id, {
				newGuestsCount: input.guestsCount,
				actorUserId,
			}),

		/**
		 * G7 (2026-05-16) — Move booking к different roomType (drag-move band).
		 *
		 * Same dates → service auto-picks default ACTIVE ratePlan для new
		 * roomType (operator drag UX simplicity — only roomType row changes
		 * in DOM); recomputes timeSlices / fees / tax. Atomic inventory swap
		 * delegated к repo.
		 *
		 * Validation: new roomType belongs к same property; default ratePlan
		 * exists для new roomType + has rate rows для все booking dates.
		 * Idempotent no-op when same roomType selected.
		 */
		moveToRoomType: async (
			tenantId: string,
			id: string,
			input: BookingChangeRoomTypeInput,
			actorUserId: string,
		) => {
			const current = await repo.getById(tenantId, id)
			if (!current) return null
			if (current.status !== 'confirmed') {
				throw new InvalidBookingAmendStateError(current.status, 'change-room-type')
			}
			if (input.roomTypeId === current.roomTypeId) {
				return current
			}
			const prop = await propertyService.getById(tenantId, current.propertyId)
			if (!prop) throw new PropertyNotFoundError(current.propertyId)
			const newRt = await roomTypeService.getById(tenantId, input.roomTypeId)
			if (!newRt || newRt.propertyId !== current.propertyId) {
				throw new RoomTypeNotFoundError(input.roomTypeId)
			}

			// Auto-pick default ACTIVE ratePlan для new roomType. Falls back к
			// first active plan if no default flagged. NoInventoryError when
			// roomType has zero active plans (operator hasn't seeded prices).
			const newRoomTypePlans = await ratePlanService.listByProperty(tenantId, current.propertyId, {
				roomTypeId: input.roomTypeId,
				includeInactive: false,
			})
			const newRp = newRoomTypePlans.find((p) => p.isDefault) ?? newRoomTypePlans[0]
			if (!newRp) {
				throw new NoInventoryError(`no active rate plan available for roomType ${input.roomTypeId}`)
			}

			const nights = nightsBetween(current.checkIn, current.checkOut)
			const rates = await rateRepo.listRange(
				tenantId,
				current.propertyId,
				input.roomTypeId,
				newRp.id,
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
					ratePlanVersion: newRp.updatedAt,
					currency: r.currency,
				})
			}
			const totalMicros = timeSlices.reduce((acc, s) => acc + s.grossMicros, 0n)
			return repo.changeRoomType(tenantId, id, {
				newRoomTypeId: input.roomTypeId,
				newRatePlanId: newRp.id,
				timeSlices,
				cancellationFee: computeCancellationFeeSnapshot(totalMicros, newRp, current.checkIn),
				noShowFee: computeNoShowFeeSnapshot(totalMicros, newRp),
				tourismTaxBaseMicros: totalMicros,
				tourismTaxMicros: computeTourismTax(totalMicros, prop.tourismTaxRateBps, nights.length),
				actorUserId,
			})
		},

		/**
		 * G8 (2026-05-16) — Pin specific physical room к booking.
		 *
		 * Validates room belongs к same property + same roomType + isActive;
		 * delegates overlap-check к repo (atomic с CAS predicate). Status
		 * guard: confirmed-only (in_house = guest physically already placed —
		 * reassignment is check-out + new booking flow).
		 *
		 * Idempotent: same `roomId` returns current unchanged (operator-trust
		 * canon — mirrors G5 change-rate-plan + G7 change-room-type pattern).
		 */
		assignRoom: async (
			tenantId: string,
			id: string,
			input: BookingAssignRoomInput,
			actorUserId: string,
		) => {
			if (!roomService) {
				throw new Error('roomService not wired — G8 assign-room requires factory update')
			}
			const current = await repo.getById(tenantId, id)
			if (!current) return null
			if (current.status !== 'confirmed') {
				throw new InvalidBookingAmendStateError(current.status, 'assign-room')
			}
			if (current.assignedRoomId === input.roomId) {
				return current
			}
			const room = await roomService.getById(tenantId, input.roomId)
			if (!room) {
				throw new RoomAssignmentConflictError(
					'wrong_property',
					`room ${input.roomId} not found in tenant`,
				)
			}
			if (room.propertyId !== current.propertyId) {
				throw new RoomAssignmentConflictError(
					'wrong_property',
					`room.propertyId=${room.propertyId} != booking.propertyId=${current.propertyId}`,
				)
			}
			if (room.roomTypeId !== current.roomTypeId) {
				throw new RoomAssignmentConflictError(
					'wrong_room_type',
					`room.roomTypeId=${room.roomTypeId} != booking.roomTypeId=${current.roomTypeId}`,
				)
			}
			if (!room.isActive) {
				throw new RoomAssignmentConflictError(
					'room_inactive',
					`room ${input.roomId} isActive=false`,
				)
			}
			return repo.assignRoom(tenantId, id, {
				roomId: input.roomId,
				actorUserId,
			})
		},

		/**
		 * G8 (2026-05-16) — Mass auto-assign all confirmed unassigned bookings
		 * к available rooms per Interval-Partition Greedy algorithm.
		 *
		 * Pure algorithm (`planAutoAssign`) operates on snapshot;
		 * `batchAssignRooms` writes plan atomically. Partial-success
		 * preferred (Cloudbeds canon) — returns `{ assigned, skipped }` со
		 * causes. Existing assignments NEVER mutated (idempotency).
		 *
		 * Re-runnable safely: only previously-unassigned bookings touched.
		 */
		autoAssignUnassigned: async (
			tenantId: string,
			propertyId: string,
			actorUserId: string,
		): Promise<BookingAutoAssignResult> => {
			if (!roomService) {
				throw new Error('roomService not wired — G8 auto-assign requires factory update')
			}
			const prop = await propertyService.getById(tenantId, propertyId)
			if (!prop) throw new PropertyNotFoundError(propertyId)

			const [unassigned, existingPins, rooms] = await Promise.all([
				repo.listUnassignedByProperty(tenantId, propertyId),
				repo.listAssignmentsByProperty(tenantId, propertyId),
				roomService.listByProperty(tenantId, propertyId, { includeInactive: true }),
			])

			const plan = planAutoAssign({
				unassigned: unassigned.map((b) => ({
					id: b.id,
					roomTypeId: b.roomTypeId,
					checkIn: b.checkIn,
					checkOut: b.checkOut,
				})),
				rooms: rooms.map((r) => ({
					id: r.id,
					roomTypeId: r.roomTypeId,
					roomNumber: r.number,
					isActive: r.isActive,
				})),
				existingPins: existingPins
					.filter((b) => b.assignedRoomId !== null)
					.map((b) => ({
						bookingId: b.id,
						// biome-ignore lint/style/noNonNullAssertion: filter above guarantees non-null per type-narrowing limitation
						roomId: b.assignedRoomId!,
						checkIn: b.checkIn,
						checkOut: b.checkOut,
					})),
			})

			await repo.batchAssignRooms(tenantId, plan.assigned, actorUserId)
			return plan
		},

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
