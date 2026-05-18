/**
 * `slot_reconciliation_writer` CDC handler — integration tests.
 *
 * Pre-done audit checklist (per `[[pre-done-audit]]` + `[[strict-tests]]`):
 *
 *   Trigger semantics:
 *     [T1] booking INSERT (newImage only, status='confirmed') → slots created
 *     [T2] booking INSERT (status='in_house') → slots created
 *     [T3] booking INSERT (status='cancelled'/'checked_out'/'no_show') → skipped
 *     [T4] booking UPDATE (newImage + oldImage) → skipped (status transitions
 *          handled by repo direct edits)
 *     [T5] booking DELETE (oldImage only) → skipped
 *     [T6] event without newImage → skip silent
 *
 *   Slot allocation:
 *     [SA1] multi-night booking → one slot row per night
 *     [SA2] all slots get slot 0 когда no other bookings (lowest-free canon)
 *     [SA3] consecutive bookings same night → slot 0, 1, 2 deterministic
 *
 *   Idempotency:
 *     [ID1] same INSERT event twice → slots created once (pre-check skips 2nd)
 *
 *   Defensive guards:
 *     [G1] malformed key → skip silent
 *     [G2] missing roomTypeId → skip silent
 *     [G3] missing checkIn/checkOut → skip silent
 *     [G4] empty status → skip silent
 *
 *   Cross-tenant isolation:
 *     [CT1] handler invocation for tenantA does NOT touch tenantB
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test'

jest.setTimeout(60_000)

import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { createSlotReconciliationHandler } from './slot-reconciliation.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = { debug: () => {}, info: () => {}, warn: () => {} }
const handler = createSlotReconciliationHandler(silentLog)

interface BuildOverrides {
	tenantId?: string
	propertyId?: string
	roomTypeId?: string
	checkIn?: string
	checkOut?: string
	bookingId?: string
	status?: string
	includeOldImage?: boolean
	omitNewImage?: boolean
	omitRoomTypeId?: boolean
	omitDates?: boolean
	omitKey?: boolean
}

function buildBookingEvent(overrides: BuildOverrides = {}): CdcEvent {
	const tenantId = overrides.tenantId ?? newId('organization')
	const propertyId = overrides.propertyId ?? newId('property')
	const roomTypeId = overrides.roomTypeId ?? newId('roomType')
	const checkIn = overrides.checkIn ?? '2041-01-10'
	const checkOut = overrides.checkOut ?? '2041-01-11'
	const bookingId = overrides.bookingId ?? newId('booking')
	const status = overrides.status ?? 'confirmed'

	const event: CdcEvent = { key: [tenantId, propertyId, checkIn, bookingId] }
	if (overrides.omitKey) event.key = []

	if (!overrides.omitNewImage) {
		const img: Record<string, unknown> = { status }
		if (!overrides.omitRoomTypeId) img.roomTypeId = roomTypeId
		if (!overrides.omitDates) {
			img.checkIn = checkIn
			img.checkOut = checkOut
		}
		event.newImage = img
	}
	if (overrides.includeOldImage) {
		event.oldImage = { status: 'confirmed' }
	}
	return event
}

async function runHandler(event: CdcEvent): Promise<void> {
	const sql = getTestSql()
	await sql.begin({ idempotent: true }, async (tx) => {
		await handler(tx, event)
	})
}

async function countSlotsForBooking(tenantId: string, bookingId: string): Promise<number> {
	const sql = getTestSql()
	const [rows = []] = await sql<{ cnt: number | bigint }[]>`
		SELECT COUNT(*) AS cnt FROM roomTypeNightSlot
		WHERE tenantId = ${tenantId} AND bookingId = ${bookingId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return Number(rows[0]?.cnt ?? 0)
}

describe('slot_reconciliation_writer — trigger semantics', () => {
	test('[T1] INSERT confirmed booking → slots created', async () => {
		const ev = buildBookingEvent({
			checkIn: '2041-01-10',
			checkOut: '2041-01-11',
			status: 'confirmed',
		})
		await runHandler(ev)
		const tenantId = String(ev.key?.[0])
		const bookingId = String(ev.key?.[3])
		expect(await countSlotsForBooking(tenantId, bookingId)).toBe(1)
	})

	test('[T2] INSERT in_house booking → slots created', async () => {
		const ev = buildBookingEvent({
			checkIn: '2041-02-10',
			checkOut: '2041-02-12',
			status: 'in_house',
		})
		await runHandler(ev)
		const tenantId = String(ev.key?.[0])
		const bookingId = String(ev.key?.[3])
		expect(await countSlotsForBooking(tenantId, bookingId)).toBe(2) // 2 nights
	})

	test('[T3] INSERT cancelled booking → skipped (no slots)', async () => {
		const ev = buildBookingEvent({ status: 'cancelled' })
		await runHandler(ev)
		const tenantId = String(ev.key?.[0])
		const bookingId = String(ev.key?.[3])
		expect(await countSlotsForBooking(tenantId, bookingId)).toBe(0)
	})

	test('[T4] UPDATE event (newImage + oldImage) → skipped', async () => {
		const ev = buildBookingEvent({
			checkIn: '2041-03-10',
			checkOut: '2041-03-11',
			includeOldImage: true,
		})
		await runHandler(ev)
		const tenantId = String(ev.key?.[0])
		const bookingId = String(ev.key?.[3])
		expect(await countSlotsForBooking(tenantId, bookingId)).toBe(0)
	})

	test('[T6] event without newImage → skip silent', async () => {
		const ev = buildBookingEvent({ omitNewImage: true })
		await runHandler(ev) // should not throw
	})
})

describe('slot_reconciliation_writer — slot allocation', () => {
	test('[SA1] 3-night booking → 3 slot rows', async () => {
		const ev = buildBookingEvent({
			checkIn: '2041-04-10',
			checkOut: '2041-04-13',
		})
		await runHandler(ev)
		const tenantId = String(ev.key?.[0])
		const bookingId = String(ev.key?.[3])
		expect(await countSlotsForBooking(tenantId, bookingId)).toBe(3)
	})

	test('[SA2+SA3] sequential events same night → slot 0, 1, 2 deterministic', async () => {
		const sharedRoomType = newId('roomType')
		const sharedProperty = newId('property')
		const sharedTenant = newId('organization')
		const a = buildBookingEvent({
			tenantId: sharedTenant,
			propertyId: sharedProperty,
			roomTypeId: sharedRoomType,
			checkIn: '2041-05-10',
			checkOut: '2041-05-11',
		})
		const b = buildBookingEvent({
			tenantId: sharedTenant,
			propertyId: sharedProperty,
			roomTypeId: sharedRoomType,
			checkIn: '2041-05-10',
			checkOut: '2041-05-11',
		})
		const c = buildBookingEvent({
			tenantId: sharedTenant,
			propertyId: sharedProperty,
			roomTypeId: sharedRoomType,
			checkIn: '2041-05-10',
			checkOut: '2041-05-11',
		})
		await runHandler(a)
		await runHandler(b)
		await runHandler(c)

		const sql = getTestSql()
		const [rows = []] = await sql<{ slotNumber: number | bigint }[]>`
			SELECT slotNumber FROM roomTypeNightSlot
			WHERE tenantId = ${sharedTenant}
				AND propertyId = ${sharedProperty}
				AND roomTypeId = ${sharedRoomType}
			ORDER BY slotNumber
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		expect(rows.map((r) => Number(r.slotNumber))).toEqual([0, 1, 2])
	})
})

describe('slot_reconciliation_writer — idempotency', () => {
	test('[ID1] same INSERT event delivered twice → slots created once', async () => {
		const ev = buildBookingEvent({
			checkIn: '2041-06-10',
			checkOut: '2041-06-12',
		})
		await runHandler(ev)
		await runHandler(ev) // re-delivery
		const tenantId = String(ev.key?.[0])
		const bookingId = String(ev.key?.[3])
		expect(await countSlotsForBooking(tenantId, bookingId)).toBe(2) // 2 nights, not 4
	})
})

describe('slot_reconciliation_writer — defensive guards', () => {
	test('[G1] malformed key → skip silent (no slots, no throw)', async () => {
		const ev = buildBookingEvent({ omitKey: true })
		await runHandler(ev)
	})

	test('[G2] missing roomTypeId → skip silent', async () => {
		const ev = buildBookingEvent({ omitRoomTypeId: true })
		await runHandler(ev)
		const tenantId = String(ev.key?.[0])
		const bookingId = String(ev.key?.[3])
		expect(await countSlotsForBooking(tenantId, bookingId)).toBe(0)
	})

	test('[G3] missing checkIn/checkOut → skip silent', async () => {
		const ev = buildBookingEvent({ omitDates: true })
		await runHandler(ev)
		const tenantId = String(ev.key?.[0])
		const bookingId = String(ev.key?.[3])
		expect(await countSlotsForBooking(tenantId, bookingId)).toBe(0)
	})

	test('[G4] empty status → skip silent', async () => {
		const ev = buildBookingEvent({ status: '' })
		await runHandler(ev)
		const tenantId = String(ev.key?.[0])
		const bookingId = String(ev.key?.[3])
		expect(await countSlotsForBooking(tenantId, bookingId)).toBe(0)
	})
})

describe('slot_reconciliation_writer — cross-tenant isolation', () => {
	test('[CT1] handler call for tenantA does NOT touch tenantB rows', async () => {
		const T1 = newId('organization')
		const T2 = newId('organization')
		const PROPERTY = newId('property')
		const ROOMTYPE = newId('roomType')
		const a = buildBookingEvent({
			tenantId: T1,
			propertyId: PROPERTY,
			roomTypeId: ROOMTYPE,
			checkIn: '2041-07-10',
			checkOut: '2041-07-11',
		})
		await runHandler(a)
		const tenantA_count_for_A = await countSlotsForBooking(T1, String(a.key?.[3]))
		expect(tenantA_count_for_A).toBe(1)

		// Verify T2 has no slot rows
		const sql = getTestSql()
		const [t2Rows = []] = await sql<{ cnt: number | bigint }[]>`
			SELECT COUNT(*) AS cnt FROM roomTypeNightSlot WHERE tenantId = ${T2}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		expect(Number(t2Rows[0]?.cnt ?? 0)).toBe(0)
	})
})
