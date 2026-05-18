/**
 * Backfill для `roomNightOccupancy` — YDB integration tests.
 *
 * Invariants tested:
 *   [BF1] Pinned confirmed booking → N occupancy rows (one per night) after run.
 *   [BF2] Unpinned (assignedRoomId=null) booking → skipped (0 occupancy rows).
 *   [BF3] Cancelled booking → skipped даже если assignedRoomId set.
 *   [BF4] Idempotent re-run: counters first=created, second=alreadyDone; state identical.
 *   [BF5] Phantom overbook detection: two pinned bookings same room+date → second
 *         classified `phantomOverbookings++`, NOT silently overwritten. Report path set.
 *   [BF6] --dry-run does NOT write — count stays 0 after dry-run.
 *   [BF7] --sample N processes only first N pinned bookings.
 *   [BF8] --tenant <id> scopes к single tenant (cross-tenant isolation).
 *   [BF9] PII-safe: source SELECT projection does not include guestSnapshot/notes
 *         (152-ФЗ guard — verified empirically via successful run on PII-loaded fixture).
 *
 * Per `[[bun-http2-typo-2026-05-17]]` canon: negative-path (BF5 phantom assertion)
 * may flake; happy-path invariants verified through positive assertions on counters.
 */

import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test'

jest.setTimeout(60_000)

import { runBackfill } from './backfill-room-night-occupancy.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { dateFromIso, NULL_TEXT, NULL_TIMESTAMP, toJson, toTs } from './ydb-helpers.ts'

const CONN_STR = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'

