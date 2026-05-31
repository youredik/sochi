/**
 * Property-block service — G9 integration tests (real YDB).
 *
 * Covers:
 *   [PB1] create single — happy path persist + list
 *   [PB2] create multi-room — all succeed clean
 *   [PB3] overlap-existing-block — second create → skipped (silent)
 *   [PB4] block-over-active-booking — hard-rejected (PropertyBlockBookingConflictError)
 *   [PB5] update past-immutable shrink — throws
 *   [PB6] update future-extension — OK
 *   [PB7] cross-tenant isolation
 *   [PB8] delete removes
 *   [PB9] wrong-property room → skipped
 *   [PB10] inactive room → skipped
 *   [PB11] partial-success: some rooms ok, some skipped (one inactive)
 *   [PB12] adjacent dates do NOT overlap (block.endDate = req.startDate)
 *   [PB13] update introduces booking overlap → throws
 *
 * Per `[[backend-recon-end-to-end]]` and `[[strict-tests]]` canons.
 */
import type { Booking, Property, PropertyBlock, RatePlan, Room, RoomType } from '@horeca/shared'
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { dateFromIso } from '../../db/ydb-helpers.ts'
import {
	PropertyBlockBlockOverlapError,
	PropertyBlockBookingConflictError,
	PropertyBlockPastImmutableError,
} from '../../errors/domain.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createAvailabilityFactory } from '../availability/availability.factory.ts'
import { createPropertyFactory } from '../property/property.factory.ts'
import { createRateFactory } from '../rate/rate.factory.ts'
import { createRatePlanFactory } from '../ratePlan/ratePlan.factory.ts'
import { createRoomFactory } from '../room/room.factory.ts'
import { createRoomTypeFactory } from '../roomType/roomType.factory.ts'
import { createBookingFactory } from '../booking/booking.factory.ts'
import { createPropertyBlockFactory } from './property-block.factory.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const USER_A = newId('user')

