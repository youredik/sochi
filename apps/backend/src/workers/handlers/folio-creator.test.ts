/**
 * `folio_creator_writer` CDC handler — integration tests.
 *
 * **Pre-done audit checklist (per memory `feedback_pre_done_audit.md`):**
 *
 *   Trigger semantics:
 *     [T1] booking INSERT (newImage only) → folio created
 *     [T2] booking UPDATE (newImage + oldImage) → NO folio create
 *     [T3] booking DELETE (oldImage only) → NO folio create
 *     [T4] event without newImage → skip silent
 *
 *   Folio payload correctness:
 *     [P1] kind='guest', status='open', balanceMinor=0, version=1
 *     [P2] currency mirrors booking.newImage.currency
 *     [P3] tenantId/propertyId/bookingId from event.key (PK shape)
 *     [P4] createdBy=updatedBy='system:folio_creator_writer'
 *     [P5] folio.id is fresh ULID (newId('folio'))
 *
 *   Idempotency (canon — ixFolioBooking pre-check):
 *     [ID1] same event twice → ONLY ONE folio (pre-check skips 2nd)
 *     [ID2] cross-tenant SAME bookingId → 2 folios (one per tenant — properly isolated)
 *
 *   Defensive guards:
 *     [G1] malformed key (missing components) → skip silent
 *     [G2] missing currency → skip silent
 *     [G3] empty currency string → skip
 *
 *   Cross-tenant isolation:
 *     [CT1] handler invocation for tenantA does NOT touch tenantB
 *
 * Requires local YDB + migrations 0007 (folio table) + 0019 (consumer registration).
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { createFolioCreatorHandler } from './folio-creator.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = { debug: () => {}, info: () => {}, warn: () => {} }
const handler = createFolioCreatorHandler(silentLog)

/**
 * Build a representative booking CDC event.
 *
 * Booking PK shape: (tenantId, propertyId, checkIn, id) — see migration 0004.
 */
function buildBookingEvent(
	overrides: {
		tenantId?: string
		propertyId?: string
		checkIn?: string
		bookingId?: string
		currency?: string | undefined
		omitNewImage?: boolean
		omitOldImage?: boolean
		includeOldImage?: boolean
		omitKey?: boolean
	} = {},
): CdcEvent {
	const tenantId = overrides.tenantId ?? newId('organization')
	const propertyId = overrides.propertyId ?? newId('property')
	const checkIn = overrides.checkIn ?? '2026-05-01'
	const bookingId = overrides.bookingId ?? newId('booking')

	const event: CdcEvent = { key: [tenantId, propertyId, checkIn, bookingId] }
	if (overrides.omitKey) event.key = []

	if (!overrides.omitNewImage) {
		event.newImage = {
			currency: overrides.currency,
			status: 'confirmed',
			roomTypeId: newId('roomType'),
		}
	}
	if (overrides.includeOldImage) {
		event.oldImage = {
			currency: overrides.currency ?? 'RUB',
			status: 'confirmed',
		}
	}
	return event
}

async function runHandler(event: CdcEvent): Promise<void> {
	const sql = getTestSql()
	await sql.begin({ idempotent: true }, async (tx) => {
		await handler(tx, event)
	})
}

async function findFoliosByBooking(
	tenantId: string,
	bookingId: string,
): Promise<
	Array<{
		id: string
		propertyId: string
		kind: string
		status: string
		currency: string
		balanceMinor: string
		version: number
		createdBy: string
		updatedBy: string
	}>
