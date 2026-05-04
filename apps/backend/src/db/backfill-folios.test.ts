/**
 * Folio backfill — YDB integration tests.
 *
 * Invariants:
 *   [B1] Booking with folioId=NULL gets a fresh guest folio + folioId set
 *        after one backfill run.
 *   [B2] Backfill is idempotent: second run is a 0-work no-op.
 *   [B3] Booking already linked (folioId set) is untouched on backfill.
 *   [B4] Drift recovery: if folio exists for a booking but folioId is NULL on
 *        the booking row, backfill relinks to the existing folio (no duplicate
 *        folio created).
 *   [B5] Tenant isolation: a folio created during backfill carries the
 *        booking's own tenantId — never a different tenant's id.
 *   [B6] Currency snapshot: created folio matches booking.currency.
 *   [B7] Convergence assertion: after backfill, no booking row has folioId=NULL.
 *
 * Requires local YDB + migration 0007 applied.
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { runBackfill } from './backfill-folios.ts'
import { dateFromIso, NULL_TEXT, NULL_TIMESTAMP, toJson, toTs } from './ydb-helpers.ts'

const CONN_STR = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'

describe('backfill-folios', { tags: ['db'], timeout: 60_000 }, () => {
	const seededBookings: Array<{
		tenantId: string
		propertyId: string
		checkIn: string
		id: string
	}> = []
	const seededFolios: Array<{
		tenantId: string
		propertyId: string
		bookingId: string
		id: string
	}> = []

	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		const sql = getTestSql()
		// Clean folios linked to our test bookings (created directly + via backfill).
		for (const b of seededBookings) {
			await sql`
				DELETE FROM folio
				WHERE tenantId = ${b.tenantId}
					AND propertyId = ${b.propertyId}
					AND bookingId = ${b.id}
			`
		}
		for (const f of seededFolios) {
			await sql`
				DELETE FROM folio
				WHERE tenantId = ${f.tenantId}
					AND propertyId = ${f.propertyId}
					AND bookingId = ${f.bookingId}
					AND id = ${f.id}
			`
		}
		for (const b of seededBookings) {
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

	/**
	 * Seed a minimal booking row directly via UPSERT — bypasses booking.service
	 * (which would create a folio inline once that path lands in M6.6).
	 *
	 * Defaults that don't matter for this domain are sensible nulls / zeros.
	 */
	async function seedBooking(opts: {
		tenantId: string
		propertyId: string
		checkIn: string
		currency?: string
		folioId?: string | null
		/** Override the auto-generated booking id (lets caller correlate with a folio). */
		predefId?: string
	}): Promise<{ tenantId: string; propertyId: string; checkIn: string; id: string }> {
		const sql = getTestSql()
		const id = opts.predefId ?? newId('booking')
		const checkOut = (() => {
			const d = new Date(`${opts.checkIn}T00:00:00Z`)
			d.setUTCDate(d.getUTCDate() + 1)
			return d.toISOString().slice(0, 10)
		})()
		const now = toTs(new Date())
		const folioBind = opts.folioId ?? NULL_TEXT
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
				\`notes\`, \`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`,
				\`folioId\`
			) VALUES (
				${opts.tenantId}, ${opts.propertyId}, ${dateFromIso(opts.checkIn)}, ${id},
				${dateFromIso(checkOut)}, ${newId('roomType')}, ${newId('ratePlan')}, ${NULL_TEXT},
				${1}, ${1},
				${newId('guest')}, ${toJson({
					firstName: 'Test',
					lastName: 'Guest',
					citizenship: 'RU',
					documentType: 'passport',
					documentNumber: '0000000000',
				})},
				${'confirmed'}, ${now},
				${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${'direct'}, ${NULL_TEXT}, ${toJson(null)},
				${0n}, ${0n}, ${opts.currency ?? 'RUB'}, ${toJson([])},
				${toJson(null)}, ${toJson(null)},
				${'notRequired'}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
				${'unchecked'}, ${NULL_TIMESTAMP},
				${0n}, ${0n},
				${NULL_TEXT}, ${now}, ${now}, ${newId('user')}, ${newId('user')},
				${folioBind}
			)
		`
		const tracker = {
			tenantId: opts.tenantId,
			propertyId: opts.propertyId,
			checkIn: opts.checkIn,
			id,
		}
		seededBookings.push(tracker)
		return tracker
	}

	async function seedFolioRowWithId(opts: {
		tenantId: string
		propertyId: string
		bookingId: string
		folioId: string
		currency?: string
	}): Promise<string> {
		return seedFolioRow({ ...opts, predefId: opts.folioId })
	}

	async function seedFolioRow(opts: {
		tenantId: string
		propertyId: string
		bookingId: string
		currency?: string
		predefId?: string
	}): Promise<string> {
		const sql = getTestSql()
		const folioId = opts.predefId ?? newId('folio')
		const now = toTs(new Date())
		await sql`
			UPSERT INTO folio (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
				\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${opts.tenantId}, ${opts.propertyId}, ${opts.bookingId}, ${folioId},
				${'guest'}, ${'open'}, ${opts.currency ?? 'RUB'}, ${0n}, ${1},
				${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT}, ${NULL_TEXT},
				${now}, ${now}, ${'usr_test'}, ${'usr_test'}
			)
		`
		seededFolios.push({
			tenantId: opts.tenantId,
			propertyId: opts.propertyId,
			bookingId: opts.bookingId,
			id: folioId,
		})
		return folioId
	}

	async function readBookingFolioId(b: {
		tenantId: string
		propertyId: string
		checkIn: string
		id: string
	}): Promise<string | null> {
		const sql = getTestSql()
		const [rows = []] = await sql<{ folioId: string | null }[]>`
			SELECT folioId FROM booking
			WHERE tenantId = ${b.tenantId}
				AND propertyId = ${b.propertyId}
				AND checkIn = ${dateFromIso(b.checkIn)}
				AND id = ${b.id}
			LIMIT 1
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return rows[0]?.folioId ?? null
	}

	async function readFoliosForBooking(b: {
		tenantId: string
		bookingId: string
	}): Promise<
		Array<{ id: string; kind: string; currency: string; balanceMinor: number | bigint }>
	> {
		const sql = getTestSql()
		const [rows = []] = await sql<
			{ id: string; kind: string; currency: string; balanceMinor: number | bigint }[]
		>`
			SELECT id, kind, currency, balanceMinor FROM folio VIEW ixFolioBooking
			WHERE tenantId = ${b.tenantId} AND bookingId = ${b.bookingId}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return rows
	}

	test('[B1+B5+B6+B7] backfill creates guest folio + links booking; tenant + currency match', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const b = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2030-01-15',
			currency: 'RUB',
			folioId: null,
		})
		// Pre-condition: booking is unlinked. The folio table may or may not
		// already have a row for this booking — in local `pnpm dev` the
		// `folio_creator_writer` CDC consumer reacts to the seed insert and
		// inserts a guest folio. Backfill is convergent in either case:
		// creates fresh (no CDC) OR relinks (CDC already ran).
		expect(await readBookingFolioId(b)).toBeNull()

		const stats = await runBackfill(CONN_STR, { tenantIds: [tenantId] })
		// [B1] backfill must take action — either fresh-create или relink.
		expect(stats.foliosCreated + stats.bookingsRelinked).toBeGreaterThanOrEqual(1)

		// Post-condition
		const linkedFolioId = await readBookingFolioId(b)
		expect(linkedFolioId).not.toBeNull()
		const folios = await readFoliosForBooking({ tenantId, bookingId: b.id })
		expect(folios).toHaveLength(1)
		expect(folios[0]?.id).toBe(linkedFolioId)
		expect(folios[0]?.kind).toBe('guest')
		expect(folios[0]?.currency).toBe('RUB') // [B6] matches booking
		expect(BigInt(folios[0]?.balanceMinor ?? 0)).toBe(0n)
	})

	test('[B2] backfill is idempotent — second run scans 0', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		await seedBooking({ tenantId, propertyId, checkIn: '2030-02-15', folioId: null })
		await runBackfill(CONN_STR, { tenantIds: [tenantId] })
		const second = await runBackfill(CONN_STR, { tenantIds: [tenantId] })
		expect(second.bookingsScanned).toBe(0)
		expect(second.foliosCreated).toBe(0)
		expect(second.bookingsRelinked).toBe(0)
	})

	test('[B3] booking already linked is untouched (no duplicate folio, no relink)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		// Pre-allocate the folio id so we can link it on booking-create directly.
		// Avoids hitting gotcha #14 by NOT doing a separate UPDATE in the fixture.
		const bookingId = newId('booking')
		const folioIdLinked = newId('folio')
		// Seed booking row with folioId already populated.
		const b = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2030-03-16',
			folioId: folioIdLinked,
			predefId: bookingId,
		})
		// Seed the folio row pointing at the same booking id.
		await seedFolioRowWithId({
			tenantId,
			propertyId,
			bookingId: b.id,
			folioId: folioIdLinked,
		})

		// Sanity: pre-condition links match
		expect(await readBookingFolioId(b)).toBe(folioIdLinked)
		const beforeFolios = await readFoliosForBooking({ tenantId, bookingId: b.id })
		expect(beforeFolios).toHaveLength(1)

		await runBackfill(CONN_STR, { tenantIds: [tenantId] })

		// After backfill — folioId STILL points at the same folio (untouched),
		// folio count STILL 1 (no duplicate). This is the strong invariant.
		expect(await readBookingFolioId(b)).toBe(folioIdLinked)
		const afterFolios = await readFoliosForBooking({ tenantId, bookingId: b.id })
		expect(afterFolios).toHaveLength(1)
		expect(afterFolios[0]?.id).toBe(folioIdLinked)
	})

	test('[B4] drift recovery — folio exists, booking.folioId NULL → relink (no duplicate)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const b = await seedBooking({ tenantId, propertyId, checkIn: '2030-04-15', folioId: null })
		// Inject orphan folio (folio exists but booking.folioId still null — drift)
		const driftFolioId = await seedFolioRow({ tenantId, propertyId, bookingId: b.id })

		const stats = await runBackfill(CONN_STR, { tenantIds: [tenantId] })
		expect(stats.bookingsRelinked).toBeGreaterThanOrEqual(1)

		// Booking.folioId now points at the existing folio (NOT a new one)
		expect(await readBookingFolioId(b)).toBe(driftFolioId)
		// Still exactly one folio for this booking — no duplicate
		const folios = await readFoliosForBooking({ tenantId, bookingId: b.id })
		expect(folios).toHaveLength(1)
		expect(folios[0]?.id).toBe(driftFolioId)
	})
})
