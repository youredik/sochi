/**
 * Night-audit runner — integration tests against real YDB.
 *
 * **Pre-done audit checklist (per `feedback_pre_done_audit.md`):**
 *
 *   Trigger semantics:
 *     [T1] in_house booking + business date >= checkIn → lines posted
 *     [T2] confirmed booking → 0 lines (only in_house posts)
 *     [T3] cancelled / no_show / checked_out → 0 lines (terminal)
 *     [T4] businessDate < checkIn → 0 lines (audit before stay)
 *     [T5] businessDate at checkOut → posts ALL nights (last billable = checkOut-1)
 *     [T6] businessDate >> checkOut (overstay catch-up) → caps at checkOut-1
 *
 *   Payload correctness:
 *     [P1] folioLine deterministic id `audit_<folioId>_<YYYYMMDD>` (PK collision = idempotency)
 *     [P2] amount = booking.timeSlices[date].grossMicros / 10_000 (kopecks)
 *     [P3] category='accommodation', isAccommodationBase=true, taxRateBps=0
 *     [P4] lineStatus='posted', postedAt set, version=1, createdBy=system actor
 *     [P5] folio.balanceMinor incremented by sum(amounts), version bumped
 *
 *   Idempotency:
 *     [ID1] same audit run twice → no double-post, balance unchanged
 *     [ID2] partial state (some nights already posted) → only missing posted
 *     [ID3] concurrent retry of same audit → only one wins per night (PK)
 *
 *   Defensive guards:
 *     [G1] booking.timeSlices missing date → skip night (warn), continue others
 *     [G2] no open guest folio for in_house booking → skip booking
 *     [G3] folio status='closed' → skip booking
 *     [G4] amount === 0n (free night) → skip post (no $0 line)
 *
 *   Cross-tenant:
 *     [CT1] tenantA audit does NOT post lines on tenantB folios
 *
 * Requires local YDB + migrations 0004 (booking) + 0007 (folio + folioLine).
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { dateFromIso, NULL_TEXT, NULL_TIMESTAMP, toJson, toTs } from '../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { nightAuditLineId } from './lib/night-audit.ts'
import { runNightAudit } from './night-audit.ts'

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

/* ============================================================ seeders */

