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
import { YDBError } from '@ydbjs/error'
import type { TX } from '@ydbjs/query'
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
	InvalidBookingAmendStateError,
	InvalidBookingTransitionError,
	NoInventoryError,
	RoomAssignmentConflictError,
} from '../../errors/domain.ts'

/**
 * YDB PRECONDITION_FAILED status (issueCode 2012 «Conflict with existing key»).
 * Surfaces from `INSERT INTO roomNightOccupancy` when (tenantId, propertyId,
 * roomId, date) PK already taken — i.e. DB-level overbooking-prevention canon
 * 2026-05-18 catches an attempted double-pin.
 *
 * Same code surfaces from any GLOBAL UNIQUE SYNC index violation (e.g.
 * `ixBookingExternal` UNIQUE on externalId), so caller MUST disambiguate by
 * which write threw — see `assignRoom` / `moveDates` callsites.
 */
const YDB_PRECONDITION_FAILED = 400120
function isPkOrUniqueConflict(err: unknown): err is YDBError {
	return err instanceof YDBError && err.code === YDB_PRECONDITION_FAILED
}

/**
 * INSERT a per-night occupancy row inside `tx`. PK collision = another booking
 * already owns this (roomId, date) — caller catches via `isPkOrUniqueConflict`
 * + translates к `RoomAssignmentConflictError('room_occupied')`. Per agent
 * research 2026-05-18: this is the YDB-canonical replacement для Postgres
 * `EXCLUDE USING gist (... WITH &&)` since YDB lacks range types and CHECK
 * constraints. Apaleo + Mews 2026 production canon use same per-night
 * materialization pattern.
 */
async function insertOccupancyForNights(
	tx: TX,
	tenantId: string,
	propertyId: string,
	roomId: string,
	bookingId: string,
	nights: string[],
	nowTs: ReturnType<typeof toTs>,
): Promise<void> {
	for (const night of nights) {
		await tx`
			INSERT INTO roomNightOccupancy (
				\`tenantId\`, \`propertyId\`, \`roomId\`, \`date\`, \`bookingId\`, \`createdAt\`
			) VALUES (
				${tenantId}, ${propertyId}, ${roomId}, ${dateFromIso(night)}, ${bookingId}, ${nowTs}
			)
		`
	}
}

/**
 * DELETE per-night occupancy rows by exact PK (tenantId, propertyId, roomId,
 * date). Used by cancel / checkOut / moveDates / changeRoomType. Idempotent —
 * DELETE WHERE non-existent PK = 0 rows affected, no error.
 */
async function deleteOccupancyForNights(
	tx: TX,
	tenantId: string,
	propertyId: string,
	roomId: string,
	nights: string[],
): Promise<void> {
	for (const night of nights) {
		await tx`
			DELETE FROM roomNightOccupancy
			WHERE tenantId = ${tenantId}
				AND propertyId = ${propertyId}
				AND roomId = ${roomId}
				AND date = ${dateFromIso(night)}
		`
	}
}

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

/**
 * Shape of the transition change passed to `upsertBookingRow`. Every non-required
 * field is optional — unspecified = keep current row value, `null` = clear.
 */
type TransitionOverride = {
	status: BookingStatus
	updatedAt: Date
	updatedBy: string
	assignedRoomId?: string | null
	checkedInAt?: Date | null
	checkedOutAt?: Date | null
	cancelledAt?: Date | null
	noShowAt?: Date | null
	cancelReason?: string | null
}

/**
 * UPSERT the full booking row with selective field overrides, preserving all
 * non-overridden fields. Called inside `sql.begin(tx => ...)` after the caller
 * has asserted the transition is allowed.
 *
 * Why full-row UPSERT (not UPDATE): see `project_ydb_specifics.md` #14 — YDB
 * `UPDATE ... SET` on mixed NOT NULL + nullable columns fails with
 * "Expected optional, ... but got: Utf8". UPSERT tolerates bare values.
 */
