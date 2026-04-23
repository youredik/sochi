/**
 * Booking repo — YDB integration tests.
 *
 * Business invariants this file tests (per mandatory pre-test checklist in
 * memory `feedback_strict_tests.md` — ONE test per invariant + adversarial):
 *
 *   Tenant isolation (applied to EVERY method, per checklist):
 *     [T1]  getById from wrong tenant returns null, own-tenant row intact
 *     [T2]  listByProperty from wrong tenant with pre-seeded noise in other tenant returns []
 *     [T3]  create cannot consume availability from another tenant
 *     [T4]  cancel from wrong tenant returns null, row and status intact
 *
 *   Atomic inventory math (core booking correctness):
 *     [I1]  create increments availability.sold by 1 per night, no more no less
 *     [I2]  create with missing availability row → NoInventoryError, nothing written
 *     [I3]  create with stopSell=true on any night → NoInventoryError, other nights untouched
 *     [I4]  create when sold === allotment → NoInventoryError
 *     [I5]  cancel decrements availability.sold by 1 per night
 *     [I6]  cancel of a non-existent booking returns null (no-op)
 *
 *   Overbooking race (OCC contention):
 *     [R1]  Promise.all of 2 concurrent creates on the LAST unit: exactly 1
 *           succeeds, 1 throws NoInventoryError; final sold = allotment
 *
 *   UNIQUE (tenantId, propertyId, externalId) — OTA retry dedup:
 *     [U1]  2nd create with same (tenant, property, externalId) → BookingExternalIdTakenError
 *     [U2]  Same externalId in DIFFERENT tenants → both succeed
 *     [U3]  Same externalId in DIFFERENT properties within one tenant → both succeed
 *
 *   JSON snapshot integrity (frozen at create time):
 *     [J1]  guestSnapshot roundtrips exactly
 *     [J2]  timeSlices array roundtrips exactly (including bigint grossMicros)
 *     [J3]  externalReferences roundtrips (when provided) / stays null (when omitted)
 *
 *   Money Int64 micros:
 *     [M1]  totalMicros = sum(timeSlices.grossMicros), exact roundtrip (no float)
 *     [M2]  Large bigint (over Number.MAX_SAFE_INTEGER) roundtrips exactly
 *
 *   State machine (5-state; `no_show` terminal + irreversible):
 *     [S1]  Fresh booking: status='confirmed', confirmedAt=createdAt, transitions null
 *     [S2]  cancel sets status='cancelled' + cancelledAt + cancelReason
 *     [S3]  cancel on already-cancelled → InvalidBookingTransitionError
 *     [S4]  cancel on no_show (simulated via manual UPDATE) → InvalidBookingTransitionError
 *     [S5]  cancel on checked_out (simulated) → InvalidBookingTransitionError
 *
 *   Immutables (per checklist: id, tenantId, createdAt preserved on every mutation):
 *     [X1]  cancel preserves id, tenantId, propertyId, checkIn, createdAt, createdBy, confirmedAt
 *
 *   Monotonicity:
 *     [N1]  updatedAt strictly greater after cancel; createdAt unchanged
 *
 *   PK separation (compound PK = 4 dimensions: tenant/property/checkIn/id):
 *     [K1]  Same tenant+property+checkIn, different id → independent rows
 *     [K2]  Same tenant+property, different checkIn → independent rows
 *     [K3]  Same tenant, different property → independent rows
 *     [K4]  Same id (typeid) across tenants — forbidden by typeid uniqueness; we
 *           verify cross-tenant isolation on getById from wrong tenant (covered by T1)
 *
 *   Listing ordering + filters:
 *     [L1]  list ordered by checkIn ASC, id ASC (deterministic)
 *     [L2]  list from/to date range inclusive
 *     [L3]  list status filter narrows result
 *     [L4]  list roomTypeId filter narrows result
 *
 *   Enum coverage (per checklist: ALL values, not just representative):
 *     [E1]  channelCode: 'direct', 'walkIn', 'yandexTravel', 'ostrovok',
 *           'travelLine', 'bnovo', 'bookingCom', 'expedia', 'airbnb' all roundtrip
 *
 *   Check-in transition (confirmed → in_house) — M4b-2:
 *     [T5]  checkIn from wrong tenant → null, own-tenant row intact
 *     [S6]  checkIn from confirmed: status='in_house', checkedInAt set, monotonic
 *     [A1]  checkIn with assignedRoomId stores it; immutables still preserved
 *     [A2]  checkIn without assignedRoomId leaves it null
 *     [S7]  checkIn on already-in_house → InvalidBookingTransitionError
 *     [S8]  checkIn on cancelled → InvalidBookingTransitionError
 *     [S9]  checkIn on no_show → InvalidBookingTransitionError (IRREVERSIBLE enforcement)
 *     [S10] checkIn on checked_out → InvalidBookingTransitionError
 *     [I7]  checkIn does NOT change availability.sold
 *     [X2]  checkIn preserves id/tenantId/propertyId/checkIn/createdAt/createdBy/confirmedAt
 *     [R2]  Promise.all double checkIn: exactly 1 succeeds
 *
 *   Check-out transition (in_house → checked_out) — M4b-2:
 *     [T6]  checkOut from wrong tenant → null, row intact
 *     [S11] checkOut from in_house: status='checked_out', checkedOutAt set
 *     [S12] checkOut from confirmed (no check-in first) → InvalidBookingTransitionError
 *     [S13] checkOut from cancelled → InvalidBookingTransitionError
 *     [I8]  checkOut does NOT change availability.sold
 *     [X3]  checkOut preserves immutables incl. checkedInAt + assignedRoomId
 *
 *   No-show transition (confirmed → no_show, TERMINAL + IRREVERSIBLE) — M4b-2:
 *     [T7]  markNoShow from wrong tenant → null, row intact
 *     [S14] markNoShow from confirmed: status='no_show', noShowAt + reason
 *     [S15] markNoShow from in_house → InvalidBookingTransitionError
 *           (guest already arrived; correct op is checkOut with adjustments)
 *     [S16] markNoShow from cancelled → InvalidBookingTransitionError
 *     [I9]  markNoShow does NOT decrement availability.sold
 *           (product decision: room was committed + not available for re-sale;
 *           revenue integrity trumps inventory release)
 *     [RN1] markNoShow with null reason stores null; cancelReason field preserved
 *     [X4]  markNoShow preserves id/tenantId/propertyId/checkIn/createdAt/
 *           createdBy/confirmedAt
 *     [S19] markNoShow idempotent adversarial: second call throws (state → no_show
 *           is irreversible, second call sees no_show and refuses)
 *
 *   Cancel-from-other states (extending M4a cancel tests):
 *     [S18] cancel from in_house is ALLOWED (non-terminal); sold decrements
 *
 * Requires local YDB.
 */
