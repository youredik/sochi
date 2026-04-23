import type {
	Booking,
	BookingChannelCode,
	BookingCreateInput,
	BookingExternalReferences,
	BookingFeeSnapshot,
	BookingGuestSnapshot,
	BookingRegistrationStatus,
	BookingRklCheckResult,
	BookingStatus,
	BookingTimeSlice,
} from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import {
	dateFromIso,
	NULL_TEXT,
	NULL_TIMESTAMP,
	timestampOpt,
	toJson,
	toTs,
	tsFromIso,
} from '../../db/ydb-helpers.ts'
import {
	BookingExternalIdTakenError,
	InvalidBookingTransitionError,
	NoInventoryError,
} from '../../errors/domain.ts'

type SqlInstance = typeof SQL

type BookingRow = {
	tenantId: string
	propertyId: string
	checkIn: Date
	id: string
	checkOut: Date
	roomTypeId: string
	ratePlanId: string
	assignedRoomId: string | null
	guestsCount: number | bigint
	nightsCount: number | bigint
	primaryGuestId: string
	// @ydbjs/query auto-parses `Json` columns into JS values (not strings).
	// BigInts inside were serialized as decimal strings on the write side
	// (see `toJson` in ydb-helpers) and must be reconstructed here.
	guestSnapshot: BookingGuestSnapshot
	status: string
	confirmedAt: Date
	checkedInAt: Date | null
	checkedOutAt: Date | null
	cancelledAt: Date | null
	noShowAt: Date | null
	cancelReason: string | null
	channelCode: string
	externalId: string | null
	externalReferences: BookingExternalReferences | null
	totalMicros: number | bigint
	paidMicros: number | bigint
	currency: string
	timeSlices: Array<Omit<BookingTimeSlice, 'grossMicros'> & { grossMicros: string | bigint }>
	cancellationFee:
		| (Omit<BookingFeeSnapshot, 'amountMicros'> & { amountMicros: string | bigint })
		| null
	noShowFee: (Omit<BookingFeeSnapshot, 'amountMicros'> & { amountMicros: string | bigint }) | null
	registrationStatus: string
	registrationMvdId: string | null
	registrationSubmittedAt: Date | null
	rklCheckResult: string
	rklCheckedAt: Date | null
	tourismTaxBaseMicros: number | bigint
	tourismTaxMicros: number | bigint
	notes: string | null
	createdAt: Date
	updatedAt: Date
	createdBy: string
	updatedBy: string
}

function hydrateTimeSlices(raw: BookingRow['timeSlices']): BookingTimeSlice[] {
	return raw.map((s) => ({ ...s, grossMicros: BigInt(s.grossMicros) }))
}

function hydrateFeeSnapshotOrNull(raw: BookingRow['cancellationFee']): BookingFeeSnapshot | null {
	return raw === null ? null : { ...raw, amountMicros: BigInt(raw.amountMicros) }
}

function microsToString(v: number | bigint): string {
	return typeof v === 'bigint' ? v.toString() : BigInt(v).toString()
}

function rowToBooking(r: BookingRow): Booking {
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		checkIn: r.checkIn.toISOString().slice(0, 10),
		id: r.id,
		checkOut: r.checkOut.toISOString().slice(0, 10),
		roomTypeId: r.roomTypeId,
		ratePlanId: r.ratePlanId,
		assignedRoomId: r.assignedRoomId,
		guestsCount: Number(r.guestsCount),
		nightsCount: Number(r.nightsCount),
		primaryGuestId: r.primaryGuestId,
		guestSnapshot: r.guestSnapshot,
		status: r.status as BookingStatus,
		confirmedAt: r.confirmedAt.toISOString(),
		checkedInAt: r.checkedInAt?.toISOString() ?? null,
		checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
		cancelledAt: r.cancelledAt?.toISOString() ?? null,
		noShowAt: r.noShowAt?.toISOString() ?? null,
		cancelReason: r.cancelReason,
		channelCode: r.channelCode as BookingChannelCode,
		externalId: r.externalId,
		externalReferences: r.externalReferences,
		totalMicros: microsToString(r.totalMicros),
		paidMicros: microsToString(r.paidMicros),
		currency: r.currency,
		timeSlices: hydrateTimeSlices(r.timeSlices),
		cancellationFee: hydrateFeeSnapshotOrNull(r.cancellationFee),
		noShowFee: hydrateFeeSnapshotOrNull(r.noShowFee),
		registrationStatus: r.registrationStatus as BookingRegistrationStatus,
		registrationMvdId: r.registrationMvdId,
		registrationSubmittedAt: r.registrationSubmittedAt?.toISOString() ?? null,
		rklCheckResult: r.rklCheckResult as BookingRklCheckResult,
		rklCheckedAt: r.rklCheckedAt?.toISOString() ?? null,
		tourismTaxBaseMicros: microsToString(r.tourismTaxBaseMicros),
		tourismTaxMicros: microsToString(r.tourismTaxMicros),
		notes: r.notes,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}
}

