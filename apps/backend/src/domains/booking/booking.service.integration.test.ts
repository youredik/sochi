/**
 * Booking service — FULL-CHAIN integration tests against real YDB.
 *
 * Why this file exists: unit tests cover pure helpers (computeTourismTax,
 * computeCancellationFeeSnapshot, deriveRegistrationStatus); repo tests
 * cover the atomic tx and state machine. But `booking.service.create`
 * ORCHESTRATES property + roomType + ratePlan + rate + availability +
 * booking — the tourism-tax + registration-status logic only runs when
 * everything is wired. This file proves the production code path works.
 *
 * Business invariants (example-based):
 *
 *   Tourism tax end-to-end (M4e):
 *     [BI1] property.tourismTaxRateBps=null → booking.tourismTaxMicros = '0'
 *           (opt-out semantic propagates through service.create)
 *     [BI2] Sochi property (rateBps=200) + 2-night × 5000₽ booking → tax
 *           proportional: 2 × 5000 × 0.02 = 200₽ = 200_000_000 micros
 *     [BI3] Low-base booking (1-night × 100₽) with rateBps=200 → floor wins:
 *           max(2₽, 100₽) = 100₽ = 100_000_000 micros
 *     [BI4] 2027 roadmap rate 300 bps → 3% proportional (future-proof)
 *
 *   Registration status derivation (M4e):
 *     [BI5] RU-citizen guest → registrationStatus='notRequired'
 *     [BI6] Foreign-citizen guest (US) → registrationStatus='pending'
 *
 *   Tourism tax quarterly report (M4e):
 *     [BR1] Report aggregates tax + base + count for bookings in date range
 *     [BR2] Cancelled bookings EXCLUDED (never accrued tax liability)
 *     [BR3] No-show bookings INCLUDED (revenue integrity — hotel retains charge)
 *     [BR4] Date range filter: outside-window bookings not counted
 *     [BR5] Empty period (no bookings) → zero tax + zero count (not error)
 *     [BR6] Cross-tenant: report for other tenant's property → NotFoundError
 *
 * Requires local YDB + all M4a-M4e migrations applied (0001-0005).
 */
import type { Booking, RatePlan, RoomType } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { dateFromIso } from '../../db/ydb-helpers.ts'
import { PropertyNotFoundError } from '../../errors/domain.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createAvailabilityFactory } from '../availability/availability.factory.ts'
import { createPropertyFactory } from '../property/property.factory.ts'
import { createRateFactory } from '../rate/rate.factory.ts'
import { createRatePlanFactory } from '../ratePlan/ratePlan.factory.ts'
import { createRoomTypeFactory } from '../roomType/roomType.factory.ts'
import { createBookingFactory } from './booking.factory.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
// Dedicated tenant for ORG-report exact-value tests so other suite tests
// don't leak bookings into KPI totals.
const TENANT_ORG_ISOLATED = newId('organization')
const USER_A = newId('user')