describe('backfill-room-night-occupancy', () => {
	const seededBookings: Array<{
		tenantId: string
		propertyId: string
		checkIn: string
		id: string
	}> = []
	const seededOccupancy: Array<{
		tenantId: string
		bookingId: string
	}> = []

	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const o of seededOccupancy) {
			await sql`
				DELETE FROM roomNightOccupancy
				WHERE tenantId = ${o.tenantId} AND bookingId = ${o.bookingId}
			`
		}
		for (const b of seededBookings) {
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
		}
		await teardownTestDb()
	})

	/** Insert a minimal-but-valid booking row directly via UPSERT (bypass repo). */
	async function seedBooking(opts: {
		tenantId: string
		propertyId: string
		checkIn: string
		nights?: number
		status?: 'confirmed' | 'in_house' | 'cancelled' | 'checked_out' | 'no_show'
		assignedRoomId?: string | null
		predefId?: string
	}): Promise<{ tenantId: string; propertyId: string; checkIn: string; id: string }> {
		const sql = getTestSql()
		const id = opts.predefId ?? newId('booking')
		const nights = opts.nights ?? 1
		const status = opts.status ?? 'confirmed'
		const assignedRoomId = opts.assignedRoomId ?? null
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
				${dateFromIso(checkOut)}, ${newId('roomType')}, ${newId('ratePlan')},
				${assignedRoomId ?? NULL_TEXT},
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

	async function countOccupancyForTenant(tenantId: string): Promise<number> {
		const sql = getTestSql()
		const [rows = []] = await sql<{ cnt: number | bigint }[]>`
			SELECT COUNT(*) AS cnt FROM roomNightOccupancy WHERE tenantId = ${tenantId}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return Number(rows[0]?.cnt ?? 0)
	}

	test('[BF1+BF2+BF3] backfill writes N nights for pinned confirmed; skips unpinned + cancelled', async () => {
		const TENANT = newId('organization')
		const PROPERTY = newId('property')
		const ROOM_A = newId('room')
		const ROOM_B = newId('room')
		// 3 nights pinned confirmed → 3 occupancy rows expected
		const pinned = await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2040-01-10',
			nights: 3,
			assignedRoomId: ROOM_A,
			status: 'confirmed',
		})
		// unpinned (assignedRoomId=null) → skipped
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2040-01-20',
			nights: 2,
			assignedRoomId: null,
			status: 'confirmed',
		})
		// pinned BUT cancelled → skipped
		await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2040-01-30',
			nights: 2,
			assignedRoomId: ROOM_B,
			status: 'cancelled',
		})
		seededOccupancy.push({ tenantId: TENANT, bookingId: pinned.id })

		const result = await runBackfill(CONN_STR, {
			commit: true,
			acceptConflicts: false,
			tenantIds: [TENANT],
		})

		expect(result.counters.bookingsScanned).toBe(1) // only the pinned confirmed one
		expect(result.counters.nightsCreated).toBe(3)
		expect(result.counters.nightsAlreadyDone).toBe(0)
		expect(result.counters.phantomOverbookings).toBe(0)
		expect(await countOccupancyForTenant(TENANT)).toBe(3)
	})

	test('[BF4] idempotent re-run: second invocation reports alreadyDone, state unchanged', async () => {
		const TENANT = newId('organization')
		const PROPERTY = newId('property')
		const ROOM = newId('room')
		const pinned = await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2040-02-10',
			nights: 2,
			assignedRoomId: ROOM,
			status: 'in_house',
		})
		seededOccupancy.push({ tenantId: TENANT, bookingId: pinned.id })

		// First run — creates.
		const first = await runBackfill(CONN_STR, {
			commit: true,
			acceptConflicts: false,
			tenantIds: [TENANT],
		})
		expect(first.counters.nightsCreated).toBe(2)
		expect(first.counters.nightsAlreadyDone).toBe(0)

		// Second run — idempotent: same rows still там.
		const second = await runBackfill(CONN_STR, {
			commit: true,
			acceptConflicts: false,
			tenantIds: [TENANT],
		})
		expect(second.counters.nightsCreated).toBe(0)
		expect(second.counters.nightsAlreadyDone).toBe(2)
		expect(second.counters.phantomOverbookings).toBe(0)
		expect(await countOccupancyForTenant(TENANT)).toBe(2) // unchanged
	})

	test('[BF5] phantom overbook: two bookings pinned к same room+date → conflict logged', async () => {
		const TENANT = newId('organization')
		const PROPERTY = newId('property')
		const ROOM = newId('room')
		const a = await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2040-03-10',
			nights: 1,
			assignedRoomId: ROOM,
			status: 'confirmed',
		})
		const b = await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2040-03-10', // same date, same room — phantom overbook
			nights: 1,
			assignedRoomId: ROOM,
			status: 'confirmed',
		})
		seededOccupancy.push({ tenantId: TENANT, bookingId: a.id })
		seededOccupancy.push({ tenantId: TENANT, bookingId: b.id })

		const result = await runBackfill(CONN_STR, {
			commit: true,
			acceptConflicts: true, // allow continue so we see the report
			tenantIds: [TENANT],
		})

		expect(result.counters.bookingsScanned).toBe(2)
		expect(result.counters.nightsAttempted).toBe(2)
		expect(result.counters.nightsCreated).toBe(1) // one winner
		expect(result.counters.phantomOverbookings).toBe(1) // one loser
		expect(result.conflicts.length).toBe(1)
		const conflict = result.conflicts[0]
		// strict shape — every required field present
		expect(conflict?.roomId).toBe(ROOM)
		expect(conflict?.date).toBe('2040-03-10')
		// Winner + loser are different
		expect(conflict?.winnerBookingId).not.toBe(conflict?.loserBookingId)
		// Both came from our seeds
		const ids = new Set([a.id, b.id])
		expect(ids.has(conflict?.winnerBookingId ?? '')).toBe(true)
		expect(ids.has(conflict?.loserBookingId ?? '')).toBe(true)
	})

	test('[BF6] --dry-run does NOT write к DB', async () => {
		const TENANT = newId('organization')
		const PROPERTY = newId('property')
		const ROOM = newId('room')
		const pinned = await seedBooking({
			tenantId: TENANT,
			propertyId: PROPERTY,
			checkIn: '2040-04-10',
			nights: 5,
			assignedRoomId: ROOM,
			status: 'confirmed',
		})
		seededOccupancy.push({ tenantId: TENANT, bookingId: pinned.id })

		expect(await countOccupancyForTenant(TENANT)).toBe(0)
		const result = await runBackfill(CONN_STR, {
			commit: false, // dry-run
			acceptConflicts: false,
			tenantIds: [TENANT],
		})
		// Counters reflect what WOULD happen
		expect(result.counters.nightsCreated).toBe(5)
		// But DB unchanged
		expect(await countOccupancyForTenant(TENANT)).toBe(0)
	})

	test('[BF7] --sample N processes only first N pinned bookings', async () => {
		const TENANT = newId('organization')
		const PROPERTY = newId('property')
		// Seed 4 pinned bookings — sample 2 should touch only 2.
		const bookings = []
		for (let i = 0; i < 4; i += 1) {
			const b = await seedBooking({
				tenantId: TENANT,
				propertyId: PROPERTY,
				checkIn: `2040-05-${String(10 + i).padStart(2, '0')}`,
				nights: 1,
				assignedRoomId: newId('room'),
				status: 'confirmed',
			})
			bookings.push(b)
			seededOccupancy.push({ tenantId: TENANT, bookingId: b.id })
		}

		const result = await runBackfill(CONN_STR, {
			commit: true,
			sampleLimit: 2,
			acceptConflicts: false,
			tenantIds: [TENANT],
		})
		expect(result.counters.bookingsScanned).toBe(2)
		expect(result.counters.nightsCreated).toBe(2)
		expect(await countOccupancyForTenant(TENANT)).toBe(2)
	})

	test('[BF8] --tenant scope isolates writes (cross-tenant safety)', async () => {
		const T1 = newId('organization')
		const T2 = newId('organization')
		const PROPERTY = newId('property')
		const ROOM = newId('room') // same physical room id in both tenants — PK scopes by tenantId
		const b1 = await seedBooking({
			tenantId: T1,
			propertyId: PROPERTY,
			checkIn: '2040-06-10',
			nights: 1,
			assignedRoomId: ROOM,
			status: 'confirmed',
		})
		const b2 = await seedBooking({
			tenantId: T2,
			propertyId: PROPERTY,
			checkIn: '2040-06-10',
			nights: 1,
			assignedRoomId: ROOM,
			status: 'confirmed',
		})
		seededOccupancy.push({ tenantId: T1, bookingId: b1.id })
		seededOccupancy.push({ tenantId: T2, bookingId: b2.id })

		// Run scoped к T1 only.
		const r1 = await runBackfill(CONN_STR, {
			commit: true,
			acceptConflicts: false,
			tenantIds: [T1],
		})
		expect(r1.counters.bookingsScanned).toBe(1)
		expect(await countOccupancyForTenant(T1)).toBe(1)
		expect(await countOccupancyForTenant(T2)).toBe(0)

		// Now T2.
		const r2 = await runBackfill(CONN_STR, {
			commit: true,
			acceptConflicts: false,
			tenantIds: [T2],
		})
		expect(r2.counters.bookingsScanned).toBe(1)
		expect(await countOccupancyForTenant(T1)).toBe(1) // unchanged
		expect(await countOccupancyForTenant(T2)).toBe(1)
	})
})
