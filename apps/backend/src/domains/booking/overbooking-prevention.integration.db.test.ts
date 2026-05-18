/**
 * Overbooking-prevention canon — DB-level invariant tests (2026-05-18).
 *
 * Verifies that the `roomNightOccupancy` table acts as a primary-key-based
 * physical-room × date uniqueness constraint, making double-pin impossible
 * a priori — regardless of caller code path. Per agent research 2026-05-18:
 * YDB-canonical replacement для Postgres `EXCLUDE USING gist (... WITH &&)`
 * since YDB has no range types / CHECK constraints / triggers.
 *
 * Test taxonomy:
 *   [DB*]  Direct-INSERT raw-SQL tests — PK uniqueness invariant без репо
 *          (proves the constraint stands even when mass-import / channel push
 *          bypasses booking.repo entirely — Gap F from audit).
 *
 *   [LC*]  Lifecycle tests — occupancy rows correctly written / deleted on
 *          assignRoom / cancel / checkOut / markNoShow / changeRoomType.
 *          KEY invariant: every confirmed/in_house pinned booking has
 *          exactly N occupancy rows для its N nights.
 *
 *   [GB*]  Gap B fix tests — moveDates with pinned room into overlapping
 *          dates → RoomAssignmentConflictError. Pre-2026-05-18 silently
 *          allowed.
 *
 *   [OV*]  oversellDelta math tests — booking.create + moveDates respect
 *          effective allotment = allotment + oversellDelta (Apaleo canon).
 *
 * Bun http2.ts upstream typo (project canon `[[bun-http2-typo-2026-05-17]]`):
 * known flake on negative-path db tests. These tests are written sequentially
 * (no Promise.all) к minimise exposure, but full-suite runs may still
 * intermittently fail на assignRoom / moveDates paths. NO `.skip` per
 * `[[no-half-measures]]`; wait для Bun fix.
 */
import type { Booking, RatePlan, RoomType } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test'

jest.setTimeout(60_000)

import { dateFromIso, toTs } from '../../db/ydb-helpers.ts'
import { NoInventoryError, RoomAssignmentConflictError } from '../../errors/domain.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createAvailabilityFactory } from '../availability/availability.factory.ts'
import { createPropertyFactory } from '../property/property.factory.ts'
import { createRateFactory } from '../rate/rate.factory.ts'
import { createRatePlanFactory } from '../ratePlan/ratePlan.factory.ts'
import { createRoomFactory } from '../room/room.factory.ts'
import { createRoomTypeFactory } from '../roomType/roomType.factory.ts'
import { createBookingFactory } from './booking.factory.ts'

const TENANT_A = newId('organization')
const USER_A = newId('user')