async function seedBooking(input: {
	tenantId: string
	propertyId: string
	bookingId?: string
	checkIn: string
	checkOut: string
	status: 'confirmed' | 'in_house' | 'checked_out' | 'cancelled' | 'no_show'
	nightlyMicros: bigint
	currency?: string
}): Promise<{ bookingId: string; folioId: string }> {
	const sql = getTestSql()
	const bookingId = input.bookingId ?? newId('booking')
	const folioId = newId('folio')
	const now = new Date()
	const nowTs = toTs(now)
	const currency = input.currency ?? 'RUB'

	// Build per-night time slices.
	const slices: Array<{
		date: string
		grossMicros: string
		ratePlanId: string
		ratePlanVersion: string
		currency: string
	}> = []
	const ratePlanId = newId('ratePlan')
	let cursor = input.checkIn
	while (cursor < input.checkOut) {
		slices.push({
			date: cursor,
			grossMicros: input.nightlyMicros.toString(),
			ratePlanId,
			ratePlanVersion: 'v1',
			currency,
		})
		cursor = addOneDay(cursor)
	}
	const totalMicros = input.nightlyMicros * BigInt(slices.length)

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
			${input.tenantId}, ${input.propertyId}, ${dateFromIso(input.checkIn)}, ${bookingId},
			${dateFromIso(input.checkOut)}, ${newId('roomType')}, ${ratePlanId}, ${NULL_TEXT},
			${1}, ${slices.length}, ${newId('guest')},
			${toJson({
				firstName: 'Тест',
				lastName: 'Тестов',
				citizenship: 'RU',
				documentType: 'passport',
				documentNumber: '1234567',
			})},
			${input.status}, ${nowTs},
			${input.status === 'in_house' || input.status === 'checked_out' ? nowTs : NULL_TIMESTAMP},
			${input.status === 'checked_out' ? nowTs : NULL_TIMESTAMP},
			${input.status === 'cancelled' ? nowTs : NULL_TIMESTAMP},
			${input.status === 'no_show' ? nowTs : NULL_TIMESTAMP},
			${NULL_TEXT},
			${'walkIn'}, ${NULL_TEXT}, ${toJson(null)},
			${totalMicros}, ${0n}, ${currency},
			${toJson(slices)},
			${toJson(null)}, ${toJson(null)},
			${'pending'}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
			${'pending'}, ${NULL_TIMESTAMP},
			${0n}, ${0n},
			${NULL_TEXT},
			${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
		)
	`

	// Seed folio for the booking.
	await sql`
		UPSERT INTO folio (
			\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
			\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
			\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${input.tenantId}, ${input.propertyId}, ${bookingId}, ${folioId},
			${'guest'}, ${'open'}, ${currency}, ${0n}, ${1},
			${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT}, ${NULL_TEXT},
			${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
		)
	`

	return { bookingId, folioId }
}

async function getFolio(tenantId: string, folioId: string) {
	const sql = getTestSql()
	const [rows = []] = await sql<
		Array<{ status: string; balanceMinor: number | bigint; version: number | bigint }>
	>`
		SELECT status, balanceMinor, version FROM folio VIEW ixFolioBooking
		WHERE tenantId = ${tenantId} AND id = ${folioId}
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	const row = rows[0]
	if (!row) return null
	return {
		status: row.status,
		balanceMinor: BigInt(row.balanceMinor).toString(),
		version: Number(row.version),
	}
}

async function listLines(tenantId: string, folioId: string) {
	const sql = getTestSql()
	const [rows = []] = await sql<
		Array<{
			id: string
			category: string
			description: string
			amountMinor: number | bigint
			isAccommodationBase: boolean
			taxRateBps: number | bigint
			lineStatus: string
			postedAt: Date | null
			version: number | bigint
			createdBy: string
			updatedBy: string
		}>
	>`
		SELECT id, category, description, amountMinor, isAccommodationBase, taxRateBps,
		       lineStatus, postedAt, version, createdBy, updatedBy
		FROM folioLine
		WHERE tenantId = ${tenantId} AND folioId = ${folioId}
		ORDER BY id
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows.map((r) => ({
		id: r.id,
		category: r.category,
		description: r.description,
		amountMinor: BigInt(r.amountMinor).toString(),
		isAccommodationBase: r.isAccommodationBase,
		taxRateBps: Number(r.taxRateBps),
		lineStatus: r.lineStatus,
		hasPostedAt: r.postedAt !== null,
		version: Number(r.version),
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}))
}

function addOneDay(iso: string): string {
	const d = new Date(`${iso}T00:00:00Z`)
	d.setUTCDate(d.getUTCDate() + 1)
	return d.toISOString().slice(0, 10)
}

const NIGHTLY_MICROS = 5_000_000_000n // 5000 RUB
const NIGHTLY_MINOR = 500_000n // 5000 RUB × 100 коп

// Pin "now" to noon MSK well past cutoff.
const noonMskOn = (date: string) => new Date(`${date}T09:00:00Z`)

/* ============================================================ trigger semantics */

describe('runNightAudit — trigger semantics', { tags: ['db'] }, () => {
	test('[T1] in_house booking, mid-stay → posts nights up to businessDate', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})

		const result = await runNightAudit(getTestSql(), silentLog, {
			now: noonMskOn('2026-04-26'), // posts night of 04-25
		})
		expect(result.linesPosted).toBeGreaterThanOrEqual(1)

		const lines = await listLines(tenantId, folioId)
		const nightLines = lines.filter((l) => l.id.startsWith(`audit_${folioId}_`))
		expect(nightLines).toHaveLength(1)
		expect(nightLines[0]?.id).toBe(nightAuditLineId(folioId, '2026-04-25'))
	})

	test('[T2] confirmed booking → 0 lines posted', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'confirmed',
			nightlyMicros: NIGHTLY_MICROS,
		})

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-27') })

		const lines = await listLines(tenantId, folioId)
		expect(lines.filter((l) => l.id.startsWith('audit_'))).toHaveLength(0)
	})

	test.each([
		'cancelled',
		'no_show',
		'checked_out',
	] as const)('[T3] %s booking → 0 lines posted (terminal status)', async (status) => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status,
			nightlyMicros: NIGHTLY_MICROS,
		})

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-27') })

		const lines = await listLines(tenantId, folioId)
		expect(lines.filter((l) => l.id.startsWith('audit_'))).toHaveLength(0)
	})

	test('[T4] businessDate < checkIn → 0 lines (audit before stay starts)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-05-10',
			checkOut: '2026-05-13',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-05-08') })

		const lines = await listLines(tenantId, folioId)
		expect(lines.filter((l) => l.id.startsWith('audit_'))).toHaveLength(0)
	})

	test('[T5] businessDate at checkOut → posts ALL nights (NOT checkOut day)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') })

		const lines = await listLines(tenantId, folioId)
		const nightLines = lines.filter((l) => l.id.startsWith('audit_'))
		expect(nightLines).toHaveLength(3)
		expect(nightLines.map((l) => l.id).sort()).toEqual(
			[
				nightAuditLineId(folioId, '2026-04-25'),
				nightAuditLineId(folioId, '2026-04-26'),
				nightAuditLineId(folioId, '2026-04-27'),
			].sort(),
		)
	})

	test('[T6] businessDate >> checkOut → caps at checkOut-1 (overstay catch-up)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-05-30') })

		const lines = await listLines(tenantId, folioId)
		expect(lines.filter((l) => l.id.startsWith('audit_'))).toHaveLength(3)
	})
})

/* ============================================================ payload + balance */

describe('runNightAudit — payload + balance', { tags: ['db'] }, () => {
	test('[P1-P5] line shape + folio.balanceMinor bumped', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') })

		const lines = (await listLines(tenantId, folioId)).filter((l) => l.id.startsWith('audit_'))
		expect(lines).toHaveLength(3)
		for (const line of lines) {
			expect(line.category).toBe('accommodation')
			expect(line.amountMinor).toBe(NIGHTLY_MINOR.toString())
			expect(line.isAccommodationBase).toBe(true)
			expect(line.taxRateBps).toBe(0)
			expect(line.lineStatus).toBe('posted')
			expect(line.hasPostedAt).toBe(true)
			expect(line.version).toBe(1)
			expect(line.createdBy).toBe('system:night_audit')
			expect(line.updatedBy).toBe('system:night_audit')
		}

		const folio = await getFolio(tenantId, folioId)
		expect(folio?.balanceMinor).toBe((NIGHTLY_MINOR * 3n).toString())
		expect(folio?.version).toBe(1 + 3) // initial + 3 posts
	})
})

/* ============================================================ idempotency */

describe('runNightAudit — idempotency', { tags: ['db'] }, () => {
	test('[ID1] running twice → no double-post, balance unchanged', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') })
		const balanceAfterFirst = (await getFolio(tenantId, folioId))?.balanceMinor
		const linesAfterFirst = await listLines(tenantId, folioId)

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') })
		const balanceAfterSecond = (await getFolio(tenantId, folioId))?.balanceMinor
		const linesAfterSecond = await listLines(tenantId, folioId)

		expect(balanceAfterSecond).toBe(balanceAfterFirst)
		expect(linesAfterSecond).toHaveLength(linesAfterFirst.length)
	})

	test('[ID2] partial state — incremental audit only posts missing nights', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-30',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})

		// Day 1 audit: posts only 04-25 night for THIS folio (others uncounted).
		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-26') })
		const linesAfterDay1 = (await listLines(tenantId, folioId)).filter((l) =>
			l.id.startsWith('audit_'),
		)
		expect(linesAfterDay1).toHaveLength(1)

		// Day 4 audit (catch-up): adds 04-26, 04-27, 04-28 → 4 total for this folio.
		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-29') })
		const linesAfterDay4 = (await listLines(tenantId, folioId)).filter((l) =>
			l.id.startsWith('audit_'),
		)
		expect(linesAfterDay4).toHaveLength(4)

		const folio = await getFolio(tenantId, folioId)
		expect(folio?.balanceMinor).toBe((NIGHTLY_MINOR * 4n).toString())
	})

	test('[ID3] concurrent retry — Promise.all([run, run]) → no double-post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})

		await Promise.all([
			runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') }),
			runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') }),
		])

		const lines = (await listLines(tenantId, folioId)).filter((l) => l.id.startsWith('audit_'))
		expect(lines).toHaveLength(3) // exactly 3 nights, regardless of double-fire

		const folio = await getFolio(tenantId, folioId)
		expect(folio?.balanceMinor).toBe((NIGHTLY_MINOR * 3n).toString())
	})
})

/* ============================================================ defensive guards */

describe('runNightAudit — defensive guards', { tags: ['db'] }, () => {
	test('[G1] booking.timeSlices missing date → skip night, continue posting others', async () => {
		// Stay 04-25 → 04-28 but timeSlices only have 04-25 + 04-27 (04-26 absent).
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const bookingId = newId('booking')
		const folioId = newId('folio')
		const sql = getTestSql()
		const now = new Date()
		const nowTs = toTs(now)

		const sparseSlices = [
			{
				date: '2026-04-25',
				grossMicros: NIGHTLY_MICROS.toString(),
				ratePlanId: newId('ratePlan'),
				ratePlanVersion: 'v1',
				currency: 'RUB',
			},
			// 2026-04-26 INTENTIONALLY MISSING — corrupted snapshot path
			{
				date: '2026-04-27',
				grossMicros: NIGHTLY_MICROS.toString(),
				ratePlanId: newId('ratePlan'),
				ratePlanVersion: 'v1',
				currency: 'RUB',
			},
		]

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
				${tenantId}, ${propertyId}, ${dateFromIso('2026-04-25')}, ${bookingId},
				${dateFromIso('2026-04-28')}, ${newId('roomType')}, ${newId('ratePlan')}, ${NULL_TEXT},
				${1}, ${3}, ${newId('guest')},
				${toJson({ firstName: 'Тест', lastName: 'Тестов', citizenship: 'RU', documentType: 'passport', documentNumber: '1234567' })},
				${'in_house'}, ${nowTs}, ${nowTs}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${'walkIn'}, ${NULL_TEXT}, ${toJson(null)},
				${NIGHTLY_MICROS * 3n}, ${0n}, ${'RUB'},
				${toJson(sparseSlices)},
				${toJson(null)}, ${toJson(null)},
				${'pending'}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
				${'pending'}, ${NULL_TIMESTAMP},
				${0n}, ${0n},
				${NULL_TEXT},
				${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
			)
		`
		await sql`
			UPSERT INTO folio (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
				\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${propertyId}, ${bookingId}, ${folioId},
				${'guest'}, ${'open'}, ${'RUB'}, ${0n}, ${1},
				${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT}, ${NULL_TEXT},
				${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
			)
		`

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') })

		const lines = (await listLines(tenantId, folioId)).filter((l) => l.id.startsWith('audit_'))
		// Expect ONLY 04-25 + 04-27, NOT 04-26 (skipped due to missing slice).
		expect(lines).toHaveLength(2)
		const ids = lines.map((l) => l.id).sort()
		expect(ids).toEqual(
			[nightAuditLineId(folioId, '2026-04-25'), nightAuditLineId(folioId, '2026-04-27')].sort(),
		)
	})

	test('[G2] no open guest folio for in_house booking → skip booking', async () => {
		// Seed booking via raw SQL but DO NOT seed folio.
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const bookingId = newId('booking')
		const sql = getTestSql()
		const now = new Date()
		const nowTs = toTs(now)
		const slices = [
			{
				date: '2026-04-25',
				grossMicros: NIGHTLY_MICROS.toString(),
				ratePlanId: newId('ratePlan'),
				ratePlanVersion: 'v1',
				currency: 'RUB',
			},
			{
				date: '2026-04-26',
				grossMicros: NIGHTLY_MICROS.toString(),
				ratePlanId: newId('ratePlan'),
				ratePlanVersion: 'v1',
				currency: 'RUB',
			},
		]
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
				${tenantId}, ${propertyId}, ${dateFromIso('2026-04-25')}, ${bookingId},
				${dateFromIso('2026-04-27')}, ${newId('roomType')}, ${newId('ratePlan')}, ${NULL_TEXT},
				${1}, ${2}, ${newId('guest')},
				${toJson({ firstName: 'Тест', lastName: 'Тестов', citizenship: 'RU', documentType: 'passport', documentNumber: '1234567' })},
				${'in_house'}, ${nowTs}, ${nowTs}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${'walkIn'}, ${NULL_TEXT}, ${toJson(null)},
				${NIGHTLY_MICROS * 2n}, ${0n}, ${'RUB'},
				${toJson(slices)},
				${toJson(null)}, ${toJson(null)},
				${'pending'}, ${NULL_TEXT}, ${NULL_TIMESTAMP},
				${'pending'}, ${NULL_TIMESTAMP},
				${0n}, ${0n},
				${NULL_TEXT},
				${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
			)
		`
		// Run audit — booking has NO folio created by night-audit.
		const result = await runNightAudit(getTestSql(), silentLog, {
			now: noonMskOn('2026-04-27'),
		})
		// Booking was scanned but no lines posted (no folio to post to).
		expect(result.bookingsScanned).toBeGreaterThanOrEqual(1)
		// Verify night-audit did NOT sneak a folio in for this booking. Filter
		// `createdBy` к `system:night_audit` чтобы тест был изолирован от
		// `folio_creator_writer` CDC consumer (running в local `pnpm dev`).
		const [auditFolioRows = []] = await sql<{ x: number }[]>`
			SELECT 1 AS x FROM folio VIEW ixFolioBooking
			WHERE tenantId = ${tenantId}
			  AND bookingId = ${bookingId}
			  AND createdBy = 'system:night_audit'
		`
		expect(auditFolioRows).toHaveLength(0)
	})

	test('[G3] folio status=closed → skip booking entirely', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})

		// Close the folio (simulates manual close mid-stay).
		const sql = getTestSql()
		await sql`
			UPSERT INTO folio (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
				\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${propertyId}, ${bookingId}, ${folioId},
				${'guest'}, ${'closed'}, ${'RUB'}, ${0n}, ${2},
				${toTs(new Date())}, ${NULL_TIMESTAMP}, ${'test-actor'}, ${NULL_TEXT},
				${toTs(new Date())}, ${toTs(new Date())}, ${'test-actor'}, ${'test-actor'}
			)
		`

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') })

		const lines = await listLines(tenantId, folioId)
		expect(lines.filter((l) => l.id.startsWith('audit_'))).toHaveLength(0)
	})

	test('[G4] amount === 0n (free night) → skip post (no $0 line)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { folioId } = await seedBooking({
			tenantId,
			propertyId,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: 0n, // comp / loyalty perk
		})

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') })

		const lines = await listLines(tenantId, folioId)
		expect(lines.filter((l) => l.id.startsWith('audit_'))).toHaveLength(0)
		expect((await getFolio(tenantId, folioId))?.balanceMinor).toBe('0')
	})
})

/* ============================================================ cross-tenant */

describe('runNightAudit — cross-tenant isolation', { tags: ['db'] }, () => {
	test('[CT1] tenantA audit does NOT post on tenantB folios', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const propertyA = newId('property')
		const propertyB = newId('property')

		const { folioId: folioA } = await seedBooking({
			tenantId: tenantA,
			propertyId: propertyA,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS,
		})
		const { folioId: folioB } = await seedBooking({
			tenantId: tenantB,
			propertyId: propertyB,
			checkIn: '2026-04-25',
			checkOut: '2026-04-28',
			status: 'in_house',
			nightlyMicros: NIGHTLY_MICROS * 2n,
		})

		await runNightAudit(getTestSql(), silentLog, { now: noonMskOn('2026-04-28') })

		const linesA = (await listLines(tenantA, folioA)).filter((l) => l.id.startsWith('audit_'))
		const linesB = (await listLines(tenantB, folioB)).filter((l) => l.id.startsWith('audit_'))

		expect(linesA).toHaveLength(3)
		expect(linesB).toHaveLength(3)
		// Different amounts → confirms NO cross-tenant amount bleed.
		expect(linesA[0]?.amountMinor).toBe(NIGHTLY_MINOR.toString())
		expect(linesB[0]?.amountMinor).toBe((NIGHTLY_MINOR * 2n).toString())
	})
})