/**
 * Compute the inclusive date list `[checkIn, checkIn+1, ..., checkOut-1]`.
 * YDB `availability` keys nights by their arrival date, so the last date is
 * `checkOut - 1 day` (exclusive checkout convention).
 */
function nightsBetween(checkIn: string, checkOut: string): string[] {
	const start = new Date(`${checkIn}T00:00:00Z`)
	const end = new Date(`${checkOut}T00:00:00Z`)
	const out: string[] = []
	const cursor = new Date(start)
	while (cursor < end) {
		out.push(cursor.toISOString().slice(0, 10))
		cursor.setUTCDate(cursor.getUTCDate() + 1)
	}
	return out
}

type BookingCreateContext = {
	actorUserId: string
	/** Per-night snapshot (frozen at create). Summed to set totalMicros. */
	timeSlices: BookingTimeSlice[]
	/** Cancellation policy snapshot; null for non-refundable (fee handled via noShowFee pattern). */
	cancellationFee: BookingFeeSnapshot | null
	noShowFee: BookingFeeSnapshot | null
	/** Tourism tax base (accommodation-only revenue sum in micros). */
	tourismTaxBaseMicros: bigint
	tourismTaxMicros: bigint
	registrationStatus: BookingRegistrationStatus
	rklCheckResult: BookingRklCheckResult
}

/**
 * Booking repository — atomic inventory + booking writes inside
 * `sql.begin({ idempotent: true })`. YDB default Serializable isolation +
 * optimistic concurrency control catches overbooking races and retries the
 * loser automatically (see `project_event_architecture.md`, #2 Overbooking).
 *
 * Key invariants this repo enforces:
 *   - On create: for every night in [checkIn, checkOut), availability row
 *     must exist, must NOT be stopSell, and must have `sold < allotment`.
 *   - On create: availability.sold atomically increments by 1 per night in
 *     the same tx as booking INSERT. Never 2-phase.
 *   - On cancel: booking transitions to 'cancelled' ONLY from non-terminal
 *     states (confirmed / in_house). `cancelled`/`checked_out`/`no_show` are
 *     terminal; re-cancel throws InvalidBookingTransitionError.
 *   - On cancel: for every night, availability.sold decrements by 1 in the
 *     same tx. Inventory returned to the pool.
 *   - `UNIQUE (tenantId, propertyId, externalId)` prevents duplicate bookings
 *     from OTA retries; violation surfaces as BookingExternalIdTakenError.
 *   - Immutable fields preserved across all transitions: id, tenantId,
 *     propertyId, checkIn (PK), createdAt, createdBy, confirmedAt.
 */