async function upsertBookingRow(tx: TX, current: Booking, next: TransitionOverride): Promise<void> {
	const nowTs = toTs(next.updatedAt)
	const assignedRoomId = 'assignedRoomId' in next ? next.assignedRoomId : current.assignedRoomId
	const checkedInAtDate =
		'checkedInAt' in next
			? (next.checkedInAt ?? null)
			: current.checkedInAt
				? new Date(current.checkedInAt)
				: null
	const checkedOutAtDate =
		'checkedOutAt' in next
			? (next.checkedOutAt ?? null)
			: current.checkedOutAt
				? new Date(current.checkedOutAt)
				: null
	const cancelledAtDate =
		'cancelledAt' in next
			? (next.cancelledAt ?? null)
			: current.cancelledAt
				? new Date(current.cancelledAt)
				: null
	const noShowAtDate =
		'noShowAt' in next
			? (next.noShowAt ?? null)
			: current.noShowAt
				? new Date(current.noShowAt)
				: null
	const cancelReason = 'cancelReason' in next ? next.cancelReason : current.cancelReason

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
			${current.tenantId}, ${current.propertyId}, ${dateFromIso(current.checkIn)}, ${current.id},
			${dateFromIso(current.checkOut)}, ${current.roomTypeId}, ${current.ratePlanId},
			${assignedRoomId ?? NULL_TEXT},
			${current.guestsCount}, ${current.nightsCount},
			${current.primaryGuestId}, ${toJson(current.guestSnapshot)},
			${next.status}, ${tsFromIso(current.confirmedAt)},
			${timestampOpt(checkedInAtDate)},
			${timestampOpt(checkedOutAtDate)},
			${timestampOpt(cancelledAtDate)},
			${timestampOpt(noShowAtDate)},
			${cancelReason ?? NULL_TEXT},
			${current.channelCode}, ${current.externalId ?? NULL_TEXT}, ${toJson(current.externalReferences)},
			${BigInt(current.totalMicros)}, ${BigInt(current.paidMicros)},
			${current.currency}, ${toJson(current.timeSlices)},
			${toJson(current.cancellationFee)}, ${toJson(current.noShowFee)},
			${current.registrationStatus}, ${current.registrationMvdId ?? NULL_TEXT},
			${timestampOpt(current.registrationSubmittedAt ? new Date(current.registrationSubmittedAt) : null)},
			${current.rklCheckResult},
			${timestampOpt(current.rklCheckedAt ? new Date(current.rklCheckedAt) : null)},
			${BigInt(current.tourismTaxBaseMicros)}, ${BigInt(current.tourismTaxMicros)},
			${current.notes ?? NULL_TEXT}, ${tsFromIso(current.createdAt)}, ${nowTs},
			${current.createdBy}, ${next.updatedBy}
		)
	`
}

/**
 * G5 Apaleo Amend-Stay 2026-05-15 — fields amend-able post-create.
 *
 * Mutually exclusive с TransitionOverride (status stays `current.status` для
 * all amends — they don't transition). Repo helper merges next.X ?? current.X
 * для each field (same UPSERT-as-merge canon as upsertBookingRow but for the
 * post-create-time-mutable subset).
 */
type AmendOverride = {
	updatedAt: Date
	updatedBy: string
	checkIn?: string
	checkOut?: string
	roomTypeId?: string
	ratePlanId?: string
	/**
	 * Explicit clear allowed (defensive): roomType swap orphan-fies any
	 * previously-pinned specific room (which lived в old roomType). Use
	 * `assignedRoomId: null` when amend operation must invalidate pin.
	 */
	assignedRoomId?: string | null
	guestsCount?: number
	nightsCount?: number
	timeSlices?: BookingTimeSlice[]
	totalMicros?: bigint
	cancellationFee?: BookingFeeSnapshot | null
	noShowFee?: BookingFeeSnapshot | null
	tourismTaxBaseMicros?: bigint
	tourismTaxMicros?: bigint
}

/**
 * UPSERT booking row с amend-field overrides. Status / audit timestamps /
 * transition state preserved verbatim from `current`. Distinct from
 * `upsertBookingRow` (transitions) — same SQL shape but mutable field set
 * differs canonically (amends touch dates/rates/guests; transitions touch
 * status/checkedAt/cancelledAt).
 */
async function upsertAmendedBookingRow(
	tx: TX,
	current: Booking,
	next: AmendOverride,
): Promise<void> {
	const nowTs = toTs(next.updatedAt)
	const checkIn = next.checkIn ?? current.checkIn
	const checkOut = next.checkOut ?? current.checkOut
	const roomTypeId = next.roomTypeId ?? current.roomTypeId
	const ratePlanId = next.ratePlanId ?? current.ratePlanId
	const assignedRoomId = 'assignedRoomId' in next ? next.assignedRoomId : current.assignedRoomId
	const guestsCount = next.guestsCount ?? current.guestsCount
	const nightsCount = next.nightsCount ?? current.nightsCount
	const timeSlices = next.timeSlices ?? current.timeSlices
	const totalMicros = next.totalMicros ?? BigInt(current.totalMicros)
	const cancellationFee = 'cancellationFee' in next ? next.cancellationFee : current.cancellationFee
	const noShowFee = 'noShowFee' in next ? next.noShowFee : current.noShowFee
	const tourismTaxBaseMicros = next.tourismTaxBaseMicros ?? BigInt(current.tourismTaxBaseMicros)
	const tourismTaxMicros = next.tourismTaxMicros ?? BigInt(current.tourismTaxMicros)

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
			${current.tenantId}, ${current.propertyId}, ${dateFromIso(checkIn)}, ${current.id},
			${dateFromIso(checkOut)}, ${roomTypeId}, ${ratePlanId},
			${assignedRoomId ?? NULL_TEXT},
			${guestsCount}, ${nightsCount},
			${current.primaryGuestId}, ${toJson(current.guestSnapshot)},
			${current.status}, ${tsFromIso(current.confirmedAt)},
			${timestampOpt(current.checkedInAt ? new Date(current.checkedInAt) : null)},
			${timestampOpt(current.checkedOutAt ? new Date(current.checkedOutAt) : null)},
			${timestampOpt(current.cancelledAt ? new Date(current.cancelledAt) : null)},
			${timestampOpt(current.noShowAt ? new Date(current.noShowAt) : null)},
			${current.cancelReason ?? NULL_TEXT},
			${current.channelCode}, ${current.externalId ?? NULL_TEXT},
			${toJson(current.externalReferences)},
			${totalMicros}, ${BigInt(current.paidMicros)},
			${current.currency}, ${toJson(timeSlices)},
			${toJson(cancellationFee)}, ${toJson(noShowFee)},
			${current.registrationStatus}, ${current.registrationMvdId ?? NULL_TEXT},
			${timestampOpt(current.registrationSubmittedAt ? new Date(current.registrationSubmittedAt) : null)},
			${current.rklCheckResult},
			${timestampOpt(current.rklCheckedAt ? new Date(current.rklCheckedAt) : null)},
			${tourismTaxBaseMicros}, ${tourismTaxMicros},
			${current.notes ?? NULL_TEXT}, ${tsFromIso(current.createdAt)}, ${nowTs},
			${current.createdBy}, ${next.updatedBy}
		)
	`
}