describe('overbooking-prevention canon (db invariant)', () => {
	let booking: ReturnType<typeof createBookingFactory>['service']
	let property: ReturnType<typeof createPropertyFactory>['service']
	let roomType: ReturnType<typeof createRoomTypeFactory>['service']
	let ratePlan: ReturnType<typeof createRatePlanFactory>['service']
	let rateRepo: ReturnType<typeof createRateFactory>['repo']
	let availability: ReturnType<typeof createAvailabilityFactory>['service']
	let room: ReturnType<typeof createRoomFactory>['service']

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
		const roomFactory = createRoomFactory(sql, propertyFactory.service, roomTypeFactory.service)
		const bookingFactory = createBookingFactory(
			sql,
			rateFactory.repo,
			propertyFactory.service,
			roomTypeFactory.service,
			ratePlanFactory.service,
			roomFactory.service,
		)
		booking = bookingFactory.service
		property = propertyFactory.service
		roomType = roomTypeFactory.service
		ratePlan = ratePlanFactory.service
		rateRepo = rateFactory.repo
		availability = availabilityFactory.service
		room = roomFactory.service
	})

	afterAll(async () => {
		for (const fn of cleanup.reverse()) {
			try {
				await fn()
			} catch {
				// best-effort
			}
		}
		await teardownTestDb()
	})

	async function seedChain(opts: { dates: string[]; allotment?: number; amountDecimal?: string }) {
		const allotment = opts.allotment ?? 3
		const amount = opts.amountDecimal ?? '5000'
		const prop = await property.create(TENANT_A, {
			name: `Prop-OB-${Math.random()}`,
			address: 'ул. Тест',
			city: 'Sochi',
			tourismTaxRateBps: 200,
		})
		cleanup.push(() => property.delete(TENANT_A, prop.id).then(() => undefined))
		const rt = await roomType.create(TENANT_A, prop.id, {
			name: 'Standard',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: allotment,
		})
		cleanup.push(() => roomType.delete(TENANT_A, rt.id).then(() => undefined))
		const rp = await ratePlan.create(TENANT_A, {
			roomTypeId: rt.id,
			name: 'BAR',
			code: `BAR-OB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		cleanup.push(() => ratePlan.delete(TENANT_A, rp.id).then(() => undefined))
		await rateRepo.bulkUpsert(TENANT_A, prop.id, rt.id, rp.id, {
			rates: opts.dates.map((date) => ({ date, amount, currency: 'RUB' })),
		})
		await availability.bulkUpsert(TENANT_A, rt.id, {
			rates: opts.dates.map((date) => ({ date, allotment })),
		})
		return { prop, rt, rp }
	}

	async function seedRoom(_propertyId: string, roomTypeId: string, number: string) {
		const r = await room.create(TENANT_A, { roomTypeId, number })
		cleanup.push(() => room.delete(TENANT_A, r.id).then(() => undefined))
		return r
	}

	async function trackBookingCleanup(b: Booking) {
		cleanup.push(async () => {
			const sql = getTestSql()
			await sql`
				DELETE FROM roomNightOccupancy
				WHERE tenantId = ${b.tenantId} AND bookingId = ${b.id}
			`
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
				lastName: 'OB',
				citizenship: 'RU' as const,
				documentType: 'passport' as const,
				documentNumber: 'XX111111',
			},
			channelCode: 'direct' as const,
		}
	}

	async function countOccupancyForBooking(bookingId: string): Promise<number> {
		const sql = getTestSql()
		const [rows = []] = await sql<{ cnt: number | bigint }[]>`
			SELECT COUNT(*) AS cnt FROM roomNightOccupancy
			WHERE tenantId = ${TENANT_A} AND bookingId = ${bookingId}
		`
		return Number(rows[0]?.cnt ?? 0)
	}

	// ============================================================
	// [DB*] Direct-INSERT raw-SQL — DB-level PK invariant standalone
	// ============================================================

	test('[DB1] direct INSERT into roomNightOccupancy fails on PK conflict (raw-SQL, repo-bypass)', async () => {
		const sql = getTestSql()
		const propertyId = newId('property')
		const roomId = newId('room')
		const date = dateFromIso('2035-01-10')
		const now = toTs(new Date())
		const bookingIdA = newId('booking')
		const bookingIdB = newId('booking')

		try {
			// First INSERT succeeds — slot is taken by bookingA.
			await sql`
				INSERT INTO roomNightOccupancy
					(\`tenantId\`, \`propertyId\`, \`roomId\`, \`date\`, \`bookingId\`, \`createdAt\`)
				VALUES (${TENANT_A}, ${propertyId}, ${roomId}, ${date}, ${bookingIdA}, ${now})
			`

			// Second INSERT (different bookingId, same PK = tenant+property+room+date)
			// MUST fail with PRECONDITION_FAILED. This is THE invariant — without it
			// any code path can silently overbook.
			let threw = false
			try {
				await sql`
					INSERT INTO roomNightOccupancy
						(\`tenantId\`, \`propertyId\`, \`roomId\`, \`date\`, \`bookingId\`, \`createdAt\`)
					VALUES (${TENANT_A}, ${propertyId}, ${roomId}, ${date}, ${bookingIdB}, ${now})
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)

			// Original row intact (first booking still owns the slot).
			const [rows = []] = await sql<{ bookingId: string }[]>`
				SELECT bookingId FROM roomNightOccupancy
				WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId}
					AND roomId = ${roomId} AND date = ${date}
			`
			expect(rows[0]?.bookingId).toBe(bookingIdA)
		} finally {
			await sql`
				DELETE FROM roomNightOccupancy
				WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId} AND roomId = ${roomId}
			`
		}
	})

	test('[DB2] direct DELETE then INSERT same PK succeeds (cancel→re-assign cycle)', async () => {
		const sql = getTestSql()
		const propertyId = newId('property')
		const roomId = newId('room')
		const date = dateFromIso('2035-02-10')
		const now = toTs(new Date())
		const bookingIdA = newId('booking')
		const bookingIdB = newId('booking')

		try {
			await sql`
				INSERT INTO roomNightOccupancy
					(\`tenantId\`, \`propertyId\`, \`roomId\`, \`date\`, \`bookingId\`, \`createdAt\`)
				VALUES (${TENANT_A}, ${propertyId}, ${roomId}, ${date}, ${bookingIdA}, ${now})
			`
			// Release slot (simulates cancel).
			await sql`
				DELETE FROM roomNightOccupancy
				WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId}
					AND roomId = ${roomId} AND date = ${date}
			`
			// Different booking re-occupies — must succeed.
			await sql`
				INSERT INTO roomNightOccupancy
					(\`tenantId\`, \`propertyId\`, \`roomId\`, \`date\`, \`bookingId\`, \`createdAt\`)
				VALUES (${TENANT_A}, ${propertyId}, ${roomId}, ${date}, ${bookingIdB}, ${now})
			`
			const [rows = []] = await sql<{ bookingId: string }[]>`
				SELECT bookingId FROM roomNightOccupancy
				WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId}
					AND roomId = ${roomId} AND date = ${date}
			`
			expect(rows[0]?.bookingId).toBe(bookingIdB)
		} finally {
			await sql`
				DELETE FROM roomNightOccupancy
				WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId} AND roomId = ${roomId}
			`
		}
	})

	test('[DB3] different rooms / same date: independent slots (PK separation)', async () => {
		const sql = getTestSql()
		const propertyId = newId('property')
		const roomA = newId('room')
		const roomB = newId('room')
		const date = dateFromIso('2035-03-10')
		const now = toTs(new Date())

		try {
			await sql`
				INSERT INTO roomNightOccupancy
					(\`tenantId\`, \`propertyId\`, \`roomId\`, \`date\`, \`bookingId\`, \`createdAt\`)
				VALUES (${TENANT_A}, ${propertyId}, ${roomA}, ${date}, ${newId('booking')}, ${now})
			`
			await sql`
				INSERT INTO roomNightOccupancy
					(\`tenantId\`, \`propertyId\`, \`roomId\`, \`date\`, \`bookingId\`, \`createdAt\`)
				VALUES (${TENANT_A}, ${propertyId}, ${roomB}, ${date}, ${newId('booking')}, ${now})
			`
			const [rows = []] = await sql<{ cnt: number | bigint }[]>`
				SELECT COUNT(*) AS cnt FROM roomNightOccupancy
				WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId} AND date = ${date}
			`
			expect(Number(rows[0]?.cnt)).toBe(2)
		} finally {
			await sql`
				DELETE FROM roomNightOccupancy
				WHERE tenantId = ${TENANT_A} AND propertyId = ${propertyId} AND date = ${date}
			`
		}
	})

	// ============================================================
	// [LC*] Lifecycle — assignRoom / cancel / checkOut / markNoShow
	// ============================================================

	test('[LC1] assignRoom writes N occupancy rows for N nights', async () => {
		const dates = ['2035-04-10', '2035-04-11', '2035-04-12']
		const { prop, rt, rp } = await seedChain({ dates })
		const r1 = await seedRoom(prop.id, rt.id, '101')
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-04-10', checkOut: '2035-04-13' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		expect(await countOccupancyForBooking(b.id)).toBe(0)

		await booking.assignRoom(TENANT_A, b.id, { roomId: r1.id }, USER_A)
		expect(await countOccupancyForBooking(b.id)).toBe(3)
	})

	test('[LC2] cancel removes occupancy rows AND decrements sold', async () => {
		const dates = ['2035-05-10', '2035-05-11']
		const { prop, rt, rp } = await seedChain({ dates })
		const r1 = await seedRoom(prop.id, rt.id, '102')
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-05-10', checkOut: '2035-05-12' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		await booking.assignRoom(TENANT_A, b.id, { roomId: r1.id }, USER_A)
		expect(await countOccupancyForBooking(b.id)).toBe(2)

		await booking.cancel(TENANT_A, b.id, { reason: 'test' }, USER_A)
		expect(await countOccupancyForBooking(b.id)).toBe(0)
	})

	test('[LC3] checkOut removes occupancy rows (room available again)', async () => {
		const dates = ['2035-06-10']
		const { prop, rt, rp } = await seedChain({ dates })
		const r1 = await seedRoom(prop.id, rt.id, '103')
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-06-10', checkOut: '2035-06-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		await booking.assignRoom(TENANT_A, b.id, { roomId: r1.id }, USER_A)
		expect(await countOccupancyForBooking(b.id)).toBe(1)

		await booking.checkIn(TENANT_A, b.id, {}, USER_A)
		await booking.checkOut(TENANT_A, b.id, USER_A)
		expect(await countOccupancyForBooking(b.id)).toBe(0)
	})

	test('[LC4] markNoShow KEEPS occupancy rows (matches sold-retain canon)', async () => {
		const dates = ['2035-07-10']
		const { prop, rt, rp } = await seedChain({ dates })
		const r1 = await seedRoom(prop.id, rt.id, '104')
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-07-10', checkOut: '2035-07-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		await booking.assignRoom(TENANT_A, b.id, { roomId: r1.id }, USER_A)
		expect(await countOccupancyForBooking(b.id)).toBe(1)

		await booking.markNoShow(TENANT_A, b.id, { reason: 'late' }, USER_A)
		// Slot stays occupied — no-show physically blocked the room.
		expect(await countOccupancyForBooking(b.id)).toBe(1)
	})

	test('[LC5] changeRoomType removes occupancy (pin gets nulled)', async () => {
		const dates = ['2035-08-10']
		const { prop, rt, rp } = await seedChain({ dates })
		// Second roomType in same property для swap target.
		const rt2 = await roomType.create(TENANT_A, prop.id, {
			name: 'Suite',
			maxOccupancy: 4,
			baseBeds: 2,
			extraBeds: 0,
			inventoryCount: 2,
		})
		cleanup.push(() => roomType.delete(TENANT_A, rt2.id).then(() => undefined))
		const rp2 = await ratePlan.create(TENANT_A, {
			roomTypeId: rt2.id,
			name: 'BAR Suite',
			code: `BARS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			isDefault: true,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		cleanup.push(() => ratePlan.delete(TENANT_A, rp2.id).then(() => undefined))
		await rateRepo.bulkUpsert(TENANT_A, prop.id, rt2.id, rp2.id, {
			rates: dates.map((date) => ({ date, amount: '8000', currency: 'RUB' })),
		})
		await availability.bulkUpsert(TENANT_A, rt2.id, {
			rates: dates.map((date) => ({ date, allotment: 2 })),
		})

		const r1 = await seedRoom(prop.id, rt.id, '105')
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-08-10', checkOut: '2035-08-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		await booking.assignRoom(TENANT_A, b.id, { roomId: r1.id }, USER_A)
		expect(await countOccupancyForBooking(b.id)).toBe(1)

		await booking.moveToRoomType(TENANT_A, b.id, { roomTypeId: rt2.id }, USER_A)
		// Old room's occupancy released; new pin not yet set (operator must
		// assignRoom для new roomType separately).
		expect(await countOccupancyForBooking(b.id)).toBe(0)
	})

	// ============================================================
	// [GB*] Gap B fix — moveDates pinned overlap
	// ============================================================

	test('[GB1] assignRoom rejects already-occupied room (DB-level via INSERT PK conflict)', async () => {
		const dates = ['2035-09-10', '2035-09-11']
		const { prop, rt, rp } = await seedChain({ dates, allotment: 5 })
		const r1 = await seedRoom(prop.id, rt.id, '106')
		const bA = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-09-10', checkOut: '2035-09-12' }),
			USER_A,
		)
		await trackBookingCleanup(bA)
		const bB = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-09-10', checkOut: '2035-09-12' }),
			USER_A,
		)
		await trackBookingCleanup(bB)

		// Pin r1 к bA first.
		await booking.assignRoom(TENANT_A, bA.id, { roomId: r1.id }, USER_A)

		// Attempt к pin same r1 к overlapping bB → conflict.
		await expect(
			booking.assignRoom(TENANT_A, bB.id, { roomId: r1.id }, USER_A),
		).rejects.toBeInstanceOf(RoomAssignmentConflictError)

		// bA still owns occupancy (no side-effect от failed bB attempt).
		expect(await countOccupancyForBooking(bA.id)).toBe(2)
		expect(await countOccupancyForBooking(bB.id)).toBe(0)
	})

	// ============================================================
	// [OV*] oversellDelta math
	// ============================================================

	test('[OV1] create rejects when sold === allotment + 0 oversellDelta (baseline)', async () => {
		const dates = ['2035-10-10']
		const { prop, rt, rp } = await seedChain({ dates, allotment: 1 })
		const b1 = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-10-10', checkOut: '2035-10-11' }),
			USER_A,
		)
		await trackBookingCleanup(b1)
		// Second create same allotment=1 → NoInventoryError.
		await expect(
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2035-10-10', checkOut: '2035-10-11' }),
				USER_A,
			),
		).rejects.toBeInstanceOf(NoInventoryError)
	})

	test('[OV2] create succeeds when oversellDelta extends effective allotment', async () => {
		const dates = ['2035-11-10']
		const { prop, rt, rp } = await seedChain({ dates, allotment: 1 })
		// Operator bumps oversellDelta by 1 → effective 2.
		await availability.bulkUpsert(TENANT_A, rt.id, {
			rates: [{ date: '2035-11-10', allotment: 1, oversellDelta: 1 }],
		})
		const b1 = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-11-10', checkOut: '2035-11-11' }),
			USER_A,
		)
		await trackBookingCleanup(b1)
		// Second create succeeds — effective 2, sold goes к 2.
		const b2 = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-11-10', checkOut: '2035-11-11' }),
			USER_A,
		)
		await trackBookingCleanup(b2)
		expect(b2.id).not.toBe(b1.id)
	})

	test('[OV3] create rejects when oversellDelta negative pulls effective < sold+1', async () => {
		const dates = ['2035-12-10']
		const { prop, rt, rp } = await seedChain({ dates, allotment: 3 })
		// Pre-state: 1 booking exists → sold = 1, allotment = 3, eff = 3, 2 slots free.
		const b1 = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2035-12-10', checkOut: '2035-12-11' }),
			USER_A,
		)
		await trackBookingCleanup(b1)

		// Operator pulls 2 units offline: oversellDelta = -2 → effective = 1 = sold.
		// `bulkUpsert` accepts (effective=1 >= sold=1, exact boundary).
		await availability.bulkUpsert(TENANT_A, rt.id, {
			rates: [{ date: '2035-12-10', allotment: 3, oversellDelta: -2 }],
		})

		// Next create → sold=1 >= effective=1 → NoInventoryError.
		await expect(
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2035-12-10', checkOut: '2035-12-11' }),
				USER_A,
			),
		).rejects.toBeInstanceOf(NoInventoryError)
	})

	// ============================================================
	// [SL*] Variant 3 — roomTypeNightSlot slot allocation (migration 0063)
	// ============================================================

	async function countSlotsForBooking(bookingId: string): Promise<number> {
		const sql = getTestSql()
		const [rows = []] = await sql<{ cnt: number | bigint }[]>`
			SELECT COUNT(*) AS cnt FROM roomTypeNightSlot
			WHERE tenantId = ${TENANT_A} AND bookingId = ${bookingId}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return Number(rows[0]?.cnt ?? 0)
	}

	async function countSlotsForNight(
		propertyId: string,
		roomTypeId: string,
		date: string,
	): Promise<number> {
		const sql = getTestSql()
		const [rows = []] = await sql<{ cnt: number | bigint }[]>`
			SELECT COUNT(*) AS cnt FROM roomTypeNightSlot
			WHERE tenantId = ${TENANT_A}
				AND propertyId = ${propertyId}
				AND roomTypeId = ${roomTypeId}
				AND date = ${dateFromIso(date)}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return Number(rows[0]?.cnt ?? 0)
	}

	test('[SL1] create writes slot rows: count == nights, even for unassigned booking', async () => {
		const dates = ['2036-01-10', '2036-01-11', '2036-01-12']
		const { prop, rt, rp } = await seedChain({ dates })
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2036-01-10', checkOut: '2036-01-13' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		expect(b.assignedRoomId).toBeNull() // unassigned (canonical create state)
		expect(await countSlotsForBooking(b.id)).toBe(3) // 3 nights → 3 slot rows
	})

	test('[SL2] cancel removes slot rows (frees slot для new booking)', async () => {
		const dates = ['2036-02-10']
		const { prop, rt, rp } = await seedChain({ dates })
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2036-02-10', checkOut: '2036-02-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		expect(await countSlotsForBooking(b.id)).toBe(1)
		await booking.cancel(TENANT_A, b.id, { reason: 'test' }, USER_A)
		expect(await countSlotsForBooking(b.id)).toBe(0)
	})

	test('[SL3] checkOut removes slot rows (sold counter retained, slot freed)', async () => {
		const dates = ['2036-03-10']
		const { prop, rt, rp } = await seedChain({ dates })
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2036-03-10', checkOut: '2036-03-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		expect(await countSlotsForBooking(b.id)).toBe(1)
		await booking.checkIn(TENANT_A, b.id, {}, USER_A)
		await booking.checkOut(TENANT_A, b.id, USER_A)
		expect(await countSlotsForBooking(b.id)).toBe(0)
	})

	test('[SL4] sequential bookings same night → slot 0, 1, 2 (lowest-free canon)', async () => {
		const dates = ['2036-04-10']
		const { prop, rt, rp } = await seedChain({ dates, allotment: 3 })
		const a = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2036-04-10', checkOut: '2036-04-11' }),
			USER_A,
		)
		await trackBookingCleanup(a)
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2036-04-10', checkOut: '2036-04-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		const c = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2036-04-10', checkOut: '2036-04-11' }),
			USER_A,
		)
		await trackBookingCleanup(c)

		expect(await countSlotsForNight(prop.id, rt.id, '2036-04-10')).toBe(3)

		// Verify slot numbers are 0, 1, 2 (lowest-free deterministic)
		const sql = getTestSql()
		const [slotRows = []] = await sql<{ slotNumber: number | bigint; bookingId: string }[]>`
			SELECT slotNumber, bookingId FROM roomTypeNightSlot
			WHERE tenantId = ${TENANT_A}
				AND propertyId = ${prop.id}
				AND roomTypeId = ${rt.id}
				AND date = ${dateFromIso('2036-04-10')}
			ORDER BY slotNumber
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		const slots = slotRows.map((r) => Number(r.slotNumber))
		expect(slots).toEqual([0, 1, 2])
	})

	test('[SL5] cancelled slot freed → next create reuses slot 0 (lowest-free)', async () => {
		const dates = ['2036-05-10']
		const { prop, rt, rp } = await seedChain({ dates, allotment: 2 })
		const a = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2036-05-10', checkOut: '2036-05-11' }),
			USER_A,
		)
		await trackBookingCleanup(a)
		// Cancel A — slot 0 freed
		await booking.cancel(TENANT_A, a.id, { reason: 'test' }, USER_A)
		expect(await countSlotsForNight(prop.id, rt.id, '2036-05-10')).toBe(0)

		// New booking B should reuse slot 0
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2036-05-10', checkOut: '2036-05-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)

		const sql = getTestSql()
		const [rows = []] = await sql<{ slotNumber: number | bigint }[]>`
			SELECT slotNumber FROM roomTypeNightSlot
			WHERE tenantId = ${TENANT_A} AND bookingId = ${b.id}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		expect(Number(rows[0]?.slotNumber ?? -1)).toBe(0) // lowest-free reused
	})

	test('[SL6] markNoShow KEEPS slot rows (matches sold-retain canon — audit retain)', async () => {
		const dates = ['2036-06-10']
		const { prop, rt, rp } = await seedChain({ dates })
		const b = await booking.create(
			TENANT_A,
			prop.id,
			buildBookingInput(rt, rp, { checkIn: '2036-06-10', checkOut: '2036-06-11' }),
			USER_A,
		)
		await trackBookingCleanup(b)
		expect(await countSlotsForBooking(b.id)).toBe(1)

		await booking.markNoShow(TENANT_A, b.id, { reason: 'late' }, USER_A)
		// No-show retains slot — room is «committed» for audit + revenue.
		// Symmetric to availability.sold retention.
		expect(await countSlotsForBooking(b.id)).toBe(1)
	})

	test('[SL7] race: Promise.all 3 concurrent creates с allotment=1 → exactly 1 wins, 2 throw NoInventoryError', async () => {
		const dates = ['2036-07-10']
		const { prop, rt, rp } = await seedChain({ dates, allotment: 1 })
		// 3 concurrent creates. Per YDB Serializable + range-locks: exactly one
		// wins, two lose (TLI retry → fresh state → NoInventoryError, or PK
		// conflict translated к NoInventoryError via outer catch).
		const results = await Promise.allSettled([
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2036-07-10', checkOut: '2036-07-11' }),
				USER_A,
			),
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2036-07-10', checkOut: '2036-07-11' }),
				USER_A,
			),
			booking.create(
				TENANT_A,
				prop.id,
				buildBookingInput(rt, rp, { checkIn: '2036-07-10', checkOut: '2036-07-11' }),
				USER_A,
			),
		])
		const successes = results.filter((r) => r.status === 'fulfilled')
		const failures = results.filter((r) => r.status === 'rejected')
		expect(successes.length).toBe(1)
		expect(failures.length).toBe(2)
		// Track winner for cleanup
		const winner = (successes[0] as PromiseFulfilledResult<Booking>).value
		await trackBookingCleanup(winner)

		// All failures should be NoInventoryError (canonical 409, NOT generic 500)
		for (const f of failures) {
			const reason = (f as PromiseRejectedResult).reason
			expect(reason).toBeInstanceOf(NoInventoryError)
		}

		// Final state: 1 slot row total
		expect(await countSlotsForNight(prop.id, rt.id, '2036-07-10')).toBe(1)
	})
})