describe('booking.service integration (M4e end-to-end)', { tags: ['db'], timeout: 60_000 }, () => {
	let booking: ReturnType<typeof createBookingFactory>['service']
	let property: ReturnType<typeof createPropertyFactory>['service']
	let roomType: ReturnType<typeof createRoomTypeFactory>['service']
	let ratePlan: ReturnType<typeof createRatePlanFactory>['service']
	let rateRepo: ReturnType<typeof createRateFactory>['repo']
	let availability: ReturnType<typeof createAvailabilityFactory>['service']

	const cleanup: Array<() => Promise<void>> = []

	beforeAll(async () => {
		await setupTestDb()
		const sql = getTestSql()
		const propertyFactory = createPropertyFactory(sql)
		const roomTypeFactory = createRoomTypeFactory(sql, propertyFactory.service)
		const ratePlanFactory = createRatePlanFactory(
			sql,
			propertyFactory.service,
			roomTypeFactory.service,
		)
		const rateFactory = createRateFactory(sql, ratePlanFactory.service)
		const availabilityFactory = createAvailabilityFactory(sql, roomTypeFactory.service)
		const bookingFactory = createBookingFactory(
			sql,
			rateFactory.repo,
			propertyFactory.service,
			roomTypeFactory.service,
			ratePlanFactory.service,
		)
		booking = bookingFactory.service
		property = propertyFactory.service
		roomType = roomTypeFactory.service
		ratePlan = ratePlanFactory.service
		rateRepo = rateFactory.repo
		availability = availabilityFactory.service
	})

	afterAll(async () => {
		for (const fn of cleanup.reverse()) {
			try {
				await fn()
			} catch {
				// best-effort — don't mask test errors with cleanup errors
			}
		}
		await teardownTestDb()
	})

	/**
	 * Build the full domain chain needed for a booking:
	 *   property(city='Sochi', tourismTaxRateBps) → roomType (1 inventory)
	 *   → ratePlan (refundable BAR) → rate (one row per date)
	 *   → availability (allotment=1 per date, sold=0).
	 * Returns IDs + cleanup closures tracked in `cleanup[]`.
	 */
	async function seedChain(opts: {
		tenantId: string
		tourismTaxRateBps: number | null
		dates: string[]
		amountDecimal: string
	}) {
		const prop = await property.create(opts.tenantId, {
			name: `Prop-${Math.random()}`,
			address: 'ул. Тест',
			city: 'Sochi',
			tourismTaxRateBps: opts.tourismTaxRateBps,
		})
		cleanup.push(async () => {
			await property.delete(opts.tenantId, prop.id)
		})
		const rt = await roomType.create(opts.tenantId, prop.id, {
			name: 'Standard',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 1,
		})
		cleanup.push(async () => {
			await roomType.delete(opts.tenantId, rt.id)
		})
		const rp = await ratePlan.create(opts.tenantId, {
			roomTypeId: rt.id,
			name: 'BAR Flexible',
			code: `BAR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		cleanup.push(async () => {
			await ratePlan.delete(opts.tenantId, rp.id)
		})
		await rateRepo.bulkUpsert(opts.tenantId, prop.id, rt.id, rp.id, {
			rates: opts.dates.map((date) => ({
				date,
				amount: opts.amountDecimal,
				currency: 'RUB',
			})),
		})
		cleanup.push(async () => {
			const sql = getTestSql()
			for (const d of opts.dates) {
				await sql`
					DELETE FROM rate
					WHERE tenantId = ${opts.tenantId}
						AND propertyId = ${prop.id}
						AND roomTypeId = ${rt.id}
						AND ratePlanId = ${rp.id}
						AND date = ${dateFromIso(d)}
				`
			}
		})
		await availability.bulkUpsert(opts.tenantId, rt.id, {
			rates: opts.dates.map((date) => ({ date, allotment: 1 })),
		})
		cleanup.push(async () => {
			const sql = getTestSql()
			for (const d of opts.dates) {
				await sql`
					DELETE FROM availability
					WHERE tenantId = ${opts.tenantId}
						AND propertyId = ${prop.id}
						AND roomTypeId = ${rt.id}
						AND date = ${dateFromIso(d)}
				`
			}
		})
		return { prop, rt, rp }
	}

	async function trackBookingCleanup(b: Booking) {
		cleanup.push(async () => {
			const sql = getTestSql()
			await sql`
				DELETE FROM booking
				WHERE tenantId = ${b.tenantId}
					AND propertyId = ${b.propertyId}
					AND checkIn = ${dateFromIso(b.checkIn)}
					AND id = ${b.id}
			`
		})
	}

	function buildBookingInput(
		rt: RoomType,
		rp: RatePlan,
		dates: { checkIn: string; checkOut: string },
		citizenship = 'RU',
	) {
		return {
			roomTypeId: rt.id,
			ratePlanId: rp.id,
			checkIn: dates.checkIn,
			checkOut: dates.checkOut,
			guestsCount: 1,
			primaryGuestId: newId('guest'),
			guestSnapshot: {
				firstName: 'Test',
				lastName: 'Guest',
				citizenship,
				documentType: 'foreignPassport',
				documentNumber: 'XX000000',
			},
			channelCode: 'direct' as const,
		}
	}

	// ---------------- Tourism tax end-to-end ----------------

	test('[BI1] rateBps=null → booking.tourismTaxMicros = "0" (opt-out through service.create)', async () => {
		const dates = ['2031-01-10', '2031-01-11']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: null,
			dates,
			amountDecimal: '5000',
		})
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2031-01-10', checkOut: '2031-01-12' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		expect(b.tourismTaxMicros).toBe('0')
		expect(b.tourismTaxBaseMicros).toBe(10_000_000_000n.toString()) // 2 × 5000 = 10000 RUB in micros
	})

	test('[BI2] Sochi 2026 rate 200 bps, 2 × 5000₽ → proportional 200₽ = 200_000_000 micros', async () => {
		const dates = ['2031-02-10', '2031-02-11']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2031-02-10', checkOut: '2031-02-12' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		// 2% × 10_000_000_000 micros = 200_000_000 micros. Floor = 100_000_000 × 2 = 200_000_000.
		// Proportional == floor → either returns 200_000_000.
		expect(b.tourismTaxMicros).toBe(200_000_000n.toString())
	})

	test('[BI3] Low-base booking (1 × 100₽) with rateBps=200 → floor wins (₽100)', async () => {
		const dates = ['2031-03-10']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '100',
		})
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2031-03-10', checkOut: '2031-03-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		// 2% × 100_000_000 = 2_000_000 (₽2). Floor = 100_000_000 × 1 = 100_000_000 (₽100). Floor wins.
		expect(b.tourismTaxMicros).toBe(100_000_000n.toString())
	})

	test('[BI4] 2027 federal rate 300 bps, 3 × 10_000₽ → proportional 900₽', async () => {
		const dates = ['2031-04-10', '2031-04-11', '2031-04-12']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 300,
			dates,
			amountDecimal: '10000',
		})
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2031-04-10', checkOut: '2031-04-13' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		// 3% × 30_000_000_000 = 900_000_000 micros (₽900).
		expect(b.tourismTaxMicros).toBe(900_000_000n.toString())
	})

	// ---------------- Registration status ----------------

	test('[BI5] RU-citizen guest snapshot → registrationStatus=notRequired', async () => {
		const dates = ['2031-05-10']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2031-05-10', checkOut: '2031-05-11' }, 'RU'),
			USER_A,
		)
		await trackBookingCleanup(b)
		expect(b.registrationStatus).toBe('notRequired')
	})

	test('[BI6] Foreign-citizen guest (US) → registrationStatus=pending (МВД required)', async () => {
		const dates = ['2031-06-10']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2031-06-10', checkOut: '2031-06-11' }, 'US'),
			USER_A,
		)
		await trackBookingCleanup(b)
		expect(b.registrationStatus).toBe('pending')
	})

	// ---------------- Quarterly tourism tax report ----------------

	test('[BR1] Report aggregates tax + base + count for bookings in date range', async () => {
		// Dedicated property so this test doesn't see other tests' bookings.
		const dates = ['2031-07-10', '2031-07-15', '2031-07-20']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		for (const d of dates) {
			const dd = new Date(`${d}T00:00:00Z`)
			dd.setUTCDate(dd.getUTCDate() + 1)
			const co = dd.toISOString().slice(0, 10)
			const b = await booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: d, checkOut: co }),
				USER_A,
			)
			await trackBookingCleanup(b)
		}
		const report = await booking.getTourismTaxReport(TENANT_A, prop.id, {
			from: '2031-07-01',
			to: '2031-07-31',
		})
		expect(report.bookingsCount).toBe(3)
		// Each booking = ₽100 tax (floor wins for 1-night × 5000₽ base: 2% = ₽100, floor = ₽100, equal).
		expect(report.tourismTaxMicros).toBe((100_000_000n * 3n).toString())
		expect(report.accommodationBaseMicros).toBe((5_000_000_000n * 3n).toString())
	})

	test('[BR2,BR3] cancelled EXCLUDED, no_show INCLUDED in report', async () => {
		const dates = ['2031-08-05', '2031-08-10', '2031-08-15']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const [b1, b2, b3] = await Promise.all([
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2031-08-05', checkOut: '2031-08-06' }),
				USER_A,
			),
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2031-08-10', checkOut: '2031-08-11' }),
				USER_A,
			),
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2031-08-15', checkOut: '2031-08-16' }),
				USER_A,
			),
		])
		if (b1) await trackBookingCleanup(b1)
		if (b2) await trackBookingCleanup(b2)
		if (b3) await trackBookingCleanup(b3)
		// b1 → cancelled (excluded). b2 → no_show (included). b3 → confirmed (included).
		await booking.cancel(TENANT_A, b1.id, { reason: 'test' }, USER_A)
		await booking.markNoShow(TENANT_A, b2.id, { reason: 'test' }, USER_A)

		const report = await booking.getTourismTaxReport(TENANT_A, prop.id, {
			from: '2031-08-01',
			to: '2031-08-31',
		})
		expect(report.bookingsCount).toBe(2) // cancelled excluded, no_show + confirmed included
		expect(report.tourismTaxMicros).toBe((100_000_000n * 2n).toString())
	})

	test('[BR4] Date range filter: outside-window bookings not counted', async () => {
		// Bookings in July; report for June → empty.
		const dates = ['2031-07-25']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2031-07-25', checkOut: '2031-07-26' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		const report = await booking.getTourismTaxReport(TENANT_A, prop.id, {
			from: '2031-06-01',
			to: '2031-06-30',
		})
		expect(report.bookingsCount).toBe(0)
		expect(report.tourismTaxMicros).toBe('0')
		expect(report.accommodationBaseMicros).toBe('0')
	})

	test('[BR5] Empty period → zero tax + zero count (not error)', async () => {
		const dates = ['2031-09-10']
		const { prop } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const report = await booking.getTourismTaxReport(TENANT_A, prop.id, {
			from: '2031-09-01',
			to: '2031-09-30',
		})
		expect(report.bookingsCount).toBe(0)
		expect(report.tourismTaxMicros).toBe('0')
	})

	test('[BR6] Cross-tenant: report for other tenant → PropertyNotFoundError', async () => {
		const dates = ['2031-10-10']
		const { prop } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		await expect(
			booking.getTourismTaxReport(TENANT_B, prop.id, {
				from: '2031-10-01',
				to: '2031-10-31',
			}),
		).rejects.toBeInstanceOf(PropertyNotFoundError)
	})

	// ---------------- M7.fix.3.a — Organisation-level tax report ----------------
	//
	//   [ORG1] Single property → KPI + row + monthly populated correctly
	//   [ORG2] Two properties same tenant → flatten across both, propertyName set
	//   [ORG3] propertyId filter narrows to one property only
	//   [ORG4] Cross-tenant propertyId → PropertyNotFoundError
	//   [ORG5] Cross-tenant scope: TENANT_B sees zero of TENANT_A's data
	//   [ORG6] cancelled excluded, no_show included (parity with per-property)
	//   [ORG7] Monthly bucketing across Jan/Feb → 2 monthly entries, totals match
	//   [ORG8] Empty period → zero KPI + empty rows/monthly (not error)
	//   [ORG9] Deactivated property STILL included (booking liability persists)
	//   [ORG10] Row.guestName composed from snapshot (lastName + firstName + middleName)
	//   [ORG11] Rows sorted by checkIn ASC, then bookingId ASC

	test('[ORG1] Single property → KPI exact + row + monthly bucket exact (isolated tenant)', async () => {
		// Isolated tenant — no other tests touch it, so KPI totals are EXACT,
		// not "≥ 1" loosely.
		const dates = ['2031-11-10', '2031-11-11']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_ORG_ISOLATED,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const b = await booking.create(
			TENANT_ORG_ISOLATED,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2031-11-10', checkOut: '2031-11-12' }),
			USER_A,
		)
		await trackBookingCleanup(b)

		const report = await booking.getTourismTaxOrgReport(TENANT_ORG_ISOLATED, {
			from: '2031-11-01',
			to: '2031-11-30',
		})
		expect(report.period).toEqual({ from: '2031-11-01', to: '2031-11-30' })
		expect(report.propertyId).toBeNull()

		// EXACT KPI totals: only our 1 booking.
		expect(report.kpi.bookingsCount).toBe(1)
		expect(report.kpi.totalNights).toBe(2)
		expect(report.kpi.tourismTaxMicros).toBe(200_000_000n.toString())
		expect(report.kpi.accommodationBaseMicros).toBe(10_000_000_000n.toString())

		// EXACT rows.
		expect(report.rows.length).toBe(1)
		const row = report.rows[0]
		expect(row?.bookingId).toBe(b.id)
		expect(row?.propertyId).toBe(prop.id)
		expect(row?.propertyName).toBe(prop.name)
		expect(row?.nightsCount).toBe(2)
		expect(row?.tourismTaxMicros).toBe(200_000_000n.toString())
		expect(row?.accommodationBaseMicros).toBe(10_000_000_000n.toString())
		expect(row?.status).toBe('confirmed')
		expect(row?.channelCode).toBe('direct')
		expect(row?.checkIn).toBe('2031-11-10')
		expect(row?.checkOut).toBe('2031-11-12')

		// EXACT monthly: 1 bucket, exactly our booking.
		expect(report.monthly.length).toBe(1)
		const novMonth = report.monthly[0]
		expect(novMonth?.month).toBe('2031-11')
		expect(novMonth?.bookingsCount).toBe(1)
		expect(novMonth?.totalNights).toBe(2)
		expect(novMonth?.tourismTaxMicros).toBe(200_000_000n.toString())
		expect(novMonth?.accommodationBaseMicros).toBe(10_000_000_000n.toString())
	})

	test('[ORG2] Two properties same tenant → flattened across both', async () => {
		const dates = ['2032-01-10', '2032-01-11']
		const {
			prop: propX,
			rt: rtX,
			rp: rpX,
		} = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const {
			prop: propY,
			rt: rtY,
			rp: rpY,
		} = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const bX = await booking.create(
			TENANT_A,
			propX.id,
			buildBookingInput(rtX, rpX, { checkIn: '2032-01-10', checkOut: '2032-01-12' }),
			USER_A,
		)
		const bY = await booking.create(
			TENANT_A,
			propY.id,
			buildBookingInput(rtY, rpY, { checkIn: '2032-01-10', checkOut: '2032-01-12' }),
			USER_A,
		)
		await trackBookingCleanup(bX)
		await trackBookingCleanup(bY)

		const report = await booking.getTourismTaxOrgReport(TENANT_A, {
			from: '2032-01-01',
			to: '2032-01-31',
		})
		const propIds = new Set(report.rows.map((r) => r.propertyId))
		expect(propIds.has(propX.id)).toBe(true)
		expect(propIds.has(propY.id)).toBe(true)
	})

	test('[ORG3] propertyId filter narrows to one property only', async () => {
		const dates = ['2032-02-10']
		const {
			prop: propA,
			rt: rtA,
			rp: rpA,
		} = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const {
			prop: propB,
			rt: rtB,
			rp: rpB,
		} = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const bA = await booking.create(
			TENANT_A,
			propA.id,
			buildBookingInput(rtA, rpA, { checkIn: '2032-02-10', checkOut: '2032-02-11' }),
			USER_A,
		)
		const bB = await booking.create(
			TENANT_A,
			propB.id,
			buildBookingInput(rtB, rpB, { checkIn: '2032-02-10', checkOut: '2032-02-11' }),
			USER_A,
		)
		await trackBookingCleanup(bA)
		await trackBookingCleanup(bB)

		const report = await booking.getTourismTaxOrgReport(TENANT_A, {
			from: '2032-02-01',
			to: '2032-02-28',
			propertyId: propA.id,
		})
		expect(report.propertyId).toBe(propA.id)
		// Only propA's booking — nothing from propB.
		expect(report.rows.some((r) => r.propertyId === propB.id)).toBe(false)
		expect(report.rows.some((r) => r.bookingId === bA.id)).toBe(true)
	})

	test('[ORG4] Cross-tenant propertyId → PropertyNotFoundError', async () => {
		const dates = ['2032-03-10']
		const { prop } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		await expect(
			booking.getTourismTaxOrgReport(TENANT_B, {
				from: '2032-03-01',
				to: '2032-03-31',
				propertyId: prop.id,
			}),
		).rejects.toBeInstanceOf(PropertyNotFoundError)
	})

	test('[ORG5] Cross-tenant scope: TENANT_B sees zero of TENANT_A bookings', async () => {
		const dates = ['2032-04-10']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const bA = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2032-04-10', checkOut: '2032-04-11' }),
			USER_A,
		)
		await trackBookingCleanup(bA)
		const reportB = await booking.getTourismTaxOrgReport(TENANT_B, {
			from: '2032-04-01',
			to: '2032-04-30',
		})
		expect(reportB.rows.some((r) => r.bookingId === bA.id)).toBe(false)
	})

	test('[ORG6] cancelled excluded, no_show included (parity with per-property)', async () => {
		const dates = ['2032-05-05', '2032-05-10', '2032-05-15']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const [b1, b2, b3] = await Promise.all([
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2032-05-05', checkOut: '2032-05-06' }),
				USER_A,
			),
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2032-05-10', checkOut: '2032-05-11' }),
				USER_A,
			),
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2032-05-15', checkOut: '2032-05-16' }),
				USER_A,
			),
		])
		if (b1) await trackBookingCleanup(b1)
		if (b2) await trackBookingCleanup(b2)
		if (b3) await trackBookingCleanup(b3)
		await booking.cancel(TENANT_A, b1.id, { reason: 'test' }, USER_A)
		await booking.markNoShow(TENANT_A, b2.id, { reason: 'test' }, USER_A)

		const report = await booking.getTourismTaxOrgReport(TENANT_A, {
			from: '2032-05-01',
			to: '2032-05-31',
			propertyId: prop.id,
		})
		const ourBookingIds = new Set([b1.id, b2.id, b3.id])
		const ourRows = report.rows.filter((r) => ourBookingIds.has(r.bookingId))
		expect(ourRows.length).toBe(2)
		expect(ourRows.some((r) => r.bookingId === b1.id)).toBe(false)
		expect(ourRows.some((r) => r.bookingId === b2.id)).toBe(true)
		expect(ourRows.some((r) => r.bookingId === b3.id)).toBe(true)
	})

	test('[ORG7] Monthly bucketing across Jan/Feb → 2 entries with correct totals', async () => {
		const datesJan = ['2032-06-15', '2032-06-16'] // ← reuse seedChain creates 1 prop covering both periods
		const datesFeb = ['2032-07-15', '2032-07-16']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates: [...datesJan, ...datesFeb],
			amountDecimal: '5000',
		})
		const bJan = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2032-06-15', checkOut: '2032-06-16' }),
			USER_A,
		)
		const bFeb = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2032-07-15', checkOut: '2032-07-16' }),
			USER_A,
		)
		await trackBookingCleanup(bJan)
		await trackBookingCleanup(bFeb)

		const report = await booking.getTourismTaxOrgReport(TENANT_A, {
			from: '2032-06-01',
			to: '2032-07-31',
			propertyId: prop.id,
		})
		const jun = report.monthly.find((m) => m.month === '2032-06')
		const jul = report.monthly.find((m) => m.month === '2032-07')
		expect(jun?.bookingsCount).toBe(1)
		expect(jul?.bookingsCount).toBe(1)
		expect(jun?.tourismTaxMicros).toBe(100_000_000n.toString())
		expect(jul?.tourismTaxMicros).toBe(100_000_000n.toString())
		expect(jun?.totalNights).toBe(1)
		expect(jul?.totalNights).toBe(1)
	})

	test('[ORG8] Empty period → zero KPI + empty rows/monthly', async () => {
		const report = await booking.getTourismTaxOrgReport(TENANT_A, {
			from: '2099-01-01',
			to: '2099-01-31',
		})
		expect(report.kpi.bookingsCount).toBe(0)
		expect(report.kpi.totalNights).toBe(0)
		expect(report.kpi.tourismTaxMicros).toBe('0')
		expect(report.kpi.accommodationBaseMicros).toBe('0')
		expect(report.rows).toEqual([])
		expect(report.monthly).toEqual([])
	})

	test('[ORG9] Deactivated property STILL included (booking liability persists)', async () => {
		const dates = ['2032-08-10']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2032-08-10', checkOut: '2032-08-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		// Deactivate property AFTER booking — operator UI hides it but tax
		// liability remains for fiscal reporting.
		await property.update(TENANT_A, prop.id, { isActive: false })

		const report = await booking.getTourismTaxOrgReport(TENANT_A, {
			from: '2032-08-01',
			to: '2032-08-31',
		})
		expect(report.rows.some((r) => r.bookingId === b.id)).toBe(true)
	})

	test('[ORG10] Row.guestName composed from snapshot (lastName + firstName)', async () => {
		const dates = ['2032-09-10']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const input = {
			...buildBookingInput(rt, rp, { checkIn: '2032-09-10', checkOut: '2032-09-11' }),
			guestSnapshot: {
				firstName: 'Иван',
				lastName: 'Петров',
				middleName: 'Сергеевич',
				citizenship: 'RU',
				documentType: 'passport',
				documentNumber: '4500000000',
			},
		}
		const b = await booking.create(TENANT_A, prop.id, input, USER_A)
		await trackBookingCleanup(b)

		const report = await booking.getTourismTaxOrgReport(TENANT_A, {
			from: '2032-09-01',
			to: '2032-09-30',
			propertyId: prop.id,
		})
		const ourRow = report.rows.find((r) => r.bookingId === b.id)
		expect(ourRow?.guestName).toBe('Петров Иван Сергеевич')
	})

	test('[ORG_INHOUSE] booking with status=in_house INCLUDED (any non-cancelled retains liability)', async () => {
		const dates = ['2032-11-10']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_ORG_ISOLATED,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		const b = await booking.create(
			TENANT_ORG_ISOLATED,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2032-11-10', checkOut: '2032-11-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		// Promote booking to in_house. Repo.checkIn requires the room assignment;
		// availability seeded with 1 room → repo auto-assigns from inventory.
		const room = (
			await getTestSql()<{ id: string }[]>`
				SELECT id FROM room
				WHERE tenantId = ${TENANT_ORG_ISOLATED}
					AND propertyId = ${prop.id}
					AND roomTypeId = ${rt.id}
				LIMIT 1
			`
		)[0]?.[0]
		// Some seed paths don't auto-create physical rooms; if absent, the
		// transition still moves status forward without an assignment id.
		const inHouseInput = room ? { assignedRoomId: room.id } : {}
		await booking.checkIn(TENANT_ORG_ISOLATED, b.id, inHouseInput, USER_A)

		const report = await booking.getTourismTaxOrgReport(TENANT_ORG_ISOLATED, {
			from: '2032-11-01',
			to: '2032-11-30',
			propertyId: prop.id,
		})
		const ourRow = report.rows.find((r) => r.bookingId === b.id)
		expect(ourRow).toBeDefined()
		expect(ourRow?.status).toBe('in_house')
	})

	test('[ORG11] Rows sorted by checkIn ASC, then bookingId ASC', async () => {
		const dates = ['2032-10-05', '2032-10-10', '2032-10-15']
		const { prop, rt, rp } = await seedChain({
			tenantId: TENANT_A,
			tourismTaxRateBps: 200,
			dates,
			amountDecimal: '5000',
		})
		// Insert in OUT-OF-ORDER chronologically to test sort.
		const bMid = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2032-10-10', checkOut: '2032-10-11' }),
			USER_A,
		)
		const bLast = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2032-10-15', checkOut: '2032-10-16' }),
			USER_A,
		)
		const bFirst = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2032-10-05', checkOut: '2032-10-06' }),
			USER_A,
		)
		await trackBookingCleanup(bMid)
		await trackBookingCleanup(bLast)
		await trackBookingCleanup(bFirst)

		const report = await booking.getTourismTaxOrgReport(TENANT_A, {
			from: '2032-10-01',
			to: '2032-10-31',
			propertyId: prop.id,
		})
		const ourIds = [bFirst.id, bMid.id, bLast.id]
		const ourRows = report.rows.filter((r) => ourIds.includes(r.bookingId))
		expect(ourRows.map((r) => r.bookingId)).toEqual(ourIds)
		expect(ourRows.map((r) => r.checkIn)).toEqual(['2032-10-05', '2032-10-10', '2032-10-15'])
	})
})