import type { Booking, BookingCreateInput, BookingTimeSlice } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	dateFromIso,
	NULL_INT32,
	NULL_TEXT,
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
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createBookingRepo } from './booking.repo.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const PROP_A = newId('property')
const PROP_B = newId('property')
const RT_A = newId('roomType')
const RT_B = newId('roomType')
const RP_A = newId('ratePlan')
const USER_A = newId('user')
const USER_B = newId('user')
const GUEST_A = newId('guest')

describe('booking.repo', { tags: ['db'], timeout: 60_000 }, () => {
	let repo: ReturnType<typeof createBookingRepo>

	const createdBookings: Array<{
		tenantId: string
		propertyId: string
		checkIn: string
		id: string
	}> = []
	const seededAvailability: Array<{
		tenantId: string
		propertyId: string
		roomTypeId: string
		date: string
	}> = []

	beforeAll(async () => {
		await setupTestDb()
		repo = createBookingRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const b of createdBookings) {
			await sql`
				DELETE FROM booking
				WHERE tenantId = ${b.tenantId}
					AND propertyId = ${b.propertyId}
					AND checkIn = CAST(${b.checkIn} AS Date)
					AND id = ${b.id}
			`
		}
		for (const a of seededAvailability) {
			await sql`
				DELETE FROM availability
				WHERE tenantId = ${a.tenantId}
					AND propertyId = ${a.propertyId}
					AND roomTypeId = ${a.roomTypeId}
					AND date = CAST(${a.date} AS Date)
			`
		}
		await teardownTestDb()
	})

	const trackBooking = (tenantId: string, propertyId: string, checkIn: string, id: string) => {
		createdBookings.push({ tenantId, propertyId, checkIn, id })
	}

	const trackAvailability = (
		tenantId: string,
		propertyId: string,
		roomTypeId: string,
		dates: string[],
	) => {
		for (const d of dates) seededAvailability.push({ tenantId, propertyId, roomTypeId, date: d })
	}

	/** Seed availability rows — direct SQL to keep tests independent of availability.repo. */
	async function seedAvailability(
		tenantId: string,
		propertyId: string,
		roomTypeId: string,
		dates: string[],
		opts: { allotment?: number; sold?: number; stopSell?: boolean } = {},
	) {
		const sql = getTestSql()
		const now = toTs(new Date())
		const allotment = opts.allotment ?? 5
		const sold = opts.sold ?? 0
		const stopSell = opts.stopSell ?? false
		for (const date of dates) {
			await sql`
				UPSERT INTO availability (
					\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`date\`,
					\`allotment\`, \`sold\`, \`minStay\`, \`maxStay\`,
					\`closedToArrival\`, \`closedToDeparture\`, \`stopSell\`,
					\`createdAt\`, \`updatedAt\`
				) VALUES (
					${tenantId}, ${propertyId}, ${roomTypeId}, ${dateFromIso(date)},
					${allotment}, ${sold}, ${NULL_INT32}, ${NULL_INT32},
					${false}, ${false}, ${stopSell},
					${now}, ${now}
				)
			`
		}
		trackAvailability(tenantId, propertyId, roomTypeId, dates)
	}

	/**
	 * Force a booking into a non-default state for invariant tests on cancel-from-terminal.
	 * Uses UPSERT full row — YDB `UPDATE ... SET status = Utf8NOT_NULL` hits a type
	 * inference edge (see `project_ydb_specifics.md` #14) where UPSERT is tolerant.
	 * Lands in M4b-2 when markNoShow/checkOut methods land; removed then.
	 */
	async function forceBookingStatus(
		booking: Booking,
		nextStatus: 'no_show' | 'checked_out',
		transitionField: 'noShowAt' | 'checkedOutAt',
	) {
		const sql = getTestSql()
		const nowDate = new Date()
		const nowTs = toTs(nowDate)
		const transitionTs = timestampOpt(nowDate)
		await sql`
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
				${booking.tenantId}, ${booking.propertyId}, ${dateFromIso(booking.checkIn)}, ${booking.id},
				${dateFromIso(booking.checkOut)}, ${booking.roomTypeId}, ${booking.ratePlanId},
				${booking.assignedRoomId ?? NULL_TEXT},
				${booking.guestsCount}, ${booking.nightsCount},
				${booking.primaryGuestId}, ${toJson(booking.guestSnapshot)},
				${nextStatus}, ${tsFromIso(booking.confirmedAt)},
				${transitionField === 'checkedOutAt' ? transitionTs : timestampOpt(booking.checkedInAt ? new Date(booking.checkedInAt) : null)},
				${transitionField === 'checkedOutAt' ? transitionTs : timestampOpt(booking.checkedOutAt ? new Date(booking.checkedOutAt) : null)},
				${timestampOpt(booking.cancelledAt ? new Date(booking.cancelledAt) : null)},
				${transitionField === 'noShowAt' ? transitionTs : timestampOpt(booking.noShowAt ? new Date(booking.noShowAt) : null)},
				${booking.cancelReason ?? NULL_TEXT},
				${booking.channelCode}, ${booking.externalId ?? NULL_TEXT}, ${toJson(booking.externalReferences)},
				${BigInt(booking.totalMicros)}, ${BigInt(booking.paidMicros)},
				${booking.currency}, ${toJson(booking.timeSlices)},
				${toJson(booking.cancellationFee)}, ${toJson(booking.noShowFee)},
				${booking.registrationStatus}, ${booking.registrationMvdId ?? NULL_TEXT},
				${timestampOpt(booking.registrationSubmittedAt ? new Date(booking.registrationSubmittedAt) : null)},
				${booking.rklCheckResult},
				${timestampOpt(booking.rklCheckedAt ? new Date(booking.rklCheckedAt) : null)},
				${BigInt(booking.tourismTaxBaseMicros)}, ${BigInt(booking.tourismTaxMicros)},
				${booking.notes ?? NULL_TEXT}, ${tsFromIso(booking.createdAt)}, ${nowTs},
				${booking.createdBy}, ${booking.updatedBy}
			)
		`
	}

	async function readSold(
		tenantId: string,
		propertyId: string,
		roomTypeId: string,
		date: string,
	): Promise<number | null> {
		const sql = getTestSql()
		const [rows = []] = await sql<{ sold: number | bigint }[]>`
			SELECT sold FROM availability
			WHERE tenantId = ${tenantId}
				AND propertyId = ${propertyId}
				AND roomTypeId = ${roomTypeId}
				AND date = ${dateFromIso(date)}
			LIMIT 1
		`
		return rows[0] ? Number(rows[0].sold) : null
	}

	function buildInput(over: Partial<BookingCreateInput> = {}): BookingCreateInput {
		return {
			roomTypeId: RT_A,
			ratePlanId: RP_A,
			checkIn: '2027-07-01',
			checkOut: '2027-07-03',
			guestsCount: 2,
			primaryGuestId: GUEST_A,
			guestSnapshot: {
				firstName: 'Иван',
				lastName: 'Петров',
				citizenship: 'RU',
				documentType: 'ruPassport',
				documentNumber: '4510 123456',
			},
			channelCode: 'direct',
			...over,
		}
	}

	function buildSlices(dates: string[], grossMicros = 5_000_000_000n): BookingTimeSlice[] {
		return dates.map((d) => ({
			date: d,
			grossMicros,
			ratePlanId: RP_A,
			ratePlanVersion: '2027-06-30T00:00:00.000Z',
			currency: 'RUB',
		}))
	}

	function buildCtx(slices: BookingTimeSlice[]) {
		const total = slices.reduce((acc, s) => acc + s.grossMicros, 0n)
		return {
			actorUserId: USER_A,
			timeSlices: slices,
			cancellationFee: null,
			noShowFee: null,
			tourismTaxBaseMicros: total,
			tourismTaxMicros: 0n,
			registrationStatus: 'notRequired' as const,
			rklCheckResult: 'unchecked' as const,
		}
	}

	// ---------------------------------------------------------------------------
	// Core happy path + JSON snapshot integrity + money roundtrip
	// ---------------------------------------------------------------------------

	test('[J1,J2,J3,M1,S1] create: full snapshot roundtrip + status invariants', async () => {
		const dates = ['2027-07-01', '2027-07-02']
		await seedAvailability(TENANT_A, PROP_A, RT_A, dates)
		const slices = buildSlices(dates, 7_500_000_000n) // 7500.00 RUB
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({
				externalReferences: { otaId: 'yandex-12345', channelManagerId: 'tl-678' },
				notes: 'Early check-in requested',
			}),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)

		// S1: fresh booking state
		expect(created.status).toBe('confirmed')
		expect(created.confirmedAt).toBe(created.createdAt)
		expect(created.checkedInAt).toBeNull()
		expect(created.checkedOutAt).toBeNull()
		expect(created.cancelledAt).toBeNull()
		expect(created.noShowAt).toBeNull()
		expect(created.cancelReason).toBeNull()

		// J1: guest snapshot exact
		expect(created.guestSnapshot).toEqual({
			firstName: 'Иван',
			lastName: 'Петров',
			citizenship: 'RU',
			documentType: 'ruPassport',
			documentNumber: '4510 123456',
		})

		// J3: external refs
		expect(created.externalReferences).toEqual({
			otaId: 'yandex-12345',
			channelManagerId: 'tl-678',
		})

		// M1: total from slice sum
		expect(created.totalMicros).toBe((7_500_000_000n * 2n).toString())
		expect(created.paidMicros).toBe('0')
		expect(created.currency).toBe('RUB')

		// Re-fetch + deep equal to catch any server-side drift
		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched).toEqual(created)

		// J2: timeSlices exact, including bigint grossMicros
		expect(fetched?.timeSlices).toHaveLength(2)
		expect(fetched?.timeSlices[0]?.grossMicros).toBe(7_500_000_000n)
		expect(fetched?.timeSlices[1]?.grossMicros).toBe(7_500_000_000n)
		expect(fetched?.timeSlices[0]?.date).toBe('2027-07-01')
		expect(fetched?.timeSlices[1]?.date).toBe('2027-07-02')
	})

	test('[M2] money: large Int64 micros (over MAX_SAFE_INTEGER) roundtrip exact', async () => {
		const dates = ['2027-07-10']
		await seedAvailability(TENANT_A, PROP_A, RT_A, dates)
		// 9e15 micros = 9_000_000_000 RUB (way over Number.MAX_SAFE_INTEGER as the sum; here 1 slice is fine)
		const huge = 9_007_199_254_740_993n // MAX_SAFE_INTEGER + 2
		const slices = buildSlices(dates, huge)
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: '2027-07-10', checkOut: '2027-07-11' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		expect(created.totalMicros).toBe(huge.toString())
		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched?.timeSlices[0]?.grossMicros).toBe(huge)
	})

	test('[E1] channelCode enum: every value roundtrips', async () => {
		const channels = [
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
		const base = new Date('2028-01-01T00:00:00Z')
		for (let i = 0; i < channels.length; i++) {
			const checkInDate = new Date(base)
			checkInDate.setUTCDate(base.getUTCDate() + i * 2)
			const ci = checkInDate.toISOString().slice(0, 10)
			const coDate = new Date(checkInDate)
			coDate.setUTCDate(coDate.getUTCDate() + 1)
			const co = coDate.toISOString().slice(0, 10)
			await seedAvailability(TENANT_A, PROP_A, RT_A, [ci])
			const slices = buildSlices([ci])
			const created = await repo.create(
				TENANT_A,
				PROP_A,
				buildInput({ checkIn: ci, checkOut: co, channelCode: channels[i]! }),
				buildCtx(slices),
			)
			trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
			expect(created.channelCode).toBe(channels[i])
		}
	})

	// ---------------------------------------------------------------------------
	// Tenant isolation (applied to every method) — [T1..T4]
	// ---------------------------------------------------------------------------

	test('[T1] getById from wrong tenant returns null, own-tenant row intact', async () => {
		await seedAvailability(TENANT_A, PROP_A, RT_A, ['2027-08-01'])
		const slices = buildSlices(['2027-08-01'])
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: '2027-08-01', checkOut: '2027-08-02' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		expect(await repo.getById(TENANT_B, created.id)).toBeNull()
		// Own tenant — intact
		expect((await repo.getById(TENANT_A, created.id))?.id).toBe(created.id)
	})

	test('[T2] listByProperty from wrong tenant with pre-seeded noise → []', async () => {
		// Pre-seed noise in TENANT_A.
		await seedAvailability(TENANT_A, PROP_A, RT_A, ['2027-08-10'])
		const slices = buildSlices(['2027-08-10'])
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: '2027-08-10', checkOut: '2027-08-11' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		// Query as TENANT_B for the same property/range — should see nothing.
		const list = await repo.listByProperty(TENANT_B, PROP_A, {
			from: '2027-08-10',
			to: '2027-08-10',
		})
		expect(list).toEqual([])
	})

	test('[T3] create cannot consume availability from another tenant', async () => {
		await seedAvailability(TENANT_A, PROP_A, RT_A, ['2027-08-20'])
		// TENANT_B has NO availability row for same key — must fail.
		const slices = buildSlices(['2027-08-20'])
		await expect(
			repo.create(
				TENANT_B,
				PROP_A,
				buildInput({ checkIn: '2027-08-20', checkOut: '2027-08-21' }),
				buildCtx(slices),
			),
		).rejects.toBeInstanceOf(NoInventoryError)
		// Tenant A sold remains 0.
		expect(await readSold(TENANT_A, PROP_A, RT_A, '2027-08-20')).toBe(0)
	})

	test('[T4] cancel from wrong tenant is no-op', async () => {
		await seedAvailability(TENANT_A, PROP_A, RT_A, ['2027-09-01'])
		const slices = buildSlices(['2027-09-01'])
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: '2027-09-01', checkOut: '2027-09-02' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		const res = await repo.cancel(TENANT_B, created.id, 'malicious', USER_B)
		expect(res).toBeNull()
		// Row still confirmed.
		const fetched = await repo.getById(TENANT_A, created.id)
		expect(fetched?.status).toBe('confirmed')
		expect(fetched?.cancelReason).toBeNull()
	})

	// ---------------------------------------------------------------------------
	// Atomic inventory math — [I1..I6]
	// ---------------------------------------------------------------------------

	test('[I1] create increments sold by exactly 1 per night', async () => {
		const dates = ['2027-10-01', '2027-10-02', '2027-10-03']
		await seedAvailability(TENANT_A, PROP_A, RT_A, dates, { allotment: 5, sold: 2 })
		const slices = buildSlices(dates)
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: '2027-10-01', checkOut: '2027-10-04' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		for (const d of dates) {
			expect(await readSold(TENANT_A, PROP_A, RT_A, d)).toBe(3)
		}
	})

	test('[I2] create with missing availability row → NoInventoryError, no partial writes', async () => {
		// Seed only first 2 of 3 nights.
		await seedAvailability(TENANT_A, PROP_A, RT_A, ['2027-11-01', '2027-11-02'])
		const slices = buildSlices(['2027-11-01', '2027-11-02', '2027-11-03'])
		await expect(
			repo.create(
				TENANT_A,
				PROP_A,
				buildInput({ checkIn: '2027-11-01', checkOut: '2027-11-04' }),
				buildCtx(slices),
			),
		).rejects.toBeInstanceOf(NoInventoryError)
		// Previously seeded nights' sold remains 0 (tx rolled back).
		expect(await readSold(TENANT_A, PROP_A, RT_A, '2027-11-01')).toBe(0)
		expect(await readSold(TENANT_A, PROP_A, RT_A, '2027-11-02')).toBe(0)
	})

	test('[I3] stopSell on any night → NoInventoryError, no partial writes', async () => {
		await seedAvailability(TENANT_A, PROP_A, RT_A, ['2027-11-10'], { allotment: 5, sold: 0 })
		await seedAvailability(TENANT_A, PROP_A, RT_A, ['2027-11-11'], {
			allotment: 5,
			sold: 0,
			stopSell: true,
		})
		const slices = buildSlices(['2027-11-10', '2027-11-11'])
		await expect(
			repo.create(
				TENANT_A,
				PROP_A,
				buildInput({ checkIn: '2027-11-10', checkOut: '2027-11-12' }),
				buildCtx(slices),
			),
		).rejects.toBeInstanceOf(NoInventoryError)
		expect(await readSold(TENANT_A, PROP_A, RT_A, '2027-11-10')).toBe(0)
	})

	test('[I4] sold === allotment → NoInventoryError', async () => {
		await seedAvailability(TENANT_A, PROP_A, RT_A, ['2027-11-20'], { allotment: 2, sold: 2 })
		const slices = buildSlices(['2027-11-20'])
		await expect(
			repo.create(
				TENANT_A,
				PROP_A,
				buildInput({ checkIn: '2027-11-20', checkOut: '2027-11-21' }),
				buildCtx(slices),
			),
		).rejects.toBeInstanceOf(NoInventoryError)
	})

	test('[I5] cancel decrements sold by exactly 1 per night', async () => {
		const dates = ['2027-12-01', '2027-12-02']
		await seedAvailability(TENANT_A, PROP_A, RT_A, dates, { allotment: 5, sold: 1 })
		const slices = buildSlices(dates)
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: '2027-12-01', checkOut: '2027-12-03' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		// After create: 1 + 1 = 2 on each night.
		for (const d of dates) {
			expect(await readSold(TENANT_A, PROP_A, RT_A, d)).toBe(2)
		}
		await repo.cancel(TENANT_A, created.id, 'change of plans', USER_A)
		// After cancel: back to 1 on each night.
		for (const d of dates) {
			expect(await readSold(TENANT_A, PROP_A, RT_A, d)).toBe(1)
		}
	})

	test('[I6] cancel of a non-existent booking → null (no throw)', async () => {
		const bogus = newId('booking')
		expect(await repo.cancel(TENANT_A, bogus, 'reason', USER_A)).toBeNull()
	})

	// ---------------------------------------------------------------------------
	// Overbooking race — [R1]
	// ---------------------------------------------------------------------------

	test('[R1] Promise.all two concurrent creates on last unit: exactly 1 wins', async () => {
		const date = '2028-02-10'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date], { allotment: 1, sold: 0 })
		const slices = buildSlices([date])
		const mkCall = () =>
			repo.create(
				TENANT_A,
				PROP_A,
				buildInput({ checkIn: date, checkOut: '2028-02-11' }),
				buildCtx(slices),
			)
		const results = await Promise.allSettled([mkCall(), mkCall()])
		const fulfilled = results.filter((r) => r.status === 'fulfilled')
		const rejected = results.filter((r) => r.status === 'rejected')
		expect(fulfilled).toHaveLength(1)
		expect(rejected).toHaveLength(1)
		const winner = fulfilled[0]
		if (winner?.status === 'fulfilled') {
			trackBooking(TENANT_A, PROP_A, winner.value.checkIn, winner.value.id)
		}
		expect(await readSold(TENANT_A, PROP_A, RT_A, date)).toBe(1)
	})

	// ---------------------------------------------------------------------------
	// UNIQUE (tenantId, propertyId, externalId) — [U1..U3]
	// ---------------------------------------------------------------------------

	test('[U1] duplicate externalId in same tenant+property → BookingExternalIdTakenError', async () => {
		const date = '2028-03-01'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date], { allotment: 5 })
		const slices = buildSlices([date])
		const first = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({
				checkIn: date,
				checkOut: '2028-03-02',
				channelCode: 'yandexTravel',
				externalId: 'YT-DUP-001',
			}),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, first.checkIn, first.id)
		await expect(
			repo.create(
				TENANT_A,
				PROP_A,
				buildInput({
					checkIn: date,
					checkOut: '2028-03-02',
					channelCode: 'yandexTravel',
					externalId: 'YT-DUP-001',
				}),
				buildCtx(slices),
			),
		).rejects.toBeInstanceOf(BookingExternalIdTakenError)
	})

	test('[U2] same externalId in DIFFERENT tenants → both succeed', async () => {
		const date = '2028-03-10'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date])
		await seedAvailability(TENANT_B, PROP_A, RT_A, [date])
		const slices = buildSlices([date])
		const a = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({
				checkIn: date,
				checkOut: '2028-03-11',
				channelCode: 'ostrovok',
				externalId: 'CROSS-TENANT-001',
			}),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, a.checkIn, a.id)
		const b = await repo.create(
			TENANT_B,
			PROP_A,
			buildInput({
				checkIn: date,
				checkOut: '2028-03-11',
				channelCode: 'ostrovok',
				externalId: 'CROSS-TENANT-001',
			}),
			buildCtx(slices),
		)
		trackBooking(TENANT_B, PROP_A, b.checkIn, b.id)
		expect(a.id).not.toBe(b.id)
	})

	test('[U3] same externalId in DIFFERENT properties within one tenant → both succeed', async () => {
		const date = '2028-03-20'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date])
		await seedAvailability(TENANT_A, PROP_B, RT_A, [date])
		const slices = buildSlices([date])
		const a = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({
				checkIn: date,
				checkOut: '2028-03-21',
				channelCode: 'bookingCom',
				externalId: 'BK-CROSS-PROP-001',
			}),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, a.checkIn, a.id)
		const b = await repo.create(
			TENANT_A,
			PROP_B,
			buildInput({
				checkIn: date,
				checkOut: '2028-03-21',
				channelCode: 'bookingCom',
				externalId: 'BK-CROSS-PROP-001',
			}),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_B, b.checkIn, b.id)
		expect(a.id).not.toBe(b.id)
	})

	// ---------------------------------------------------------------------------
	// State machine — [S2..S5] (S1 covered in core happy-path)
	// ---------------------------------------------------------------------------

	test('[S2,N1,X1] cancel sets terminal status + reason + bumps updatedAt; immutables preserved', async () => {
		const date = '2028-04-01'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date])
		const slices = buildSlices([date])
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: date, checkOut: '2028-04-02' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		// Advance wall clock enough for Timestamp ms to differ on update.
		await new Promise((r) => setTimeout(r, 15))
		const cancelled = await repo.cancel(TENANT_A, created.id, 'guest request', USER_B)
		expect(cancelled).not.toBeNull()
		if (!cancelled) return

		expect(cancelled.status).toBe('cancelled')
		expect(cancelled.cancelReason).toBe('guest request')
		expect(cancelled.cancelledAt).not.toBeNull()
		expect(cancelled.updatedBy).toBe(USER_B)

		// Monotonicity — ms precision.
		expect(new Date(cancelled.updatedAt).getTime()).toBeGreaterThan(
			new Date(created.updatedAt).getTime(),
		)

		// Immutables preserved.
		expect(cancelled.id).toBe(created.id)
		expect(cancelled.tenantId).toBe(created.tenantId)
		expect(cancelled.propertyId).toBe(created.propertyId)
		expect(cancelled.checkIn).toBe(created.checkIn)
		expect(cancelled.createdAt).toBe(created.createdAt)
		expect(cancelled.createdBy).toBe(created.createdBy)
		expect(cancelled.confirmedAt).toBe(created.confirmedAt)
	})

	test('[S3] cancel on already-cancelled → InvalidBookingTransitionError', async () => {
		const date = '2028-04-10'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date])
		const slices = buildSlices([date])
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: date, checkOut: '2028-04-11' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		await repo.cancel(TENANT_A, created.id, 'first', USER_A)
		await expect(repo.cancel(TENANT_A, created.id, 'second', USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[S4] cancel on no_show (manually set) → InvalidBookingTransitionError', async () => {
		const date = '2028-04-20'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date])
		const slices = buildSlices([date])
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: date, checkOut: '2028-04-21' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		// Simulate night-audit having marked no_show (markNoShow method lands in M4b-2).
		await forceBookingStatus(created, 'no_show', 'noShowAt')
		await expect(
			repo.cancel(TENANT_A, created.id, 'try reverse no-show', USER_A),
		).rejects.toBeInstanceOf(InvalidBookingTransitionError)
	})

	test('[S5] cancel on checked_out (manually set) → InvalidBookingTransitionError', async () => {
		const date = '2028-04-25'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date])
		const slices = buildSlices([date])
		const created = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: date, checkOut: '2028-04-26' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, created.checkIn, created.id)
		await forceBookingStatus(created, 'checked_out', 'checkedOutAt')
		await expect(
			repo.cancel(TENANT_A, created.id, 'retroactive cancel', USER_A),
		).rejects.toBeInstanceOf(InvalidBookingTransitionError)
	})

	// ---------------------------------------------------------------------------
	// PK separation — [K1..K3]
	// ---------------------------------------------------------------------------

	test('[K1] same tenant+property+checkIn, different id → independent rows', async () => {
		const date = '2028-05-01'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date], { allotment: 10 })
		const slices = buildSlices([date])
		const a = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: date, checkOut: '2028-05-02' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, a.checkIn, a.id)
		const b = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: date, checkOut: '2028-05-02' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, b.checkIn, b.id)
		expect(a.id).not.toBe(b.id)
		// Cancel one leaves the other intact.
		await repo.cancel(TENANT_A, a.id, 'test', USER_A)
		expect((await repo.getById(TENANT_A, a.id))?.status).toBe('cancelled')
		expect((await repo.getById(TENANT_A, b.id))?.status).toBe('confirmed')
	})

	test('[K2] same tenant+property, different checkIn → independent rows', async () => {
		await seedAvailability(TENANT_A, PROP_A, RT_A, ['2028-05-10', '2028-05-20'])
		const s1 = buildSlices(['2028-05-10'])
		const s2 = buildSlices(['2028-05-20'])
		const a = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: '2028-05-10', checkOut: '2028-05-11' }),
			buildCtx(s1),
		)
		trackBooking(TENANT_A, PROP_A, a.checkIn, a.id)
		const b = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: '2028-05-20', checkOut: '2028-05-21' }),
			buildCtx(s2),
		)
		trackBooking(TENANT_A, PROP_A, b.checkIn, b.id)
		expect(a.checkIn).not.toBe(b.checkIn)
		expect(await repo.getById(TENANT_A, a.id)).not.toBeNull()
		expect(await repo.getById(TENANT_A, b.id)).not.toBeNull()
	})

	test('[K3] same tenant, different property → independent rows', async () => {
		const date = '2028-06-01'
		await seedAvailability(TENANT_A, PROP_A, RT_A, [date])
		await seedAvailability(TENANT_A, PROP_B, RT_B, [date])
		const slices = buildSlices([date])
		const a = await repo.create(
			TENANT_A,
			PROP_A,
			buildInput({ checkIn: date, checkOut: '2028-06-02' }),
			buildCtx(slices),
		)
		trackBooking(TENANT_A, PROP_A, a.checkIn, a.id)
		const b = await repo.create(
			TENANT_A,
			PROP_B,
			buildInput({ checkIn: date, checkOut: '2028-06-02', roomTypeId: RT_B }),
			buildCtx(slices.map((s) => ({ ...s, ratePlanId: RP_A }))),
		)
		trackBooking(TENANT_A, PROP_B, b.checkIn, b.id)
		expect(a.propertyId).toBe(PROP_A)
		expect(b.propertyId).toBe(PROP_B)
	})

	// ---------------------------------------------------------------------------
	// Listing — [L1..L4]
	// ---------------------------------------------------------------------------

	test('[L1,L2] listByProperty: ORDER BY checkIn ASC + inclusive date bounds', async () => {
		const PROP_L = newId('property')
		await seedAvailability(TENANT_A, PROP_L, RT_A, ['2028-07-10', '2028-07-15', '2028-07-20'])
		// Insert in reverse to rule out coincidental order.
		for (const d of ['2028-07-20', '2028-07-10', '2028-07-15']) {
			const slices = buildSlices([d])
			const coDate = new Date(`${d}T00:00:00Z`)
			coDate.setUTCDate(coDate.getUTCDate() + 1)
			const co = coDate.toISOString().slice(0, 10)
			const created = await repo.create(
				TENANT_A,
				PROP_L,
				buildInput({ checkIn: d, checkOut: co }),
				buildCtx(slices),
			)
			trackBooking(TENANT_A, PROP_L, created.checkIn, created.id)
		}
		const all = await repo.listByProperty(TENANT_A, PROP_L, {
			from: '2028-07-10',
			to: '2028-07-20',
		})
		expect(all.map((b) => b.checkIn)).toEqual(['2028-07-10', '2028-07-15', '2028-07-20'])
		// Tight window middle only.
		const mid = await repo.listByProperty(TENANT_A, PROP_L, {
			from: '2028-07-15',
			to: '2028-07-15',
		})
		expect(mid.map((b) => b.checkIn)).toEqual(['2028-07-15'])
	})

	test('[L3] listByProperty: status filter narrows', async () => {
		const PROP_STATUS = newId('property')
		await seedAvailability(TENANT_A, PROP_STATUS, RT_A, ['2028-08-01', '2028-08-02'])
		const a = await repo.create(
			TENANT_A,
			PROP_STATUS,
			buildInput({ checkIn: '2028-08-01', checkOut: '2028-08-02' }),
			buildCtx(buildSlices(['2028-08-01'])),
		)
		trackBooking(TENANT_A, PROP_STATUS, a.checkIn, a.id)
		const b = await repo.create(
			TENANT_A,
			PROP_STATUS,
			buildInput({ checkIn: '2028-08-02', checkOut: '2028-08-03' }),
			buildCtx(buildSlices(['2028-08-02'])),
		)
		trackBooking(TENANT_A, PROP_STATUS, b.checkIn, b.id)
		await repo.cancel(TENANT_A, a.id, 'test', USER_A)
		const confirmedOnly = await repo.listByProperty(TENANT_A, PROP_STATUS, { status: 'confirmed' })
		expect(confirmedOnly.map((x) => x.id)).toEqual([b.id])
		const cancelledOnly = await repo.listByProperty(TENANT_A, PROP_STATUS, { status: 'cancelled' })
		expect(cancelledOnly.map((x) => x.id)).toEqual([a.id])
	})

	test('[L4] listByProperty: roomTypeId filter narrows', async () => {
		const PROP_RT = newId('property')
		await seedAvailability(TENANT_A, PROP_RT, RT_A, ['2028-09-01'])
		await seedAvailability(TENANT_A, PROP_RT, RT_B, ['2028-09-02'])
		const a = await repo.create(
			TENANT_A,
			PROP_RT,
			buildInput({ checkIn: '2028-09-01', checkOut: '2028-09-02', roomTypeId: RT_A }),
			buildCtx(buildSlices(['2028-09-01'])),
		)
		trackBooking(TENANT_A, PROP_RT, a.checkIn, a.id)
		const b = await repo.create(
			TENANT_A,
			PROP_RT,
			buildInput({ checkIn: '2028-09-02', checkOut: '2028-09-03', roomTypeId: RT_B }),
			buildCtx(buildSlices(['2028-09-02'])),
		)
		trackBooking(TENANT_A, PROP_RT, b.checkIn, b.id)
		const onlyA = await repo.listByProperty(TENANT_A, PROP_RT, { roomTypeId: RT_A })
		expect(onlyA.map((x) => x.id)).toEqual([a.id])
	})

	// ---------------------------------------------------------------------------
	// M4b-2: state transitions (checkIn / checkOut / markNoShow)
	// ---------------------------------------------------------------------------

	/** Small factory — create a confirmed booking for N nights and track cleanup. */
	async function makeConfirmed(
		propertyId: string,
		roomTypeId: string,
		tenantId: string,
		startDate: string,
		nightsCount = 1,
	): Promise<Booking> {
		const nights: string[] = []
		const start = new Date(`${startDate}T00:00:00Z`)
		for (let i = 0; i < nightsCount; i++) {
			const d = new Date(start)
			d.setUTCDate(start.getUTCDate() + i)
			nights.push(d.toISOString().slice(0, 10))
		}
		const end = new Date(start)
		end.setUTCDate(start.getUTCDate() + nightsCount)
		const checkOut = end.toISOString().slice(0, 10)

		await seedAvailability(tenantId, propertyId, roomTypeId, nights)
		const created = await repo.create(
			tenantId,
			propertyId,
			buildInput({ roomTypeId, checkIn: startDate, checkOut }),
			buildCtx(buildSlices(nights)),
		)
		trackBooking(tenantId, propertyId, created.checkIn, created.id)
		return created
	}

	// ---------------- checkIn ----------------

	test('[T5] checkIn from wrong tenant → null, own-tenant row intact', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-01-05')
		expect(await repo.checkIn(TENANT_B, b.id, {}, USER_B)).toBeNull()
		const after = await repo.getById(TENANT_A, b.id)
		expect(after?.status).toBe('confirmed')
		expect(after?.checkedInAt).toBeNull()
	})

	test('[S6,X2,A2] checkIn from confirmed: status/timestamp/monotonicity/immutables', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-01-10')
		await new Promise((r) => setTimeout(r, 12))
		const checkedIn = await repo.checkIn(TENANT_A, b.id, {}, USER_B)
		expect(checkedIn).not.toBeNull()
		if (!checkedIn) return

		expect(checkedIn.status).toBe('in_house')
		expect(checkedIn.checkedInAt).not.toBeNull()
		expect(checkedIn.updatedBy).toBe(USER_B)
		expect(new Date(checkedIn.updatedAt).getTime()).toBeGreaterThan(new Date(b.updatedAt).getTime())
		// A2: no room assignment passed → stays null
		expect(checkedIn.assignedRoomId).toBeNull()

		// X2: immutables preserved
		expect(checkedIn.id).toBe(b.id)
		expect(checkedIn.tenantId).toBe(b.tenantId)
		expect(checkedIn.propertyId).toBe(b.propertyId)
		expect(checkedIn.checkIn).toBe(b.checkIn)
		expect(checkedIn.createdAt).toBe(b.createdAt)
		expect(checkedIn.createdBy).toBe(b.createdBy)
		expect(checkedIn.confirmedAt).toBe(b.confirmedAt)

		// Re-fetch — server persisted exactly what we returned
		const fetched = await repo.getById(TENANT_A, b.id)
		expect(fetched).toEqual(checkedIn)
	})

	test('[A1] checkIn with assignedRoomId stores it', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-01-15')
		const roomId = newId('room')
		const checkedIn = await repo.checkIn(TENANT_A, b.id, { assignedRoomId: roomId }, USER_A)
		expect(checkedIn?.assignedRoomId).toBe(roomId)
		expect((await repo.getById(TENANT_A, b.id))?.assignedRoomId).toBe(roomId)
	})

	test('[S7] checkIn on already-in_house → InvalidBookingTransitionError', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-01-20')
		await repo.checkIn(TENANT_A, b.id, {}, USER_A)
		await expect(repo.checkIn(TENANT_A, b.id, {}, USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[S8] checkIn on cancelled → InvalidBookingTransitionError', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-01-25')
		await repo.cancel(TENANT_A, b.id, 'test', USER_A)
		await expect(repo.checkIn(TENANT_A, b.id, {}, USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[S9] checkIn on no_show → InvalidBookingTransitionError (irreversible)', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-02-01')
		await repo.markNoShow(TENANT_A, b.id, 'guest didnt arrive', USER_A)
		await expect(repo.checkIn(TENANT_A, b.id, {}, USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[S10] checkIn on checked_out → InvalidBookingTransitionError', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-02-05')
		await repo.checkIn(TENANT_A, b.id, {}, USER_A)
		await repo.checkOut(TENANT_A, b.id, USER_A)
		await expect(repo.checkIn(TENANT_A, b.id, {}, USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[I7] checkIn does NOT change availability.sold', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-02-10', 2)
		const nights = ['2029-02-10', '2029-02-11']
		const soldBefore = await Promise.all(nights.map((d) => readSold(TENANT_A, PROP_A, RT_A, d)))
		await repo.checkIn(TENANT_A, b.id, {}, USER_A)
		const soldAfter = await Promise.all(nights.map((d) => readSold(TENANT_A, PROP_A, RT_A, d)))
		expect(soldAfter).toEqual(soldBefore)
	})

	test('[R2] Promise.all double checkIn: exactly 1 succeeds', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-02-15')
		const results = await Promise.allSettled([
			repo.checkIn(TENANT_A, b.id, {}, USER_A),
			repo.checkIn(TENANT_A, b.id, {}, USER_A),
		])
		const fulfilled = results.filter((r) => r.status === 'fulfilled')
		const rejected = results.filter((r) => r.status === 'rejected')
		expect(fulfilled).toHaveLength(1)
		expect(rejected).toHaveLength(1)
		// Rejected one must be InvalidBookingTransitionError (the loser saw status
		// already advanced to in_house). OCC retries idempotent-flagged tx, which
		// succeeds on retry and then the guard re-rejects with domain error.
		if (rejected[0]?.status === 'rejected') {
			expect(rejected[0].reason).toBeInstanceOf(InvalidBookingTransitionError)
		}
	})

	// ---------------- checkOut ----------------

	test('[T6] checkOut from wrong tenant → null, row intact', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-03-01')
		await repo.checkIn(TENANT_A, b.id, {}, USER_A)
		expect(await repo.checkOut(TENANT_B, b.id, USER_B)).toBeNull()
		expect((await repo.getById(TENANT_A, b.id))?.status).toBe('in_house')
	})

	test('[S11,X3] checkOut from in_house: terminal transition + immutables', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-03-05')
		const roomId = newId('room')
		const checkedIn = await repo.checkIn(TENANT_A, b.id, { assignedRoomId: roomId }, USER_A)
		expect(checkedIn?.status).toBe('in_house')
		await new Promise((r) => setTimeout(r, 12))
		const checkedOut = await repo.checkOut(TENANT_A, b.id, USER_B)
		expect(checkedOut).not.toBeNull()
		if (!checkedOut || !checkedIn) return

		expect(checkedOut.status).toBe('checked_out')
		expect(checkedOut.checkedOutAt).not.toBeNull()
		expect(checkedOut.updatedBy).toBe(USER_B)
		expect(new Date(checkedOut.updatedAt).getTime()).toBeGreaterThan(
			new Date(checkedIn.updatedAt).getTime(),
		)
		// X3: checkedInAt + assignedRoomId preserved
		expect(checkedOut.checkedInAt).toBe(checkedIn.checkedInAt)
		expect(checkedOut.assignedRoomId).toBe(roomId)
		// Immutables
		expect(checkedOut.createdAt).toBe(b.createdAt)
		expect(checkedOut.createdBy).toBe(b.createdBy)
		expect(checkedOut.confirmedAt).toBe(b.confirmedAt)
	})

	test('[S12] checkOut from confirmed (no check-in) → InvalidBookingTransitionError', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-03-10')
		await expect(repo.checkOut(TENANT_A, b.id, USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[S13] checkOut from cancelled → InvalidBookingTransitionError', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-03-15')
		await repo.cancel(TENANT_A, b.id, 'test', USER_A)
		await expect(repo.checkOut(TENANT_A, b.id, USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[I8] checkOut does NOT change availability.sold', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-03-20', 2)
		await repo.checkIn(TENANT_A, b.id, {}, USER_A)
		const nights = ['2029-03-20', '2029-03-21']
		const soldBefore = await Promise.all(nights.map((d) => readSold(TENANT_A, PROP_A, RT_A, d)))
		await repo.checkOut(TENANT_A, b.id, USER_A)
		const soldAfter = await Promise.all(nights.map((d) => readSold(TENANT_A, PROP_A, RT_A, d)))
		expect(soldAfter).toEqual(soldBefore)
	})

	// ---------------- markNoShow ----------------

	test('[T7] markNoShow from wrong tenant → null, row intact', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-04-01')
		expect(await repo.markNoShow(TENANT_B, b.id, 'bogus', USER_B)).toBeNull()
		expect((await repo.getById(TENANT_A, b.id))?.status).toBe('confirmed')
	})

	test('[S14,RN1,X4] markNoShow from confirmed: status/noShowAt/reason/immutables', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-04-05')
		await new Promise((r) => setTimeout(r, 12))
		const noShown = await repo.markNoShow(TENANT_A, b.id, 'guest did not arrive', USER_B)
		expect(noShown).not.toBeNull()
		if (!noShown) return

		expect(noShown.status).toBe('no_show')
		expect(noShown.noShowAt).not.toBeNull()
		// markNoShow stores the reason in `cancelReason` column (re-used for narrative).
		expect(noShown.cancelReason).toBe('guest did not arrive')
		expect(noShown.updatedBy).toBe(USER_B)
		expect(new Date(noShown.updatedAt).getTime()).toBeGreaterThan(new Date(b.updatedAt).getTime())

		// X4: immutables preserved
		expect(noShown.id).toBe(b.id)
		expect(noShown.tenantId).toBe(b.tenantId)
		expect(noShown.propertyId).toBe(b.propertyId)
		expect(noShown.checkIn).toBe(b.checkIn)
		expect(noShown.createdAt).toBe(b.createdAt)
		expect(noShown.createdBy).toBe(b.createdBy)
		expect(noShown.confirmedAt).toBe(b.confirmedAt)
	})

	test('[RN1-null] markNoShow with null reason stores null', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-04-10')
		const noShown = await repo.markNoShow(TENANT_A, b.id, null, USER_A)
		expect(noShown?.cancelReason).toBeNull()
		expect((await repo.getById(TENANT_A, b.id))?.cancelReason).toBeNull()
	})

	test('[S15] markNoShow from in_house → InvalidBookingTransitionError', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-04-15')
		await repo.checkIn(TENANT_A, b.id, {}, USER_A)
		await expect(repo.markNoShow(TENANT_A, b.id, 'late', USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[S16] markNoShow from cancelled → InvalidBookingTransitionError', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-04-20')
		await repo.cancel(TENANT_A, b.id, 'test', USER_A)
		await expect(repo.markNoShow(TENANT_A, b.id, 'test', USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[S19] markNoShow second call → InvalidBookingTransitionError (irreversible)', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-04-25')
		await repo.markNoShow(TENANT_A, b.id, 'first', USER_A)
		await expect(repo.markNoShow(TENANT_A, b.id, 'second', USER_A)).rejects.toBeInstanceOf(
			InvalidBookingTransitionError,
		)
	})

	test('[I9] markNoShow does NOT decrement availability.sold', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-05-01', 2)
		const nights = ['2029-05-01', '2029-05-02']
		const soldBefore = await Promise.all(nights.map((d) => readSold(TENANT_A, PROP_A, RT_A, d)))
		await repo.markNoShow(TENANT_A, b.id, 'no-show', USER_A)
		const soldAfter = await Promise.all(nights.map((d) => readSold(TENANT_A, PROP_A, RT_A, d)))
		expect(soldAfter).toEqual(soldBefore)
	})

	// ---------------- Cancel-from-other-states (M4a extension) ----------------

	test('[S18] cancel from in_house is ALLOWED (early departure); sold decrements', async () => {
		const b = await makeConfirmed(PROP_A, RT_A, TENANT_A, '2029-06-01', 2)
		await repo.checkIn(TENANT_A, b.id, {}, USER_A)
		const nights = ['2029-06-01', '2029-06-02']
		const soldBefore = await Promise.all(nights.map((d) => readSold(TENANT_A, PROP_A, RT_A, d)))
		const cancelled = await repo.cancel(TENANT_A, b.id, 'early departure', USER_A)
		expect(cancelled?.status).toBe('cancelled')
		const soldAfter = await Promise.all(nights.map((d) => readSold(TENANT_A, PROP_A, RT_A, d)))
		for (let i = 0; i < nights.length; i++) {
			expect(soldAfter[i]).toBe((soldBefore[i] ?? 0) - 1)
		}
	})
})