describe('property-block.service G9 (integration)', () => {
	let block: ReturnType<typeof createPropertyBlockFactory>['service']
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
		const blockFactory = createPropertyBlockFactory(
			sql,
			bookingFactory.repo,
			propertyFactory.service,
			roomFactory.service,
		)
		block = blockFactory.service
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

	type SeedResult = {
		prop: Property
		rt: RoomType
		rp: RatePlan
		rooms: Room[]
	}

	async function seedScenario(opts: {
		tenantId: string
		dates: string[]
		roomsCount?: number
	}): Promise<SeedResult> {
		const roomsCount = opts.roomsCount ?? 3
		const prop = await property.create(opts.tenantId, {
			name: `PB-${Math.random()}`,
			address: 'ул. Тест',
			city: 'Sochi',
			tourismTaxRateBps: 200,
		})
		cleanup.push(() => property.delete(opts.tenantId, prop.id).then(() => undefined))
		const rt = await roomType.create(opts.tenantId, prop.id, {
			name: 'Standard',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: roomsCount,
		})
		cleanup.push(() => roomType.delete(opts.tenantId, rt.id).then(() => undefined))
		const rp = await ratePlan.create(opts.tenantId, {
			roomTypeId: rt.id,
			name: 'BAR Flex',
			code: `BAR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
		cleanup.push(() => ratePlan.delete(opts.tenantId, rp.id).then(() => undefined))
		await rateRepo.bulkUpsert(opts.tenantId, prop.id, rt.id, rp.id, {
			rates: opts.dates.map((date) => ({ date, amount: '5000', currency: 'RUB' })),
		})
		await availability.bulkUpsert(opts.tenantId, rt.id, {
			rates: opts.dates.map((date) => ({ date, allotment: roomsCount })),
		})

		const rooms: Room[] = []
		for (let i = 0; i < roomsCount; i++) {
			const r = await room.create(opts.tenantId, {
				roomTypeId: rt.id,
				number: `${100 + i}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
			})
			rooms.push(r)
			cleanup.push(() => room.delete(opts.tenantId, r.id).then(() => undefined))
		}
		return { prop, rt, rp, rooms }
	}

	async function trackBlockCleanup(b: PropertyBlock) {
		cleanup.push(async () => {
			const sql = getTestSql()
			try {
				await sql`
					DELETE FROM propertyBlock
					WHERE tenantId = ${b.tenantId}
						AND propertyId = ${b.propertyId}
						AND startDate = ${dateFromIso(b.startDate)}
						AND id = ${b.id}
				`
			} catch {
				// best-effort
			}
		})
	}

	async function trackBookingCleanup(b: Booking) {
		cleanup.push(async () => {
			const sql = getTestSql()
			try {
				await sql`
					DELETE FROM booking
					WHERE tenantId = ${b.tenantId}
						AND propertyId = ${b.propertyId}
						AND checkIn = ${dateFromIso(b.checkIn)}
						AND id = ${b.id}
				`
			} catch {
				// best-effort
			}
		})
	}

	// ============================================================
	// [PB1] create single — happy path
	// ============================================================
	test('[PB1] create single block — happy path persist + list', async () => {
		const dates = ['2032-04-10', '2032-04-11', '2032-04-12']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')

		const res = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-04-10',
				endDate: '2032-04-12',
				reason: 'repair',
				comment: 'Замена сантехники',
			},
			{ actorUserId: USER_A },
		)
		expect(res.created).toHaveLength(1)
		expect(res.skipped).toHaveLength(0)
		const b = res.created[0]
		if (!b) throw new Error('expected created block')
		expect(b.roomId).toBe(room0.id)
		expect(b.reason).toBe('repair')
		expect(b.comment).toBe('Замена сантехники')
		expect(b.createdBy).toBe(USER_A)
		await trackBlockCleanup(b)

		const list = await block.listByPropertyWindow(TENANT_A, prop.id, '2032-04-01', '2032-04-30')
		expect(list).toHaveLength(1)
		const got = list[0]
		if (!got) throw new Error('expected list item')
		expect(got.id).toBe(b.id)
	})

	// ============================================================
	// [PB2] create multi-room batch — all succeed
	// ============================================================
	test('[PB2] create multi-room — all succeed clean', async () => {
		const dates = ['2032-04-15', '2032-04-16']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const res = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: rooms.map((r) => r.id),
				startDate: '2032-04-15',
				endDate: '2032-04-17',
				reason: 'deep_clean',
			},
			{ actorUserId: USER_A },
		)
		expect(res.created).toHaveLength(rooms.length)
		expect(res.skipped).toHaveLength(0)
		for (const b of res.created) await trackBlockCleanup(b)
	})

	// ============================================================
	// [PB3] overlap-existing-block → skipped
	// ============================================================
	test('[PB3] overlap-existing-block → second create skipped (silent)', async () => {
		const dates = ['2032-04-20', '2032-04-21']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')

		const first = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-04-20',
				endDate: '2032-04-22',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		for (const b of first.created) await trackBlockCleanup(b)
		expect(first.created).toHaveLength(1)

		const second = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-04-21',
				endDate: '2032-04-23',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		expect(second.created).toHaveLength(0)
		expect(second.skipped).toHaveLength(1)
		const sk = second.skipped[0]
		if (!sk) throw new Error('expected skip')
		expect(sk.reason).toBe('overlap_block')
		expect(sk.roomId).toBe(room0.id)
	})

	// ============================================================
	// [PB4] block-over-active-booking — hard-rejected
	// ============================================================
	test('[PB4] block-over-active-booking → PropertyBlockBookingConflictError (hard-fail-all)', async () => {
		const dates = ['2032-05-01', '2032-05-02', '2032-05-03']
		const { prop, rt, rp, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		const room1 = rooms[1]
		if (!room0 || !room1) throw new Error('seed failed')

		const b = await booking.create(
			TENANT_A,
			prop.id,
			{
				roomTypeId: rt.id,
				ratePlanId: rp.id,
				checkIn: '2032-05-01',
				checkOut: '2032-05-03',
				guestsCount: 1,
				primaryGuestId: newId('guest'),
				guestSnapshot: {
					firstName: 'X',
					lastName: 'Y',
					citizenship: 'RU',
					documentType: 'passport',
					documentNumber: 'XX000000',
				},
				channelCode: 'direct' as const,
			},
			USER_A,
		)
		await trackBookingCleanup(b)
		await booking.assignRoom(TENANT_A, b.id, { roomId: room0.id }, USER_A)

		// Try to block room0 AND room1 — should hard-fail because room0 is occupied.
		await expect(
			block.createBlocks(
				TENANT_A,
				prop.id,
				{
					roomIds: [room0.id, room1.id],
					startDate: '2032-05-01',
					endDate: '2032-05-03',
					reason: 'repair',
				},
				{ actorUserId: USER_A },
			),
		).rejects.toThrow(PropertyBlockBookingConflictError)

		// Neither block was created (all-or-nothing semantics for booking conflict).
		const list = await block.listByPropertyWindow(TENANT_A, prop.id, '2032-05-01', '2032-05-04')
		expect(list).toHaveLength(0)
	})

	// ============================================================
	// [PB5] update past-immutable shrink → throws
	// ============================================================
	test('[PB5] update endDate earlier than today → PropertyBlockPastImmutableError', async () => {
		const dates = ['2032-05-10', '2032-05-11', '2032-05-12']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')
		const res = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-05-10',
				endDate: '2032-05-12',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		const b = res.created[0]
		if (!b) throw new Error('expected created')
		await trackBlockCleanup(b)

		// Attempt to shrink endDate к far past
		await expect(block.update(TENANT_A, b.id, { endDate: '2020-01-01' })).rejects.toThrow(
			PropertyBlockPastImmutableError,
		)
	})

	// ============================================================
	// [PB6] update future-extension OK
	// ============================================================
	test('[PB6] update future-extension OK', async () => {
		const dates = ['2032-06-01', '2032-06-02']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')
		const res = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-06-01',
				endDate: '2032-06-02',
				reason: 'deep_clean',
			},
			{ actorUserId: USER_A },
		)
		const b = res.created[0]
		if (!b) throw new Error('expected created')
		await trackBlockCleanup(b)

		const updated = await block.update(TENANT_A, b.id, { endDate: '2032-06-05' })
		expect(updated.endDate).toBe('2032-06-05')
		expect(updated.id).toBe(b.id)
	})

	// ============================================================
	// [PB7] cross-tenant isolation
	// ============================================================
	test('[PB7] cross-tenant: TENANT_B cannot see TENANT_A blocks', async () => {
		const dates = ['2032-07-01']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')
		const res = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-07-01',
				endDate: '2032-07-02',
				reason: 'personal_use',
			},
			{ actorUserId: USER_A },
		)
		const b = res.created[0]
		if (!b) throw new Error('expected created')
		await trackBlockCleanup(b)

		const fromB = await block.listByPropertyWindow(TENANT_B, prop.id, '2032-07-01', '2032-07-10')
		expect(fromB).toHaveLength(0)
		const byIdFromB = await block.getById(TENANT_B, b.id)
		expect(byIdFromB).toBeNull()
	})

	// ============================================================
	// [PB8] delete removes
	// ============================================================
	test('[PB8] delete removes — listByPropertyWindow returns []', async () => {
		const dates = ['2032-08-01']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')
		const res = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-08-01',
				endDate: '2032-08-02',
				reason: 'hold_other',
			},
			{ actorUserId: USER_A },
		)
		const b = res.created[0]
		if (!b) throw new Error('expected created')

		const deleted = await block.delete(TENANT_A, b.id)
		expect(deleted).toBe(true)
		const list = await block.listByPropertyWindow(TENANT_A, prop.id, '2032-08-01', '2032-08-10')
		expect(list).toHaveLength(0)
		// Idempotent re-delete returns false
		const again = await block.delete(TENANT_A, b.id)
		expect(again).toBe(false)
	})

	// ============================================================
	// [PB9] wrong-property room → skipped
	// ============================================================
	test('[PB9] room belongs к different property → skipped wrong_property', async () => {
		const datesA = ['2032-09-01']
		const datesB = ['2032-09-01']
		const seedA = await seedScenario({ tenantId: TENANT_A, dates: datesA, roomsCount: 1 })
		const seedB = await seedScenario({ tenantId: TENANT_A, dates: datesB, roomsCount: 1 })
		const wrongRoom = seedB.rooms[0]
		if (!wrongRoom) throw new Error('seed failed')

		const res = await block.createBlocks(
			TENANT_A,
			seedA.prop.id,
			{
				roomIds: [wrongRoom.id],
				startDate: '2032-09-01',
				endDate: '2032-09-02',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		expect(res.created).toHaveLength(0)
		expect(res.skipped).toHaveLength(1)
		const sk = res.skipped[0]
		if (!sk) throw new Error('expected skip')
		expect(sk.reason).toBe('wrong_property')
	})

	// ============================================================
	// [PB10] inactive room → skipped
	// ============================================================
	test('[PB10] inactive room → skipped room_inactive', async () => {
		const dates = ['2032-10-01']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')
		await room.update(TENANT_A, room0.id, { isActive: false })

		const res = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-10-01',
				endDate: '2032-10-02',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		expect(res.created).toHaveLength(0)
		expect(res.skipped).toHaveLength(1)
		const sk = res.skipped[0]
		if (!sk) throw new Error('expected skip')
		expect(sk.reason).toBe('room_inactive')
	})

	// ============================================================
	// [PB11] partial-success: some ok, some skipped (one inactive)
	// ============================================================
	test('[PB11] partial success: ok + skipped same call', async () => {
		const dates = ['2032-11-01']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates, roomsCount: 2 })
		const room0 = rooms[0]
		const room1 = rooms[1]
		if (!room0 || !room1) throw new Error('seed failed')
		await room.update(TENANT_A, room1.id, { isActive: false })

		const res = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id, room1.id],
				startDate: '2032-11-01',
				endDate: '2032-11-02',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		expect(res.created).toHaveLength(1)
		expect(res.skipped).toHaveLength(1)
		const c0 = res.created[0]
		const s0 = res.skipped[0]
		if (!c0 || !s0) throw new Error('expected one + one')
		expect(c0.roomId).toBe(room0.id)
		expect(s0.roomId).toBe(room1.id)
		expect(s0.reason).toBe('room_inactive')
		await trackBlockCleanup(c0)
	})

	// ============================================================
	// [PB12] adjacent dates do NOT overlap (canon: endDate exclusive)
	// ============================================================
	test('[PB12] adjacent blocks (B1.endDate = B2.startDate) do NOT overlap', async () => {
		const dates = ['2032-12-01']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')

		const r1 = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-12-01',
				endDate: '2032-12-03',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		const b1 = r1.created[0]
		if (!b1) throw new Error('first block create failed')
		await trackBlockCleanup(b1)

		const r2 = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2032-12-03',
				endDate: '2032-12-05',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		expect(r2.created).toHaveLength(1)
		expect(r2.skipped).toHaveLength(0)
		const b2 = r2.created[0]
		if (!b2) throw new Error('adjacent block expected к succeed')
		await trackBlockCleanup(b2)
	})

	// ============================================================
	// [PB13] update introduces booking overlap → throws
	// ============================================================
	test('[PB13] update extends block over future booking → PropertyBlockBookingConflictError', async () => {
		const dates = ['2033-01-01', '2033-01-02', '2033-01-03', '2033-01-04', '2033-01-05']
		const { prop, rt, rp, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')

		// Create a future booking on room0 covering 1/4-1/5
		const b = await booking.create(
			TENANT_A,
			prop.id,
			{
				roomTypeId: rt.id,
				ratePlanId: rp.id,
				checkIn: '2033-01-04',
				checkOut: '2033-01-05',
				guestsCount: 1,
				primaryGuestId: newId('guest'),
				guestSnapshot: {
					firstName: 'X',
					lastName: 'Y',
					citizenship: 'RU',
					documentType: 'passport',
					documentNumber: 'XX000000',
				},
				channelCode: 'direct' as const,
			},
			USER_A,
		)
		await trackBookingCleanup(b)
		await booking.assignRoom(TENANT_A, b.id, { roomId: room0.id }, USER_A)

		// Existing block 1/1-1/3 (no conflict)
		const r = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2033-01-01',
				endDate: '2033-01-03',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		const blk = r.created[0]
		if (!blk) throw new Error('expected created')
		await trackBlockCleanup(blk)

		// Try to extend к 1/6 — now overlaps booking 1/4-1/5
		await expect(block.update(TENANT_A, blk.id, { endDate: '2033-01-06' })).rejects.toThrow(
			PropertyBlockBookingConflictError,
		)
	})

	// ============================================================
	// [PB14] update extends block across ANOTHER active block → throws
	// (adversarial 9-item caught — previously only booking overlap checked)
	// ============================================================
	test('[PB14] update extends across another block (same room) → PropertyBlockBlockOverlapError', async () => {
		const dates = ['2033-02-01', '2033-02-02', '2033-02-03', '2033-02-04', '2033-02-05']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates })
		const room0 = rooms[0]
		if (!room0) throw new Error('seed failed')

		// Block A: 2/1-2/2
		const rA = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2033-02-01',
				endDate: '2033-02-02',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		const blkA = rA.created[0]
		if (!blkA) throw new Error('blkA create failed')
		await trackBlockCleanup(blkA)

		// Block B: 2/4-2/5
		const rB = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [room0.id],
				startDate: '2033-02-04',
				endDate: '2033-02-05',
				reason: 'deep_clean',
			},
			{ actorUserId: USER_A },
		)
		const blkB = rB.created[0]
		if (!blkB) throw new Error('blkB create failed')
		await trackBlockCleanup(blkB)

		// Extend A's endDate к 2/5 — now overlaps Block B
		await expect(block.update(TENANT_A, blkA.id, { endDate: '2033-02-05' })).rejects.toThrow(
			PropertyBlockBlockOverlapError,
		)
		// Self-overlap (extending к own dates) MUST be allowed (excludeBlockId=self)
		const same = await block.update(TENANT_A, blkA.id, { endDate: '2033-02-02' })
		expect(same.endDate).toBe('2033-02-02')
	})

	// ============================================================
	// [PB15] listBlockedRoomIdsInWindow — distinct + tenant-scoped
	// ============================================================
	test('[PB15] listBlockedRoomIdsInWindow returns distinct active blocked rooms in window', async () => {
		const dates = ['2033-03-01', '2033-03-02', '2033-03-03']
		const { prop, rooms } = await seedScenario({ tenantId: TENANT_A, dates, roomsCount: 3 })
		const [r0, r1, r2] = rooms
		if (!r0 || !r1 || !r2) throw new Error('seed failed')

		// Block r0 + r1 (two distinct rooms in window)
		const res = await block.createBlocks(
			TENANT_A,
			prop.id,
			{
				roomIds: [r0.id, r1.id],
				startDate: '2033-03-01',
				endDate: '2033-03-03',
				reason: 'repair',
			},
			{ actorUserId: USER_A },
		)
		for (const b of res.created) await trackBlockCleanup(b)
		expect(res.created).toHaveLength(2)

		// Direct repo call — listBlockedRoomIdsInWindow (path covered by
		// availability endpoint, now also explicit).
		const sql = getTestSql()
		const repo = (await import('./property-block.repo.ts')).createPropertyBlockRepo(sql)
		const blockedIds = await repo.listBlockedRoomIdsInWindow(
			TENANT_A,
			prop.id,
			'2033-03-01',
			'2033-03-03',
		)
		expect(new Set(blockedIds)).toEqual(new Set([r0.id, r1.id]))
		// r2 is NOT blocked
		expect(blockedIds).not.toContain(r2.id)

		// Cross-tenant: TENANT_B sees nothing
		const fromB = await repo.listBlockedRoomIdsInWindow(
			TENANT_B,
			prop.id,
			'2033-03-01',
			'2033-03-03',
		)
		expect(fromB).toEqual([])
	})
})