/** Apply the same override semantics as upsertBookingRow in memory. */
function applyTransition(current: Booking, next: TransitionOverride): Booking {
	return {
		...current,
		status: next.status,
		updatedAt: next.updatedAt.toISOString(),
		updatedBy: next.updatedBy,
		...('assignedRoomId' in next ? { assignedRoomId: next.assignedRoomId ?? null } : {}),
		...('checkedInAt' in next
			? { checkedInAt: next.checkedInAt ? next.checkedInAt.toISOString() : null }
			: {}),
		...('checkedOutAt' in next
			? { checkedOutAt: next.checkedOutAt ? next.checkedOutAt.toISOString() : null }
			: {}),
		...('cancelledAt' in next
			? { cancelledAt: next.cancelledAt ? next.cancelledAt.toISOString() : null }
			: {}),
		...('noShowAt' in next ? { noShowAt: next.noShowAt ? next.noShowAt.toISOString() : null } : {}),
		...('cancelReason' in next ? { cancelReason: next.cancelReason ?? null } : {}),
	}
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
			// **Overlap filter** (NOT just `checkIn` range) — booking что
			// started ДО window но still in-progress overlaps view. Per
			// 2026-05-18 user-reported missing-bands bug: Сидоров in_house
			// May 17-21 had `checkIn=17 < from=18` так filtered out, но
			// Шахматка должна показывать его (overlaps view May 18-20).
			//
			// Same overlap pattern used by all sibling methods (lines 1190,
			// 1303, 1337). Pre-fix singleton bug used `checkIn >= from AND
			// checkIn <= to` — partition-prune friendly но semantically
			// wrong. Per `[[silent-clamp-anti-pattern]]` canon, silently
			// dropping operationally-visible bookings = data corruption.
			//
			// Partition pruning slightly degrades (no `checkIn >= from`
			// prune), но SMB scale (<10k bookings/property/year per comment
			// below) absorbs the extra scan rows.
			const from = opts.from ? dateFromIso(opts.from) : dateFromIso('1970-01-01')
			const to = opts.to ? dateFromIso(opts.to) : dateFromIso('2099-12-31')
			const [rows = []] = await sql<BookingRow[]>`
				SELECT * FROM booking
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND checkIn < ${to}
					AND checkOut > ${from}
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
				return await sql.begin({ idempotent: true }, async (tx) => {
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
					//
					// Effective allotment formula (Apaleo «Allowed Overbooking» canon 2026):
					//   `effective = allotment + oversellDelta` (default 0 if NULL)
					// Operator may +N для intentional oversell (revenue-mgr policy) or -N к
					// pull units offline без touching roomType.inventoryCount.
					for (const night of nights) {
						const [availRows = []] = await tx<
							{
								allotment: number | bigint
								sold: number | bigint
								stopSell: boolean
								oversellDelta: number | bigint | null
							}[]
						>`
							SELECT allotment, sold, stopSell, oversellDelta FROM availability
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
						const oversellDelta = avail.oversellDelta === null ? 0 : Number(avail.oversellDelta)
						const effective = allotment + oversellDelta
						if (sold >= effective) {
							throw new NoInventoryError(
								`sold ${sold} >= effective ${effective} (allotment ${allotment} + oversellDelta ${oversellDelta}) for ${night}`,
							)
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
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) return null

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

					// Release per-night occupancy если booking was pinned к specific room.
					// Cancelled booking frees the unit для future bookings — matches
					// sold-- decrement semantics.
					if (current.assignedRoomId !== null) {
						await deleteOccupancyForNights(
							tx,
							tenantId,
							current.propertyId,
							current.assignedRoomId,
							nights,
						)
					}

					const next: TransitionOverride = {
						status: 'cancelled',
						updatedAt: now,
						updatedBy: actorUserId,
						cancelledAt: now,
						cancelReason: reason,
					}
					await upsertBookingRow(tx, current, next)
					return applyTransition(current, next)
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingTransitionError)
					throw err.cause
				throw err
			}
		},

		async checkIn(
			tenantId: string,
			id: string,
			opts: { assignedRoomId?: string | null },
			actorUserId: string,
		): Promise<Booking | null> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) return null
					if (current.status !== 'confirmed') {
						throw new InvalidBookingTransitionError(current.status, 'in_house')
					}
					const now = new Date()
					const nowTs = toTs(now)
					const newPin =
						'assignedRoomId' in opts ? (opts.assignedRoomId ?? null) : current.assignedRoomId
					const oldPin = current.assignedRoomId

					// Occupancy sync — if pin changes at check-in time, atomically
					// rebalance. INSERT PK conflict (newPin already occupied) bubbles
					// out as PRECONDITION_FAILED → caller translates к
					// RoomAssignmentConflictError. Per overbooking-prevention canon
					// 2026-05-18 — closes the «operator pins room at check-in без
					// прохода через assignRoom» gap.
					if (oldPin !== newPin) {
						const nights = nightsBetween(current.checkIn, current.checkOut)
						if (oldPin !== null) {
							await deleteOccupancyForNights(tx, tenantId, current.propertyId, oldPin, nights)
						}
						if (newPin !== null) {
							await insertOccupancyForNights(
								tx,
								tenantId,
								current.propertyId,
								newPin,
								current.id,
								nights,
								nowTs,
							)
						}
					}

					const next: TransitionOverride = {
						status: 'in_house',
						updatedAt: now,
						updatedBy: actorUserId,
						checkedInAt: now,
						...('assignedRoomId' in opts ? { assignedRoomId: opts.assignedRoomId ?? null } : {}),
					}
					await upsertBookingRow(tx, current, next)
					return applyTransition(current, next)
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingTransitionError)
					throw err.cause
				if (err instanceof Error && err.cause instanceof RoomAssignmentConflictError)
					throw err.cause
				if (
					isPkOrUniqueConflict(err) ||
					(err instanceof Error && isPkOrUniqueConflict(err.cause))
				) {
					throw new RoomAssignmentConflictError(
						'room_occupied',
						'check-in target room overlaps another booking',
					)
				}
				throw err
			}
		},

		async checkOut(tenantId: string, id: string, actorUserId: string): Promise<Booking | null> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) return null
					if (current.status !== 'in_house') {
						throw new InvalidBookingTransitionError(current.status, 'checked_out')
					}
					const now = new Date()
					// Release per-night occupancy — guest is gone, room becomes available
					// for future bookings. `sold` counter intentionally NOT decremented
					// (revenue happened, audit retain). Occupancy is physical-state,
					// distinct from accounting-state.
					if (current.assignedRoomId !== null) {
						const nights = nightsBetween(current.checkIn, current.checkOut)
						await deleteOccupancyForNights(
							tx,
							tenantId,
							current.propertyId,
							current.assignedRoomId,
							nights,
						)
					}
					const next: TransitionOverride = {
						status: 'checked_out',
						updatedAt: now,
						updatedBy: actorUserId,
						checkedOutAt: now,
					}
					await upsertBookingRow(tx, current, next)
					return applyTransition(current, next)
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingTransitionError)
					throw err.cause
				throw err
			}
		},

		async markNoShow(
			tenantId: string,
			id: string,
			reason: string | null,
			actorUserId: string,
		): Promise<Booking | null> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) return null
					// `no_show` can only be set BEFORE check-in (guest didn't arrive).
					// After check-in the correct transition is `checked_out` with adjustments.
					if (current.status !== 'confirmed') {
						throw new InvalidBookingTransitionError(current.status, 'no_show')
					}
					const now = new Date()
					const next: TransitionOverride = {
						status: 'no_show',
						updatedAt: now,
						updatedBy: actorUserId,
						noShowAt: now,
						cancelReason: reason,
					}
					// Inventory intentionally NOT decremented: the hotel committed the
					// room and guest didn't arrive; the unit stays "consumed" for audit
					// and revenue integrity. Front desk releases manually if wanted.
					await upsertBookingRow(tx, current, next)
					return applyTransition(current, next)
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingTransitionError)
					throw err.cause
				throw err
			}
		},

		// -------------------------------------------------------------------
		// G5 Apaleo Amend-Stay 2026-05-15 — pre-arrival booking modifications.
		// All three operations atomic in single sql.begin tx с idempotent:true.
		// -------------------------------------------------------------------

		/**
		 * Move stay window (PATCH /bookings/:id/move-dates).
		 *
		 * Inventory rebalance: release `sold-1` for nights ∈ (old \ new),
		 * reserve `sold+1` for nights ∈ (new \ old) с stopSell + allotment
		 * checks (same as create flow). Nights in both sets untouched.
		 *
		 * Status guard: confirmed-only. `in_house` rejected — once guest
		 * checks in, dates are committed (audit + folio integrity).
		 *
		 * Caller (service) computes new timeSlices / totalMicros / fees /
		 * tourismTax from new rate rows. Repo only writes the atomic mutation.
		 */
		async moveDates(
			tenantId: string,
			id: string,
			ctx: {
				newCheckIn: string
				newCheckOut: string
				timeSlices: BookingTimeSlice[]
				cancellationFee: BookingFeeSnapshot | null
				noShowFee: BookingFeeSnapshot | null
				tourismTaxBaseMicros: bigint
				tourismTaxMicros: bigint
				actorUserId: string
			},
		): Promise<Booking | null> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) return null
					if (current.status !== 'confirmed') {
						throw new InvalidBookingAmendStateError(current.status, 'move-dates')
					}

					const now = new Date()
					const nowTs = toTs(now)
					const oldNights = nightsBetween(current.checkIn, current.checkOut)
					const newNights = nightsBetween(ctx.newCheckIn, ctx.newCheckOut)
					if (newNights.length === 0) {
						throw new NoInventoryError('checkIn must be strictly before checkOut')
					}
					if (ctx.timeSlices.length !== newNights.length) {
						throw new NoInventoryError(
							`timeSlices length ${ctx.timeSlices.length} != newNights count ${newNights.length}`,
						)
					}
					const oldSet = new Set(oldNights)
					const newSet = new Set(newNights)

					// Release inventory для nights ∈ (old \ new). Guard sold > 0 so
					// double-release не corrupts (defensive; tx idempotency catches re-run).
					for (const night of oldNights) {
						if (newSet.has(night)) continue
						await tx`
							UPDATE availability SET sold = sold - 1, updatedAt = ${nowTs}
							WHERE tenantId = ${tenantId}
								AND propertyId = ${current.propertyId}
								AND roomTypeId = ${current.roomTypeId}
								AND date = ${dateFromIso(night)}
								AND sold > 0
						`
					}

					// Reserve inventory для nights ∈ (new \ old) с allotment + stopSell
					// guards (matches create-flow canon). Effective allotment includes
					// oversellDelta per Apaleo canon.
					for (const night of newNights) {
						if (oldSet.has(night)) continue
						const [availRows = []] = await tx<
							{
								allotment: number | bigint
								sold: number | bigint
								stopSell: boolean
								oversellDelta: number | bigint | null
							}[]
						>`
							SELECT allotment, sold, stopSell, oversellDelta FROM availability
							WHERE tenantId = ${tenantId}
								AND propertyId = ${current.propertyId}
								AND roomTypeId = ${current.roomTypeId}
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
						const oversellDelta = avail.oversellDelta === null ? 0 : Number(avail.oversellDelta)
						const effective = allotment + oversellDelta
						if (sold >= effective) {
							throw new NoInventoryError(
								`sold ${sold} >= effective ${effective} (allotment ${allotment} + oversellDelta ${oversellDelta}) for ${night}`,
							)
						}
						await tx`
							UPDATE availability SET sold = sold + 1, updatedAt = ${nowTs}
							WHERE tenantId = ${tenantId}
								AND propertyId = ${current.propertyId}
								AND roomTypeId = ${current.roomTypeId}
								AND date = ${dateFromIso(night)}
						`
					}

					// **Gap B fix (2026-05-18)** — rebalance per-night occupancy if booking
					// is pinned. Pre-fix: `moveDates` updated booking row + availability
					// counter but SILENTLY skipped overlap check on assignedRoomId →
					// pinned booking could be moved into nights already occupied by
					// another pinned booking. INSERT here triggers PK conflict if any
					// new night already taken → translated к RoomAssignmentConflictError
					// (canonical 422 «room_occupied»). DB-level invariant per
					// `[[overbooking-prevention-canon]]` 2026-05-18.
					if (current.assignedRoomId !== null) {
						const nightsToRelease = oldNights.filter((n) => !newSet.has(n))
						const nightsToOccupy = newNights.filter((n) => !oldSet.has(n))
						if (nightsToRelease.length > 0) {
							await deleteOccupancyForNights(
								tx,
								tenantId,
								current.propertyId,
								current.assignedRoomId,
								nightsToRelease,
							)
						}
						if (nightsToOccupy.length > 0) {
							await insertOccupancyForNights(
								tx,
								tenantId,
								current.propertyId,
								current.assignedRoomId,
								current.id,
								nightsToOccupy,
								nowTs,
							)
						}
					}

					const totalMicros = ctx.timeSlices.reduce((acc, s) => acc + s.grossMicros, 0n)
					await upsertAmendedBookingRow(tx, current, {
						updatedAt: now,
						updatedBy: ctx.actorUserId,
						checkIn: ctx.newCheckIn,
						checkOut: ctx.newCheckOut,
						nightsCount: newNights.length,
						timeSlices: ctx.timeSlices,
						totalMicros,
						cancellationFee: ctx.cancellationFee,
						noShowFee: ctx.noShowFee,
						tourismTaxBaseMicros: ctx.tourismTaxBaseMicros,
						tourismTaxMicros: ctx.tourismTaxMicros,
					})

					return {
						...current,
						checkIn: ctx.newCheckIn,
						checkOut: ctx.newCheckOut,
						nightsCount: newNights.length,
						timeSlices: ctx.timeSlices,
						totalMicros: totalMicros.toString(),
						cancellationFee: ctx.cancellationFee,
						noShowFee: ctx.noShowFee,
						tourismTaxBaseMicros: ctx.tourismTaxBaseMicros.toString(),
						tourismTaxMicros: ctx.tourismTaxMicros.toString(),
						updatedAt: now.toISOString(),
						updatedBy: ctx.actorUserId,
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingAmendStateError)
					throw err.cause
				if (err instanceof Error && err.cause instanceof NoInventoryError) throw err.cause
				if (err instanceof Error && err.cause instanceof RoomAssignmentConflictError)
					throw err.cause
				if (
					isPkOrUniqueConflict(err) ||
					(err instanceof Error && isPkOrUniqueConflict(err.cause))
				) {
					throw new RoomAssignmentConflictError(
						'room_occupied',
						'move-dates target overlaps another pinned booking',
					)
				}
				throw err
			}
		},

		/**
		 * Switch rate plan (PATCH /bookings/:id/change-rate-plan).
		 *
		 * Same dates → no inventory mutation. New plan's rate rows recompute
		 * timeSlices / totalMicros / fees / tourismTax server-side; repo writes
		 * the row update.
		 *
		 * Status guard: confirmed-only. Service validates new plan's
		 * (propertyId, roomTypeId) match current.
		 */
		async changeRatePlan(
			tenantId: string,
			id: string,
			ctx: {
				newRatePlanId: string
				timeSlices: BookingTimeSlice[]
				cancellationFee: BookingFeeSnapshot | null
				noShowFee: BookingFeeSnapshot | null
				tourismTaxBaseMicros: bigint
				tourismTaxMicros: bigint
				actorUserId: string
			},
		): Promise<Booking | null> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) return null
					if (current.status !== 'confirmed') {
						throw new InvalidBookingAmendStateError(current.status, 'change-rate-plan')
					}
					if (ctx.timeSlices.length !== current.nightsCount) {
						throw new NoInventoryError(
							`timeSlices length ${ctx.timeSlices.length} != current.nightsCount ${current.nightsCount}`,
						)
					}

					const now = new Date()
					const totalMicros = ctx.timeSlices.reduce((acc, s) => acc + s.grossMicros, 0n)
					await upsertAmendedBookingRow(tx, current, {
						updatedAt: now,
						updatedBy: ctx.actorUserId,
						ratePlanId: ctx.newRatePlanId,
						timeSlices: ctx.timeSlices,
						totalMicros,
						cancellationFee: ctx.cancellationFee,
						noShowFee: ctx.noShowFee,
						tourismTaxBaseMicros: ctx.tourismTaxBaseMicros,
						tourismTaxMicros: ctx.tourismTaxMicros,
					})

					return {
						...current,
						ratePlanId: ctx.newRatePlanId,
						timeSlices: ctx.timeSlices,
						totalMicros: totalMicros.toString(),
						cancellationFee: ctx.cancellationFee,
						noShowFee: ctx.noShowFee,
						tourismTaxBaseMicros: ctx.tourismTaxBaseMicros.toString(),
						tourismTaxMicros: ctx.tourismTaxMicros.toString(),
						updatedAt: now.toISOString(),
						updatedBy: ctx.actorUserId,
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingAmendStateError)
					throw err.cause
				if (err instanceof Error && err.cause instanceof NoInventoryError) throw err.cause
				throw err
			}
		},

		/**
		 * G7 (2026-05-16) — Move band к different roomType row (PATCH
		 * /bookings/:id/change-room-type).
		 *
		 * Drag-move gesture target OR pointer-alternative ActionView amend
		 * dialog. Same dates → atomic inventory swap: release N nights ×
		 * old roomType, reserve N nights × new roomType с stopSell +
		 * allotment guards (mirrors create-flow canon). Service auto-picks
		 * default active ratePlan для new roomType, recomputes timeSlices /
		 * fees / tax from its rates.
		 *
		 * Status guard: confirmed-only. `in_house` rejected — guest
		 * physically located в old room; bed swap = check-out + new
		 * booking (separate operator workflow).
		 *
		 * Idempotent no-op: same roomTypeId returns current row unchanged.
		 */
		async changeRoomType(
			tenantId: string,
			id: string,
			ctx: {
				newRoomTypeId: string
				newRatePlanId: string
				timeSlices: BookingTimeSlice[]
				cancellationFee: BookingFeeSnapshot | null
				noShowFee: BookingFeeSnapshot | null
				tourismTaxBaseMicros: bigint
				tourismTaxMicros: bigint
				actorUserId: string
			},
		): Promise<Booking | null> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) return null
					if (current.status !== 'confirmed') {
						throw new InvalidBookingAmendStateError(current.status, 'change-room-type')
					}
					if (ctx.newRoomTypeId === current.roomTypeId) {
						// Idempotent no-op: same roomType → return current row unchanged.
						return current
					}
					if (ctx.timeSlices.length !== current.nightsCount) {
						throw new NoInventoryError(
							`timeSlices length ${ctx.timeSlices.length} != current.nightsCount ${current.nightsCount}`,
						)
					}

					const now = new Date()
					const nowTs = toTs(now)
					const nights = nightsBetween(current.checkIn, current.checkOut)

					// Release old roomType inventory.
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

					// Release per-night occupancy для OLD pin — `assignedRoomId` gets
					// nulled below (line «assignedRoomId: null»), so occupancy для
					// the old room must vacate. No INSERT here: new roomType means
					// new pin will come via subsequent `assignRoom` operator action.
					if (current.assignedRoomId !== null) {
						await deleteOccupancyForNights(
							tx,
							tenantId,
							current.propertyId,
							current.assignedRoomId,
							nights,
						)
					}

					// Reserve new roomType inventory с stopSell + allotment guards
					// (matches create-flow + moveDates canon). Effective allotment
					// includes oversellDelta per Apaleo canon.
					for (const night of nights) {
						const [availRows = []] = await tx<
							{
								allotment: number | bigint
								sold: number | bigint
								stopSell: boolean
								oversellDelta: number | bigint | null
							}[]
						>`
							SELECT allotment, sold, stopSell, oversellDelta FROM availability
							WHERE tenantId = ${tenantId}
								AND propertyId = ${current.propertyId}
								AND roomTypeId = ${ctx.newRoomTypeId}
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
						const oversellDelta = avail.oversellDelta === null ? 0 : Number(avail.oversellDelta)
						const effective = allotment + oversellDelta
						if (sold >= effective) {
							throw new NoInventoryError(
								`sold ${sold} >= effective ${effective} (allotment ${allotment} + oversellDelta ${oversellDelta}) for ${night}`,
							)
						}
						await tx`
							UPDATE availability SET sold = sold + 1, updatedAt = ${nowTs}
							WHERE tenantId = ${tenantId}
								AND propertyId = ${current.propertyId}
								AND roomTypeId = ${ctx.newRoomTypeId}
								AND date = ${dateFromIso(night)}
						`
					}

					const totalMicros = ctx.timeSlices.reduce((acc, s) => acc + s.grossMicros, 0n)
					await upsertAmendedBookingRow(tx, current, {
						updatedAt: now,
						updatedBy: ctx.actorUserId,
						roomTypeId: ctx.newRoomTypeId,
						ratePlanId: ctx.newRatePlanId,
						// Defensive: clear assignedRoomId — points к specific room в
						// OLD roomType which is no longer canonical reference после swap.
						// Status guard ensures we're 'confirmed' (assignedRoomId
						// only set on 'in_house' transition by current canon), но
						// future-evolution-safe.
						assignedRoomId: null,
						timeSlices: ctx.timeSlices,
						totalMicros,
						cancellationFee: ctx.cancellationFee,
						noShowFee: ctx.noShowFee,
						tourismTaxBaseMicros: ctx.tourismTaxBaseMicros,
						tourismTaxMicros: ctx.tourismTaxMicros,
					})

					return {
						...current,
						roomTypeId: ctx.newRoomTypeId,
						ratePlanId: ctx.newRatePlanId,
						assignedRoomId: null,
						timeSlices: ctx.timeSlices,
						totalMicros: totalMicros.toString(),
						cancellationFee: ctx.cancellationFee,
						noShowFee: ctx.noShowFee,
						tourismTaxBaseMicros: ctx.tourismTaxBaseMicros.toString(),
						tourismTaxMicros: ctx.tourismTaxMicros.toString(),
						updatedAt: now.toISOString(),
						updatedBy: ctx.actorUserId,
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingAmendStateError)
					throw err.cause
				if (err instanceof Error && err.cause instanceof NoInventoryError) throw err.cause
				throw err
			}
		},

		/**
		 * Adjust head-count (PATCH /bookings/:id/change-guests-count).
		 *
		 * No inventory / price recompute — `availability.allotment` counts
		 * ROOMS, not guests. Walk-up companions добавление common per Apaleo
		 * canon, hence ALSO allowed на `in_house` status (unlike date/rate
		 * edits which are confirmed-only).
		 */
		async changeGuestsCount(
			tenantId: string,
			id: string,
			ctx: { newGuestsCount: number; actorUserId: string },
		): Promise<Booking | null> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) return null
					if (current.status !== 'confirmed' && current.status !== 'in_house') {
						throw new InvalidBookingAmendStateError(current.status, 'change-guests-count')
					}

					const now = new Date()
					await upsertAmendedBookingRow(tx, current, {
						updatedAt: now,
						updatedBy: ctx.actorUserId,
						guestsCount: ctx.newGuestsCount,
					})

					return {
						...current,
						guestsCount: ctx.newGuestsCount,
						updatedAt: now.toISOString(),
						updatedBy: ctx.actorUserId,
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingAmendStateError)
					throw err.cause
				throw err
			}
		},

		/**
		 * G8 (2026-05-16) — pin specific room к booking (single-assign).
		 *
		 * Service-layer pre-checks (property/roomType/isActive); repo enforces
		 * overlap-with-other-booking guard inside atomic tx + CAS predicate
		 * для concurrency.
		 *
		 * Status guard: confirmed-only (in_house = guest physically already
		 * located в a room; reassignment = check-out + re-booking flow).
		 *
		 * Idempotent: same `roomId` → no-op return current (operator-trust
		 * canon, mirrors G5 change-rate-plan + G7 change-room-type pattern).
		 */
		async assignRoom(
			tenantId: string,
			id: string,
			ctx: { roomId: string; actorUserId: string },
		): Promise<Booking | null> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) return null
					if (current.status !== 'confirmed') {
						throw new InvalidBookingAmendStateError(current.status, 'assign-room')
					}
					if (current.assignedRoomId === ctx.roomId) {
						return current
					}
					// Defense layer 1: app-level overlap check via `ixBookingRoom`
					// (gives operator a concrete bookingId in the error message —
					// «room_occupied: bookingId=book_…»). Predicate matches
					// `confirmed`/`in_house` only — `no_show` excluded here on purpose
					// (operator workflow: no_show keeps physical room blocked для audit,
					// so layer 2 below catches the no_show case with same code).
					const checkInDate = dateFromIso(current.checkIn)
					const checkOutDate = dateFromIso(current.checkOut)
					const [overlapRows = []] = await tx<{ id: string }[]>`
						SELECT id FROM booking VIEW ixBookingRoom
						WHERE tenantId = ${tenantId}
							AND assignedRoomId = ${ctx.roomId}
							AND id != ${current.id}
							AND checkIn < ${checkOutDate}
							AND checkOut > ${checkInDate}
							AND status IN ('confirmed', 'in_house')
						LIMIT 1
					`
					if (overlapRows[0]) {
						throw new RoomAssignmentConflictError('room_occupied', `bookingId=${overlapRows[0].id}`)
					}

					const now = new Date()
					const nowTs = toTs(now)
					const nights = nightsBetween(current.checkIn, current.checkOut)

					// Re-pin case: vacate occupancy для previous room before INSERTing
					// new (avoids PK conflict against own prior rows in re-pin path).
					if (current.assignedRoomId !== null) {
						await deleteOccupancyForNights(
							tx,
							tenantId,
							current.propertyId,
							current.assignedRoomId,
							nights,
						)
					}

					// Defense layer 2: DB-level invariant via `roomNightOccupancy` PK.
					// Per `[[overbooking-prevention-canon]]` 2026-05-18: this is THE
					// canonical YDB-native overbooking-prevention seam. INSERT
					// PK collision = another booking owns this (roomId, date), surfaces
					// as PRECONDITION_FAILED → translated к RoomAssignmentConflictError
					// in outer catch. Catches what layer 1 missed (e.g. no_show
					// blocking, mass-import scripts that bypass repo, race condition
					// after layer 1 SELECT).
					await insertOccupancyForNights(
						tx,
						tenantId,
						current.propertyId,
						ctx.roomId,
						current.id,
						nights,
						nowTs,
					)

					await upsertAmendedBookingRow(tx, current, {
						updatedAt: now,
						updatedBy: ctx.actorUserId,
						assignedRoomId: ctx.roomId,
					})

					return {
						...current,
						assignedRoomId: ctx.roomId,
						updatedAt: now.toISOString(),
						updatedBy: ctx.actorUserId,
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof InvalidBookingAmendStateError)
					throw err.cause
				if (err instanceof Error && err.cause instanceof RoomAssignmentConflictError)
					throw err.cause
				if (
					isPkOrUniqueConflict(err) ||
					(err instanceof Error && isPkOrUniqueConflict(err.cause))
				) {
					throw new RoomAssignmentConflictError(
						'room_occupied',
						'target room overlaps another booking (DB-level constraint)',
					)
				}
				throw err
			}
		},

		/**
		 * G8 — list confirmed bookings без assignedRoomId for а property.
		 * Used by auto-assign service + UnassignedPanel count query.
		 */
		async listUnassignedByProperty(tenantId: string, propertyId: string): Promise<Booking[]> {
			const [rows = []] = await sql<BookingRow[]>`
				SELECT * FROM booking
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND status = 'confirmed'
					AND assignedRoomId IS NULL
				ORDER BY checkIn ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToBooking)
		},

		/**
		 * G8 — list existing assignments (confirmed + in_house bookings с
		 * assignedRoomId IS NOT NULL) для overlap matrix в auto-assign.
		 */
		async listAssignmentsByProperty(tenantId: string, propertyId: string): Promise<Booking[]> {
			const [rows = []] = await sql<BookingRow[]>`
				SELECT * FROM booking
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND status IN ('confirmed', 'in_house')
					AND assignedRoomId IS NOT NULL
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToBooking)
		},

		/**
		 * G8 — apply auto-assign plan per-row, each в own tx. Partial-
		 * success тroughout — operator-trust canon (Cloudbeds). Existing
		 * assignments NEVER touched (algorithm output targets `unassigned`
		 * subset). Per-row tx avoids YDB session-pool edge that flakes
		 * multi-write batch tx с тяжёлой upsert payload (Sochi-local
		 * empirical, не upstream bug).
		 *
		 * Caller (service) returns plan as-is; this method updates DB к
		 * match. На race (status changed mid-flight), row silently skipped.
		 */
		async batchAssignRooms(
			tenantId: string,
			assignments: ReadonlyArray<{ bookingId: string; roomId: string }>,
			actorUserId: string,
		): Promise<number> {
			if (assignments.length === 0) return 0
			let written = 0
			for (const a of assignments) {
				const ok = await this.assignRoom(tenantId, a.bookingId, {
					roomId: a.roomId,
					actorUserId,
				}).catch(() => null)
				if (ok) written += 1
			}
			return written
		},

		/**
		 * G9 — find active bookings (status='confirmed'|'in_house') assigned
		 * к specific room that overlap [startDate, endDate). Used by
		 * property-block.service для block-over-booking hard-block check.
		 * Reads via `ixBookingRoom` index — same predicate as assignRoom CAS.
		 */
		async findOverlappingBookingsByRoom(
			tenantId: string,
			roomId: string,
			startDate: string,
			endDate: string,
		): Promise<Booking[]> {
			const startD = dateFromIso(startDate)
			const endD = dateFromIso(endDate)
			const [rows = []] = await sql<BookingRow[]>`
				SELECT * FROM booking VIEW ixBookingRoom
				WHERE tenantId = ${tenantId}
					AND assignedRoomId = ${roomId}
					AND checkIn < ${endD}
					AND checkOut > ${startD}
					AND status IN ('confirmed', 'in_house')
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToBooking)
		},

		/**
		 * G9 — list active assignments for a specific roomType in window.
		 * Used by availability endpoint к compute bookedCount.
		 *
		 * Returns full booking shape; caller derives uniqueness of roomIds
		 * + per-night occupancy. Currently returns ALL active bookings of
		 * the property (post-filter by roomTypeId in JS) — pragmatic для
		 * small-medium property scale (5-50 rooms × 60 day window ≈ ≤300
		 * active rows worst case).
		 */
		async listAssignedBookingsByRoomTypeWindow(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			from: string,
			to: string,
		): Promise<Booking[]> {
			const fromD = dateFromIso(from)
			const toD = dateFromIso(to)
			const [rows = []] = await sql<BookingRow[]>`
				SELECT * FROM booking
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND roomTypeId = ${roomTypeId}
					AND status IN ('confirmed', 'in_house')
					AND checkIn < ${toD}
					AND checkOut > ${fromD}
					AND assignedRoomId IS NOT NULL
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToBooking)
		},
	}

	async function loadByIdForTx(tx: TX, tenantId: string, id: string): Promise<Booking | null> {
		const [rows = []] = await tx<BookingRow[]>`
			SELECT * FROM booking VIEW ixBookingId
			WHERE id = ${id} AND tenantId = ${tenantId}
			LIMIT 1
		`
		const row = rows[0]
		return row ? rowToBooking(row) : null
	}
}

export type BookingRepo = ReturnType<typeof createBookingRepo>

/** Exported for tests that seed `availability` by night-list. */
export const __bookingRepoInternals = { nightsBetween }