> {
	const sql = getTestSql()
	const [rows = []] = await sql<
		Array<{
			id: string
			propertyId: string
			kind: string
			status: string
			currency: string
			balanceMinor: number | bigint
			version: number | bigint
			createdBy: string
			updatedBy: string
		}>
	>`
		SELECT id, propertyId, kind, status, currency, balanceMinor, version, createdBy, updatedBy
		FROM folio VIEW ixFolioBooking
		WHERE tenantId = ${tenantId} AND bookingId = ${bookingId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows.map((r) => ({
		id: r.id,
		propertyId: r.propertyId,
		kind: r.kind,
		status: r.status,
		currency: r.currency,
		balanceMinor: BigInt(r.balanceMinor).toString(),
		version: Number(r.version),
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}))
}

describe('folio_creator_writer — trigger semantics', { tags: ['db'] }, () => {
	test('[T1] booking INSERT → folio created', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await runHandler(buildBookingEvent({ tenantId, bookingId, currency: 'RUB' }))
		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(folios).toHaveLength(1)
	})

	test('[T2] booking UPDATE (oldImage present) → no folio create', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await runHandler(
			buildBookingEvent({ tenantId, bookingId, currency: 'RUB', includeOldImage: true }),
		)
		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(folios).toHaveLength(0)
	})

	test('[T3] booking DELETE (no newImage) → no folio create', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await runHandler(
			buildBookingEvent({ tenantId, bookingId, omitNewImage: true, includeOldImage: true }),
		)
		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(folios).toHaveLength(0)
	})

	test('[T4] event without newImage → skip silent', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await runHandler(buildBookingEvent({ tenantId, bookingId, omitNewImage: true }))
		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(folios).toHaveLength(0)
	})
})

describe('folio_creator_writer — payload correctness', { tags: ['db'] }, () => {
	test('[P1+P2+P4] folio shape: kind=guest, status=open, balance=0, currency mirrors, system actor', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await runHandler(buildBookingEvent({ tenantId, bookingId, currency: 'RUB' }))
		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(folios).toHaveLength(1)
		const f = folios[0]
		if (!f) throw new Error('expected folio')
		expect(f.kind).toBe('guest')
		expect(f.status).toBe('open')
		expect(f.balanceMinor).toBe('0')
		expect(f.currency).toBe('RUB')
		expect(f.version).toBe(1)
		expect(f.createdBy).toBe('system:folio_creator_writer')
		expect(f.updatedBy).toBe('system:folio_creator_writer')
	})

	test('[P3] propertyId from event.key[1]', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const bookingId = newId('booking')
		await runHandler(buildBookingEvent({ tenantId, propertyId, bookingId, currency: 'RUB' }))
		const folios = await findFoliosByBooking(tenantId, bookingId)
		const f = folios[0]
		if (!f) throw new Error('expected folio')
		expect(f.propertyId).toBe(propertyId)
	})

	test('[P5] folio.id is fresh ULID (different across runs)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const bookingId1 = newId('booking')
		const bookingId2 = newId('booking')
		await runHandler(
			buildBookingEvent({ tenantId, propertyId, bookingId: bookingId1, currency: 'RUB' }),
		)
		await runHandler(
			buildBookingEvent({ tenantId, propertyId, bookingId: bookingId2, currency: 'RUB' }),
		)
		const f1 = (await findFoliosByBooking(tenantId, bookingId1))[0]
		const f2 = (await findFoliosByBooking(tenantId, bookingId2))[0]
		if (!f1 || !f2) throw new Error('expected both folios')
		expect(f1.id).not.toBe(f2.id)
	})
})

describe('folio_creator_writer — idempotency', { tags: ['db'] }, () => {
	test('[ID1] same event twice sequential → exactly ONE folio (pre-check)', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		const event = buildBookingEvent({ tenantId, bookingId, currency: 'RUB' })
		await runHandler(event)
		await runHandler(event) // replay
		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(folios).toHaveLength(1)
	})

	test('[ID2] cross-tenant SAME bookingId → 2 folios (one per tenant)', async () => {
		const bookingId = newId('booking')
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		await runHandler(buildBookingEvent({ tenantId: tenantA, bookingId, currency: 'RUB' }))
		await runHandler(buildBookingEvent({ tenantId: tenantB, bookingId, currency: 'EUR' }))
		expect(await findFoliosByBooking(tenantA, bookingId)).toHaveLength(1)
		expect(await findFoliosByBooking(tenantB, bookingId)).toHaveLength(1)
	})

	test('[ID3] CONCURRENT replay (Promise.all) → at most ONE folio (no race window)', async () => {
		// Real-world race: 2 CDC consumers replay same booking event simultaneously.
		// Without DB-level UNIQUE, the only guard is YDB's serializable tx isolation:
		// 2 concurrent SELECT-then-UPSERT — one wins, other surfaces as either
		// success (saw winner's row in pre-check) OR tx invalidation (re-runs).
		// Final state must be EXACTLY one folio. Honest test (NOT just sequential).
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		const event = buildBookingEvent({ tenantId, bookingId, currency: 'RUB' })

		const results = await Promise.allSettled([runHandler(event), runHandler(event)])

		// At least one MUST succeed; the other may either succeed (saw winner)
		// or fail (tx invalidation under load). Either way — final folio count = 1.
		const succeeded = results.filter((r) => r.status === 'fulfilled').length
		expect(succeeded).toBeGreaterThanOrEqual(1)

		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(
			folios.length,
			`Race produced ${folios.length} folios — expected 1. Pre-check + serializable tx must guard.`,
		).toBe(1)
	})
})

describe('folio_creator_writer — defensive guards', { tags: ['db'] }, () => {
	test('[G1] malformed key (empty) → skip silent', async () => {
		const event = buildBookingEvent({ omitKey: true, currency: 'RUB' })
		await runHandler(event) // should NOT throw
	})

	test('[G2] missing currency → skip silent', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await runHandler(buildBookingEvent({ tenantId, bookingId, currency: undefined }))
		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(folios).toHaveLength(0)
	})

	test('[G3] empty currency string → skip', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await runHandler(buildBookingEvent({ tenantId, bookingId, currency: '' }))
		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(folios).toHaveLength(0)
	})
})

describe('folio_creator_writer — cross-tenant isolation', { tags: ['db'] }, () => {
	test('[CT1] handler for tenantA does NOT touch tenantB', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const bookingA = newId('booking')
		await runHandler(buildBookingEvent({ tenantId: tenantA, bookingId: bookingA, currency: 'RUB' }))
		// tenantB queried for bookingA — must return empty
		expect(await findFoliosByBooking(tenantB, bookingA)).toHaveLength(0)
	})
})

describe('folio_creator_writer — currency variants', { tags: ['db'] }, () => {
	test.each(['RUB', 'EUR', 'USD'])('currency=%s passthrough', async (currency) => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await runHandler(buildBookingEvent({ tenantId, bookingId, currency }))
		const folios = await findFoliosByBooking(tenantId, bookingId)
		expect(folios[0]?.currency).toBe(currency)
	})
})
