/**
 * Notification cron worker — integration tests against real YDB.
 *
 * Pre-done audit checklist:
 *   Trigger semantics:
 *     [T1] checkin_reminder fires when status=confirmed AND checkIn=tomorrow
 *           AND now MSK hour=18
 *     [T2] review_request fires when status=checked_out AND checkOut=yesterday
 *           AND now MSK hour=11
 *     [T3] not in MSK firing window → no rows written
 *     [T4] cancelled booking → no checkin_reminder
 *     [T5] no_show booking → no checkin_reminder
 *     [T6] confirmed booking with future checkIn (not tomorrow) → no row
 *     [T7] cancelled booking on yesterday's checkOut → no review_request
 *
 *   Idempotency:
 *     [ID1] running runJobs twice in same hour → ONE row, no dup
 *
 *   Cross-tenant:
 *     [CT1] tenants isolated (correct tenantId on outbox row)
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { dateFromIso, NULL_TEXT, NULL_TIMESTAMP, toJson, toTs } from '../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { startNotificationCron } from './notification-cron.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
}

interface SeedBookingOpts {
	tenantId: string
	propertyId?: string
	checkIn: string
	checkOut: string
	status: 'confirmed' | 'in_house' | 'checked_out' | 'cancelled' | 'no_show'
	bookingId?: string
}

async function seedBooking(opts: SeedBookingOpts): Promise<{ bookingId: string }> {
	const sql = getTestSql()
	const bookingId = opts.bookingId ?? newId('booking')
	const propertyId = opts.propertyId ?? newId('property')
	const now = new Date()
	const nowTs = toTs(now)
	await sql`
		UPSERT INTO booking (
			\`tenantId\`, \`propertyId\`, \`checkIn\`, \`id\`,
			\`checkOut\`, \`roomTypeId\`, \`ratePlanId\`, \`assignedRoomId\`,
			\`guestsCount\`, \`nightsCount\`, \`primaryGuestId\`, \`guestSnapshot\`,
			\`status\`, \`confirmedAt\`, \`checkedInAt\`, \`checkedOutAt\`, \`cancelledAt\`, \`noShowAt\`, \`cancelReason\`,
			\`channelCode\`, \`externalId\`, \`externalReferences\`,
			\`totalMicros\`, \`paidMicros\`, \`currency\`, \`timeSlices\`,
			\`cancellationFee\`, \`noShowFee\`,
			\`registrationStatus\`, \`registrationMvdId\`, \`registrationSubmittedAt\`,
			\`rklCheckResult\`, \`rklCheckedAt\`,
			\`tourismTaxBaseMicros\`, \`tourismTaxMicros\`,
			\`notes\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${opts.tenantId}, ${propertyId}, ${dateFromIso(opts.checkIn)}, ${bookingId},
			${dateFromIso(opts.checkOut)}, ${newId('roomType')}, ${newId('ratePlan')}, ${NULL_TEXT},
			${1}, ${1}, ${newId('guest')},
			${toJson({ firstName: 'Test', lastName: 'Test', citizenship: 'RU', documentType: 'passport', documentNumber: '1234567' })},
			${opts.status}, ${nowTs},
			${opts.status === 'in_house' || opts.status === 'checked_out' ? nowTs : NULL_TIMESTAMP},
			${opts.status === 'checked_out' ? nowTs : NULL_TIMESTAMP},
			${opts.status === 'cancelled' ? nowTs : NULL_TIMESTAMP},
			${opts.status === 'no_show' ? nowTs : NULL_TIMESTAMP},
			${NULL_TEXT},
			${'walkIn'}, ${NULL_TEXT}, ${toJson(null)},
			${5_000_000_000n}, ${0n}, ${'RUB'},
			${toJson([{ date: opts.checkIn, grossMicros: '5000000000', ratePlanId: 'rate', ratePlanVersion: 'v1', currency: 'RUB' }])},
			${toJson(null)}, ${toJson(null)},
			${'pending'}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
			${'pending'}, ${NULL_TIMESTAMP},
			${0n}, ${0n},
			${NULL_TEXT},
			${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
		)
	`
	return { bookingId }
}

async function listOutboxByBooking(tenantId: string, bookingId: string) {
	const sql = getTestSql()
	const [rows = []] = await sql<
		{ id: string; kind: string; sourceEventDedupKey: string; status: string }[]
	>`
		SELECT id, kind, sourceEventDedupKey, status
		FROM notificationOutbox
		WHERE tenantId = ${tenantId}
		  AND sourceObjectType = 'booking'
		  AND sourceObjectId = ${bookingId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows
}

// 15:00 UTC = 18:00 MSK on 2026-04-26 → checkin_reminder window.
const checkinHourNow = new Date('2026-04-26T15:00:00Z')
// 08:00 UTC = 11:00 MSK on 2026-04-26 → review_request window.
const reviewHourNow = new Date('2026-04-26T08:00:00Z')
// 12:00 UTC = 15:00 MSK on 2026-04-26 → outside both windows.
const offHourNow = new Date('2026-04-26T12:00:00Z')

describe('notification-cron — checkin_reminder', { tags: ['db'] }, () => {
	test('[T1] confirmed + checkIn=tomorrow + 18:00 MSK → row written', async () => {
		const tenantId = newId('organization')
		// "Tomorrow" relative to 2026-04-26 = 2026-04-27.
		const { bookingId } = await seedBooking({
			tenantId,
			checkIn: '2026-04-27',
			checkOut: '2026-04-28',
			status: 'confirmed',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		const stats = await cron.runJobs(checkinHourNow)
		expect(stats.checkinReminders).toBeGreaterThanOrEqual(1)

		const rows = await listOutboxByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.kind).toBe('checkin_reminder')
		expect(rows[0]?.sourceEventDedupKey).toBe(`booking:${bookingId}:checkin_reminder`)
		await cron.stop()
	})

	test('[T3] confirmed + checkIn=tomorrow + 15:00 MSK (off-hour) → no row', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBooking({
			tenantId,
			checkIn: '2026-04-27',
			checkOut: '2026-04-28',
			status: 'confirmed',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		await cron.runJobs(offHourNow)

		const rows = await listOutboxByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
		await cron.stop()
	})

	test('[T4] cancelled + checkIn=tomorrow + 18:00 MSK → no row', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBooking({
			tenantId,
			checkIn: '2026-04-27',
			checkOut: '2026-04-28',
			status: 'cancelled',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		await cron.runJobs(checkinHourNow)

		const rows = await listOutboxByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
		await cron.stop()
	})

	test('[T5] no_show + checkIn=tomorrow + 18:00 MSK → no row', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBooking({
			tenantId,
			checkIn: '2026-04-27',
			checkOut: '2026-04-28',
			status: 'no_show',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		await cron.runJobs(checkinHourNow)

		const rows = await listOutboxByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
		await cron.stop()
	})

	test('[T6] confirmed + checkIn=2 days out → no row (not in window)', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBooking({
			tenantId,
			checkIn: '2026-04-28', // 2 days from "now" 04-26
			checkOut: '2026-04-29',
			status: 'confirmed',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		await cron.runJobs(checkinHourNow)

		const rows = await listOutboxByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
		await cron.stop()
	})
})

describe('notification-cron — review_request', { tags: ['db'] }, () => {
	test('[T2] checked_out + checkOut=yesterday + 11:00 MSK → row written', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBooking({
			tenantId,
			checkIn: '2026-04-23',
			checkOut: '2026-04-25', // "yesterday" relative to 04-26
			status: 'checked_out',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		const stats = await cron.runJobs(reviewHourNow)
		expect(stats.reviewRequests).toBeGreaterThanOrEqual(1)

		const rows = await listOutboxByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.kind).toBe('review_request')
		expect(rows[0]?.sourceEventDedupKey).toBe(`booking:${bookingId}:review_request`)
		await cron.stop()
	})

	test('[T7] cancelled booking on yesterday checkOut → no review_request (anti-spam)', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBooking({
			tenantId,
			checkIn: '2026-04-23',
			checkOut: '2026-04-25',
			status: 'cancelled',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		await cron.runJobs(reviewHourNow)

		const rows = await listOutboxByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
		await cron.stop()
	})

	test('no_show booking on yesterday checkOut → no review_request (anti-spam)', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBooking({
			tenantId,
			checkIn: '2026-04-23',
			checkOut: '2026-04-25',
			status: 'no_show',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		await cron.runJobs(reviewHourNow)

		const rows = await listOutboxByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
		await cron.stop()
	})
})

describe('notification-cron — idempotency', { tags: ['db'] }, () => {
	test('[ID1] runJobs twice in same hour → ONE row', async () => {
		const tenantId = newId('organization')
		const { bookingId } = await seedBooking({
			tenantId,
			checkIn: '2026-04-27',
			checkOut: '2026-04-28',
			status: 'confirmed',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		await cron.runJobs(checkinHourNow)
		await cron.runJobs(checkinHourNow)
		await cron.runJobs(checkinHourNow)

		const rows = await listOutboxByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(1)
		await cron.stop()
	})
})

describe('notification-cron — cross-tenant', { tags: ['db'] }, () => {
	test('[CT1] tenantA + tenantB both eligible → both get rows, no leak', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const { bookingId: bookingA } = await seedBooking({
			tenantId: tenantA,
			checkIn: '2026-04-27',
			checkOut: '2026-04-28',
			status: 'confirmed',
		})
		const { bookingId: bookingB } = await seedBooking({
			tenantId: tenantB,
			checkIn: '2026-04-27',
			checkOut: '2026-04-28',
			status: 'confirmed',
		})

		const cron = startNotificationCron(getTestSql(), silentLog, { skipTimer: true })
		await cron.runJobs(checkinHourNow)

		const rowsA = await listOutboxByBooking(tenantA, bookingA)
		const rowsB = await listOutboxByBooking(tenantB, bookingB)
		expect(rowsA).toHaveLength(1)
		expect(rowsB).toHaveLength(1)
		// Verify no cross-tenant: rowsA has tenantA's bookingId in dedup key
		expect(rowsA[0]?.sourceEventDedupKey).toContain(bookingA)
		expect(rowsB[0]?.sourceEventDedupKey).toContain(bookingB)
		await cron.stop()
	})
})
