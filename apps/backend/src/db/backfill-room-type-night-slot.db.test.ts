/**
 * Backfill для `roomTypeNightSlot` — YDB integration tests (Variant 3 strongest).
 *
 * Invariants:
 *   [BS1] Active booking (confirmed/in_house) → N slot rows after run, slot 0..N-1
 *   [BS2] Cancelled/checked_out/no_show booking → skipped (no slot writes)
 *   [BS3] Idempotent re-run: counters first=created, second=alreadyDone; state identical
 *   [BS4] Overbook detection: more bookings than allotment → exhaustedSlots > 0,
 *         conflict report includes loser bookingId
 *   [BS5] --dry-run does NOT write
 *   [BS6] --tenant scope isolates writes
 */

import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test'

jest.setTimeout(60_000)

import { runBackfill } from './backfill-room-type-night-slot.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { dateFromIso, NULL_INT32, NULL_TEXT, NULL_TIMESTAMP, toJson, toTs } from './ydb-helpers.ts'

const CONN_STR = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'

describe('backfill-room-type-night-slot', () => {
	const seededBookings: Array<{
		tenantId: string
		propertyId: string
		checkIn: string
		id: string
	}> = []

	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const b of seededBookings) {
			await sql`
				DELETE FROM roomTypeNightSlot ON
				SELECT tenantId, propertyId, roomTypeId, date, slotNumber
				FROM roomTypeNightSlot VIEW idxSlotByBooking
				WHERE tenantId = ${b.tenantId} AND bookingId = ${b.id}
			`
			await sql`
				DELETE FROM booking
				WHERE tenantId = ${b.tenantId}
					AND propertyId = ${b.propertyId}
					AND checkIn = ${dateFromIso(b.checkIn)}
					AND id = ${b.id}
			`
		}
		await teardownTestDb()
	})

	async function seedBooking(opts: {
		tenantId: string
		propertyId: string
		roomTypeId?: string
		checkIn: string
		nights?: number
		status?: 'confirmed' | 'in_house' | 'cancelled' | 'checked_out' | 'no_show'
	}): Promise<{ tenantId: string; propertyId: string; checkIn: string; id: string }> {
		const sql = getTestSql()
		const id = newId('booking')
		const nights = opts.nights ?? 1
		const status = opts.status ?? 'confirmed'
		const roomTypeId = opts.roomTypeId ?? newId('roomType')
		const checkOut = (() => {
			const d = new Date(`${opts.checkIn}T00:00:00Z`)
			d.setUTCDate(d.getUTCDate() + nights)
			return d.toISOString().slice(0, 10)
		})()
		const now = toTs(new Date())
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
				${opts.tenantId}, ${opts.propertyId}, ${dateFromIso(opts.checkIn)}, ${id},
				${dateFromIso(checkOut)}, ${roomTypeId}, ${newId('ratePlan')},
				${NULL_TEXT},
				${1}, ${nights},
				${newId('guest')}, ${toJson({ firstName: 'X', lastName: 'Y', citizenship: 'RU' })},
				${status}, ${now},
				${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${'direct'}, ${NULL_TEXT}, ${toJson(null)},
				${0n}, ${0n}, ${'RUB'}, ${toJson([])},
				${toJson(null)}, ${toJson(null)},
				${'not_required'}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
				${'not_checked'}, ${NULL_TIMESTAMP},
				${0n}, ${0n},
				${NULL_TEXT}, ${now}, ${now}, ${'system:test'}, ${'system:test'}
			)
		`
		const out = { tenantId: opts.tenantId, propertyId: opts.propertyId, checkIn: opts.checkIn, id }
		seededBookings.push(out)
		return out
	}

	async function seedAvailability(opts: {
		tenantId: string
		propertyId: string
		roomTypeId: string
		date: string
		allotment: number
	}) {
		const sql = getTestSql()
		const now = toTs(new Date())
		await sql`
			UPSERT INTO availability (
				\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`date\`,
				\`allotment\`, \`sold\`, \`oversellDelta\`, \`minStay\`, \`maxStay\`,
				\`closedToArrival\`, \`closedToDeparture\`, \`stopSell\`,
				\`createdAt\`, \`updatedAt\`
			) VALUES (
				${opts.tenantId}, ${opts.propertyId}, ${opts.roomTypeId}, ${dateFromIso(opts.date)},
				${opts.allotment}, ${0}, ${NULL_INT32}, ${NULL_INT32}, ${NULL_INT32},
				${false}, ${false}, ${false},
				${now}, ${now}
			)
		`
	}

	async function countSlotsForTenant(tenantId: string): Promise<number> {
		const sql = getTestSql()
		const [rows = []] = await sql<{ cnt: number | bigint }[]>`
			SELECT COUNT(*) AS cnt FROM roomTypeNightSlot WHERE tenantId = ${tenantId}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return Number(rows[0]?.cnt ?? 0)
	}

	test('[BS1+BS2] active bookings get slots, terminal-status bookings skipped', async () => {
		const TENANT = newId('organization')
		const PROPERTY = newId('property')
		const ROOMTYPE = newId('roomType')
		await seedAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			date: '2042-01-10',
			allotment: 5,
		})
		await seedAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			date: '2042-01-11',
			allotment: 5,
		})
		// Active: 2 nights → 2 slots expected
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-01-10',
			nights: 2,
			status: 'confirmed',
		})
		// Cancelled: skip
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-01-20',
			nights: 1,
			status: 'cancelled',
		})
		// Checked-out: skip
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-01-25',
			nights: 1,
			status: 'checked_out',
		})

		const result = await runBackfill(CONN_STR, { commit: true, tenantIds: [TENANT] })
		expect(result.counters.bookingsScanned).toBe(1)
		expect(result.counters.nightsCreated).toBe(2)
		expect(result.counters.phantomCollisions).toBe(0)
		expect(result.counters.exhaustedSlots).toBe(0)
		expect(await countSlotsForTenant(TENANT)).toBe(2)
	})

	test('[BS3] idempotent re-run: second invocation reports alreadyDone, state unchanged', async () => {
		const TENANT = newId('organization')
		const PROPERTY = newId('property')
		const ROOMTYPE = newId('roomType')
		await seedAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			date: '2042-02-10',
			allotment: 3,
		})
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-02-10',
			nights: 1,
			status: 'in_house',
		})

		const first = await runBackfill(CONN_STR, { commit: true, tenantIds: [TENANT] })
		expect(first.counters.nightsCreated).toBe(1)
		expect(first.counters.nightsAlreadyDone).toBe(0)

		const second = await runBackfill(CONN_STR, { commit: true, tenantIds: [TENANT] })
		expect(second.counters.nightsCreated).toBe(0)
		expect(second.counters.nightsAlreadyDone).toBe(1)
		expect(await countSlotsForTenant(TENANT)).toBe(1)
	})

	test('[BS4] overbook detection: more bookings than allotment → exhaustedSlots > 0', async () => {
		const TENANT = newId('organization')
		const PROPERTY = newId('property')
		const ROOMTYPE = newId('roomType')
		// allotment 1 — only ONE booking should fit per night
		await seedAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			date: '2042-03-10',
			allotment: 1,
		})
		// Seed 3 bookings same night — 1 fits, 2 are real overbook
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-03-10',
			nights: 1,
			status: 'confirmed',
		})
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-03-10',
			nights: 1,
			status: 'confirmed',
		})
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-03-10',
			nights: 1,
			status: 'confirmed',
		})

		const result = await runBackfill(CONN_STR, { commit: true, tenantIds: [TENANT] })
		expect(result.counters.bookingsScanned).toBe(3)
		expect(result.counters.nightsCreated).toBe(1) // only 1 fits
		expect(result.counters.exhaustedSlots).toBe(2) // 2 overbook detected
		expect(result.conflicts.length).toBe(2)
		expect(await countSlotsForTenant(TENANT)).toBe(1)
	})

	test('[BS5] --dry-run does NOT write', async () => {
		const TENANT = newId('organization')
		const PROPERTY = newId('property')
		const ROOMTYPE = newId('roomType')
		await seedAvailability({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			date: '2042-04-10',
			allotment: 3,
		})
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-04-10',
			nights: 1,
			status: 'confirmed',
		})

		expect(await countSlotsForTenant(TENANT)).toBe(0)
		const result = await runBackfill(CONN_STR, { commit: false, tenantIds: [TENANT] })
		expect(result.counters.nightsCreated).toBe(1)
		expect(await countSlotsForTenant(TENANT)).toBe(0) // dry-run = no write
	})

	test('[BS6] --tenant scope isolates writes', async () => {
		const T1 = newId('organization')
		const T2 = newId('organization')
		const PROPERTY = newId('property')
		const ROOMTYPE = newId('roomType')
		await seedAvailability({
			tenantId: T1,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			date: '2042-05-10',
			allotment: 3,
		})
		await seedAvailability({
			tenantId: T2,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			date: '2042-05-10',
			allotment: 3,
		})
		await seedBooking({
			tenantId: T1,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-05-10',
			nights: 1,
			status: 'confirmed',
		})
		await seedBooking({
			tenantId: T2,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2042-05-10',
			nights: 1,
			status: 'confirmed',
		})

		const r1 = await runBackfill(CONN_STR, { commit: true, tenantIds: [T1] })
		expect(r1.counters.bookingsScanned).toBe(1)
		expect(await countSlotsForTenant(T1)).toBe(1)
		expect(await countSlotsForTenant(T2)).toBe(0) // not touched

		const r2 = await runBackfill(CONN_STR, { commit: true, tenantIds: [T2] })
		expect(r2.counters.bookingsScanned).toBe(1)
		expect(await countSlotsForTenant(T1)).toBe(1) // unchanged
		expect(await countSlotsForTenant(T2)).toBe(1)
	})
})
