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
})