export function createBookingRepo(sql: SqlInstance) {
	return {
		async getById(tenantId: string, id: string): Promise<Booking | null> {
			const [rows = []] = await sql<BookingRow[]>`
				SELECT * FROM booking VIEW ixBookingId
				WHERE id = ${id} AND tenantId = ${tenantId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToBooking(row) : null
		},

		async listByProperty(
			tenantId: string,
			propertyId: string,
			opts: { from?: string; to?: string; status?: BookingStatus; roomTypeId?: string },
		): Promise<Booking[]> {
			// PK range scan on (tenantId, propertyId, checkIn, id). Other filters
			// evaluated post-scan; acceptable at SMB volumes (<10k bookings/property/year).
			const from = opts.from ? dateFromIso(opts.from) : dateFromIso('1970-01-01')
			const to = opts.to ? dateFromIso(opts.to) : dateFromIso('2099-12-31')
			const [rows = []] = await sql<BookingRow[]>`
				SELECT * FROM booking
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND checkIn >= ${from}
					AND checkIn <= ${to}
				ORDER BY checkIn ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows
				.filter((r) => {
					if (opts.status && r.status !== opts.status) return false
					if (opts.roomTypeId && r.roomTypeId !== opts.roomTypeId) return false
					return true
				})
				.map(rowToBooking)
		},

		async create(
			tenantId: string,
			propertyId: string,
			input: BookingCreateInput,
			ctx: BookingCreateContext,
		): Promise<Booking> {
			const id = newId('booking')
			const now = new Date()
			const nowTs = toTs(now)
			const nights = nightsBetween(input.checkIn, input.checkOut)
			const nightsCount = nights.length
			const totalMicros = ctx.timeSlices.reduce((acc, s) => acc + s.grossMicros, 0n)

			if (ctx.timeSlices.length !== nightsCount) {
				throw new NoInventoryError(
					`timeSlices length ${ctx.timeSlices.length} != nights count ${nightsCount}`,
				)
			}

			try {
				return await sql.begin(async (tx) => {
					// Pre-check externalId uniqueness if provided (UNIQUE index also catches at commit).
					if (input.externalId) {
						const [collision = []] = await tx<{ id: string }[]>`
							SELECT id FROM booking VIEW ixBookingExternal
							WHERE tenantId = ${tenantId}
								AND propertyId = ${propertyId}
								AND externalId = ${input.externalId}
							LIMIT 1
						`
						if (collision[0]) throw new BookingExternalIdTakenError(input.externalId)
					}

					// Read availability for each night, check + update sold in the same tx.
					// OCC range-locks: concurrent writers get ABORTED/TRANSACTION_LOCKS_INVALIDATED.
					for (const night of nights) {
						const [availRows = []] = await tx<
							{ allotment: number | bigint; sold: number | bigint; stopSell: boolean }[]
						>`
							SELECT allotment, sold, stopSell FROM availability
							WHERE tenantId = ${tenantId}
								AND propertyId = ${propertyId}
								AND roomTypeId = ${input.roomTypeId}
								AND date = ${dateFromIso(night)}
							LIMIT 1
						`
						const avail = availRows[0]
						if (!avail) {
							throw new NoInventoryError(`no availability row for ${night}`)
						}
						if (avail.stopSell) {
							throw new NoInventoryError(`stopSell set for ${night}`)
						}
						const sold = Number(avail.sold)
						const allotment = Number(avail.allotment)
						if (sold >= allotment) {
							throw new NoInventoryError(`sold ${sold} >= allotment ${allotment} for ${night}`)
						}
						await tx`
							UPDATE availability SET sold = sold + 1, updatedAt = ${nowTs}
							WHERE tenantId = ${tenantId}
								AND propertyId = ${propertyId}
								AND roomTypeId = ${input.roomTypeId}
								AND date = ${dateFromIso(night)}
						`
					}

					const externalId = input.externalId ?? NULL_TEXT
					const externalReferences = toJson(input.externalReferences)
					const cancellationFee = toJson(ctx.cancellationFee)
					const noShowFee = toJson(ctx.noShowFee)
					const notes = input.notes ?? NULL_TEXT
					const guestSnapshotJson = toJson(input.guestSnapshot)
					const timeSlicesJson = toJson(ctx.timeSlices)

					await tx`
						UPSERT INTO booking (
							\`tenantId\`, \`propertyId\`, \`checkIn\`, \`id\`,
							\`checkOut\`, \`roomTypeId\`, \`ratePlanId\`, \`assignedRoomId\`,
							\`guestsCount\`, \`nightsCount\`,
							\`primaryGuestId\`, \`guestSnapshot\`,
							\`status\`, \`confirmedAt\`,
							\`checkedInAt\`, \`checkedOutAt\`, \`cancelledAt\`, \`noShowAt\`, \`cancelReason\`,
							\`channelCode\`, \`externalId\`, \`externalReferences\`,
							\`totalMicros\`, \`paidMicros\`, \`currency\`, \`timeSlices\`,
							\`cancellationFee\`, \`noShowFee\`,
							\`registrationStatus\`, \`registrationMvdId\`, \`registrationSubmittedAt\`,
							\`rklCheckResult\`, \`rklCheckedAt\`,
							\`tourismTaxBaseMicros\`, \`tourismTaxMicros\`,
							\`notes\`, \`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
						) VALUES (
							${tenantId}, ${propertyId}, ${dateFromIso(input.checkIn)}, ${id},
							${dateFromIso(input.checkOut)}, ${input.roomTypeId}, ${input.ratePlanId}, ${NULL_TEXT},
							${input.guestsCount}, ${nightsCount},
							${input.primaryGuestId}, ${guestSnapshotJson},
							${'confirmed'}, ${nowTs},
							${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
							${input.channelCode}, ${externalId}, ${externalReferences},
							${totalMicros}, ${0n}, ${ctx.timeSlices[0]?.currency ?? 'RUB'}, ${timeSlicesJson},
							${cancellationFee}, ${noShowFee},
							${ctx.registrationStatus}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
							${ctx.rklCheckResult}, ${NULL_TIMESTAMP},
							${ctx.tourismTaxBaseMicros}, ${ctx.tourismTaxMicros},
							${notes}, ${nowTs}, ${nowTs}, ${ctx.actorUserId}, ${ctx.actorUserId}
						)
					`

					return {
						tenantId,
						propertyId,
						checkIn: input.checkIn,
						id,
						checkOut: input.checkOut,
						roomTypeId: input.roomTypeId,
						ratePlanId: input.ratePlanId,
						assignedRoomId: null,
						guestsCount: input.guestsCount,
						nightsCount,
						primaryGuestId: input.primaryGuestId,
						guestSnapshot: input.guestSnapshot,
						status: 'confirmed',
						confirmedAt: now.toISOString(),
						checkedInAt: null,
						checkedOutAt: null,
						cancelledAt: null,
						noShowAt: null,
						cancelReason: null,
						channelCode: input.channelCode,
						externalId: input.externalId ?? null,
						externalReferences: input.externalReferences ?? null,
						totalMicros: totalMicros.toString(),
						paidMicros: '0',
						currency: ctx.timeSlices[0]?.currency ?? 'RUB',
						timeSlices: ctx.timeSlices,
						cancellationFee: ctx.cancellationFee,
						noShowFee: ctx.noShowFee,
						registrationStatus: ctx.registrationStatus,
						registrationMvdId: null,
						registrationSubmittedAt: null,
						rklCheckResult: ctx.rklCheckResult,
						rklCheckedAt: null,
						tourismTaxBaseMicros: ctx.tourismTaxBaseMicros.toString(),
						tourismTaxMicros: ctx.tourismTaxMicros.toString(),
						notes: input.notes ?? null,
						createdAt: now.toISOString(),
						updatedAt: now.toISOString(),
						createdBy: ctx.actorUserId,
						updatedBy: ctx.actorUserId,
					}
				})
			} catch (err) {
				// Unwrap `Transaction failed.` cause wrapping (project_ydb_specifics #11).
				if (err instanceof Error && err.cause instanceof NoInventoryError) throw err.cause
				if (err instanceof Error && err.cause instanceof BookingExternalIdTakenError)
					throw err.cause
				throw err
			}
		},

		async cancel(
			tenantId: string,
			id: string,
			reason: string,
			actorUserId: string,
		): Promise<Booking | null> {
			try {
				return await sql.begin(async (tx) => {
					// Load by PK via id-index (booking PK is compound but id-alone is a SYNC index).
					const [rows = []] = await tx<BookingRow[]>`
						SELECT * FROM booking VIEW ixBookingId
						WHERE id = ${id} AND tenantId = ${tenantId}
						LIMIT 1
					`
					const row = rows[0]
					if (!row) return null
					const current = rowToBooking(row)

					// Only non-terminal states can cancel. Terminal: cancelled, no_show, checked_out.
					if (
						current.status === 'cancelled' ||
						current.status === 'no_show' ||
						current.status === 'checked_out'
					) {
						throw new InvalidBookingTransitionError(current.status, 'cancelled')
					}

					const now = new Date()
					const nowTs = toTs(now)
					const nights = nightsBetween(current.checkIn, current.checkOut)

					// Return inventory — decrement sold for each night.
					for (const night of nights) {
						await tx`
							UPDATE availability SET sold = sold - 1, updatedAt = ${nowTs}
							WHERE tenantId = ${tenantId}
								AND propertyId = ${current.propertyId}
								AND roomTypeId = ${current.roomTypeId}
								AND date = ${dateFromIso(night)}
								AND sold > 0
						`
					}

					// UPSERT full row — UPDATE ... SET on nullable columns hits YDB strict
					// type inference ("Expected optional, but got: Utf8"); UPSERT tolerates
					// bare values for nullable cols. See `project_ydb_specifics.md` #14.
					const externalIdBind = current.externalId ?? NULL_TEXT
					const externalRefBind = toJson(current.externalReferences)
					const cancellationFeeBind = toJson(current.cancellationFee)
					const noShowFeeBind = toJson(current.noShowFee)
					const notesBind = current.notes ?? NULL_TEXT
					const assignedRoomBind = current.assignedRoomId ?? NULL_TEXT
					const registrationMvdBind = current.registrationMvdId ?? NULL_TEXT

					await tx`
						UPSERT INTO booking (
							\`tenantId\`, \`propertyId\`, \`checkIn\`, \`id\`,
							\`checkOut\`, \`roomTypeId\`, \`ratePlanId\`, \`assignedRoomId\`,
							\`guestsCount\`, \`nightsCount\`,
							\`primaryGuestId\`, \`guestSnapshot\`,
							\`status\`, \`confirmedAt\`,
							\`checkedInAt\`, \`checkedOutAt\`, \`cancelledAt\`, \`noShowAt\`, \`cancelReason\`,
							\`channelCode\`, \`externalId\`, \`externalReferences\`,
							\`totalMicros\`, \`paidMicros\`, \`currency\`, \`timeSlices\`,
							\`cancellationFee\`, \`noShowFee\`,
							\`registrationStatus\`, \`registrationMvdId\`, \`registrationSubmittedAt\`,
							\`rklCheckResult\`, \`rklCheckedAt\`,
							\`tourismTaxBaseMicros\`, \`tourismTaxMicros\`,
							\`notes\`, \`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
						) VALUES (
							${tenantId}, ${current.propertyId}, ${dateFromIso(current.checkIn)}, ${id},
							${dateFromIso(current.checkOut)}, ${current.roomTypeId}, ${current.ratePlanId}, ${assignedRoomBind},
							${current.guestsCount}, ${current.nightsCount},
							${current.primaryGuestId}, ${toJson(current.guestSnapshot)},
							${'cancelled'}, ${tsFromIso(current.confirmedAt)},
							${timestampOpt(current.checkedInAt ? new Date(current.checkedInAt) : null)},
							${timestampOpt(current.checkedOutAt ? new Date(current.checkedOutAt) : null)},
							${nowTs},
							${timestampOpt(current.noShowAt ? new Date(current.noShowAt) : null)},
							${reason},
							${current.channelCode}, ${externalIdBind}, ${externalRefBind},
							${BigInt(current.totalMicros)}, ${BigInt(current.paidMicros)},
							${current.currency}, ${toJson(current.timeSlices)},
							${cancellationFeeBind}, ${noShowFeeBind},
							${current.registrationStatus}, ${registrationMvdBind},
							${timestampOpt(current.registrationSubmittedAt ? new Date(current.registrationSubmittedAt) : null)},
							${current.rklCheckResult},
							${timestampOpt(current.rklCheckedAt ? new Date(current.rklCheckedAt) : null)},
							${BigInt(current.tourismTaxBaseMicros)}, ${BigInt(current.tourismTaxMicros)},
							${notesBind}, ${tsFromIso(current.createdAt)}, ${nowTs},
							${current.createdBy}, ${actorUserId}
						)
					`

					return {
						...current,
						status: 'cancelled',
						cancelledAt: now.toISOString(),
						cancelReason: reason,
						updatedAt: now.toISOString(),
						updatedBy: actorUserId,
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingTransitionError)
					throw err.cause
				throw err
			}
		},
	}
}

export type BookingRepo = ReturnType<typeof createBookingRepo>

/** Exported for tests that seed `availability` by night-list. */
export const __bookingRepoInternals = { nightsBetween }
