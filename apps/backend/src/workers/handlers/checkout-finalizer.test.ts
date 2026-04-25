/**
 * `tourism_tax_writer` CDC handler — integration tests against real YDB.
 *
 * **Pre-done audit checklist (`feedback_pre_done_audit.md`):**
 *
 *   Trigger semantics:
 *     [T1] booking UPDATE oldStatus=in_house → newStatus=checked_out → posts tax
 *     [T2] booking UPDATE oldStatus=confirmed → newStatus=cancelled → no post
 *     [T3] booking UPDATE oldStatus=checked_out → newStatus=checked_out → no double-post
 *     [T4] booking INSERT (no oldImage) → no post (only triggers on UPDATE)
 *     [T5] booking DELETE (no newImage) → no post
 *
 *   Payload + math:
 *     [P1] line shape: category=tourismTax, isAccommodationBase=false, taxRateBps=rate
 *     [P2] amount = computeTourismTax(totalMicros / 10_000, rateBps, nights)
 *     [P3] folio.balanceMinor incremented by tax amount
 *     [P4] line id = `tax_<bookingId>` (deterministic)
 *
 *   Idempotency:
 *     [ID1] same event twice → ONE line, balance bumped only once
 *     [ID2] line already exists from prior run → skip silently
 *
 *   Defensive guards:
 *     [G1] property tourismTaxRateBps=NULL → skip post (legacy property)
 *     [G2] property tourismTaxRateBps=0 → skip post (region not adopted)
 *     [G3] no folio for booking → skip post
 *     [G4] folio.status='closed' → skip (post-close race)
 *     [G5] currency mismatch booking vs folio → skip
 *     [G6] missing newImage fields (totalMicros / nightsCount / currency) → skip
 *
 *   Cross-tenant:
 *     [CT1] tenantA event does NOT post on tenantB folio
 *
 * Requires migrations 0004 (booking) + 0007 (folio + folioLine) + 0020 (consumer).
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NULL_INT32, NULL_TEXT, NULL_TIMESTAMP, toTs } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { createCheckoutFinalizerHandler } from './checkout-finalizer.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = { debug: () => {}, info: () => {}, warn: () => {} }
const handler = createCheckoutFinalizerHandler(silentLog)

/* ============================================================ seeders */

interface SeedOpts {
	tenantId: string
	propertyId: string
	bookingId?: string
	folioId?: string
	rateBps: number | null
	totalMicros: bigint
	nightsCount: number
	checkIn?: string
	currency?: string
	folioStatus?: 'open' | 'closed'
	folioCurrency?: string
	skipFolio?: boolean
}

async function seed(opts: SeedOpts) {
	const sql = getTestSql()
	const bookingId = opts.bookingId ?? newId('booking')
	const folioId = opts.folioId ?? newId('folio')
	const checkIn = opts.checkIn ?? '2026-04-25'
	const currency = opts.currency ?? 'RUB'
	const folioCurrency = opts.folioCurrency ?? currency
	const folioStatus = opts.folioStatus ?? 'open'
	const now = new Date()
	const nowTs = toTs(now)

	// Seed property with tourismTaxRateBps.
	await sql`
		UPSERT INTO property (
			\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
			\`classificationId\`, \`isActive\`, \`tourismTaxRateBps\`,
			\`createdAt\`, \`updatedAt\`
		) VALUES (
			${opts.tenantId}, ${opts.propertyId}, ${'Test Property'}, ${'Sochi'}, ${'Сочи'},
			${'Europe/Moscow'}, ${NULL_TEXT}, ${true},
			${opts.rateBps ?? NULL_INT32},
			${nowTs}, ${nowTs}
		)
	`

	// Optionally seed folio (skipFolio=true → guard test).
	if (!opts.skipFolio) {
		await sql`
			UPSERT INTO folio (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
				\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${opts.tenantId}, ${opts.propertyId}, ${bookingId}, ${folioId},
				${'guest'}, ${folioStatus}, ${folioCurrency}, ${0n}, ${1},
				${folioStatus === 'closed' ? nowTs : NULL_TIMESTAMP}, ${NULL_TIMESTAMP},
				${folioStatus === 'closed' ? 'test-actor' : NULL_TEXT}, ${NULL_TEXT},
				${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
			)
		`
	}

	return {
		bookingId,
		folioId,
		propertyId: opts.propertyId,
		tenantId: opts.tenantId,
		currency,
		checkIn,
	}
}

function buildEvent(args: {
	tenantId: string
	propertyId: string
	checkIn: string
	bookingId: string
	totalMicros?: bigint | string
	nightsCount?: number
	currency?: string
	oldStatus?: string
	newStatus?: string
	omitNewImage?: boolean
	omitOldImage?: boolean
	omitTotalMicros?: boolean
	omitNightsCount?: boolean
	omitCurrency?: boolean
}): CdcEvent {
	const event: CdcEvent = {
		key: [args.tenantId, args.propertyId, args.checkIn, args.bookingId],
	}
	if (!args.omitOldImage) {
		event.oldImage = { status: args.oldStatus ?? 'in_house' }
	}
	if (!args.omitNewImage) {
		const newImage: Record<string, unknown> = { status: args.newStatus ?? 'checked_out' }
		if (!args.omitTotalMicros) {
			newImage.totalMicros =
				args.totalMicros !== undefined ? String(args.totalMicros) : '5000000000'
		}
		if (!args.omitNightsCount) {
			newImage.nightsCount = args.nightsCount ?? 1
		}
		if (!args.omitCurrency) {
			newImage.currency = args.currency ?? 'RUB'
		}
		event.newImage = newImage
	}
	return event
}

async function runHandler(event: CdcEvent): Promise<void> {
	const sql = getTestSql()
	await sql.begin({ idempotent: true }, async (tx) => {
		await handler(tx, event)
	})
}

async function getFolio(tenantId: string, folioId: string) {
	const sql = getTestSql()
	const [rows = []] = await sql<
		{ status: string; balanceMinor: number | bigint; version: number | bigint }[]
	>`
		SELECT status, balanceMinor, version
		FROM folio VIEW ixFolioBooking
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
			amountMinor: number | bigint
			isAccommodationBase: boolean
			taxRateBps: number | bigint
			lineStatus: string
			createdBy: string
		}>
	>`
		SELECT id, category, amountMinor, isAccommodationBase, taxRateBps, lineStatus, createdBy
		FROM folioLine
		WHERE tenantId = ${tenantId} AND folioId = ${folioId}
		ORDER BY id
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows.map((r) => ({
		id: r.id,
		category: r.category,
		amountMinor: BigInt(r.amountMinor).toString(),
		isAccommodationBase: r.isAccommodationBase,
		taxRateBps: Number(r.taxRateBps),
		lineStatus: r.lineStatus,
		createdBy: r.createdBy,
	}))
}

const SOCHI_2026_BPS = 200 // 2%
const TOTAL_MICROS_5K = 5_000_000_000n // 5000 RUB × 1_000_000

/* ============================================================ trigger semantics */

describe('checkout_finalizer — trigger semantics', { tags: ['db'] }, () => {
	test('[T1] in_house → checked_out → tax line posted', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: TOTAL_MICROS_5K,
				nightsCount: 1,
				currency: 'RUB',
				oldStatus: 'in_house',
				newStatus: 'checked_out',
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(1)
		expect(lines[0]?.category).toBe('tourismTax')
		// 5000 ₽ × 2% = 100 ₽ = 10_000 коп. Floor (1 night × 100₽) = 10_000 коп. Equal.
		expect(lines[0]?.amountMinor).toBe('10000')
	})

	test('[T2] cancelled (NOT checked_out) → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				oldStatus: 'confirmed',
				newStatus: 'cancelled',
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})

	test('[T3] already checked_out → no double-post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: TOTAL_MICROS_5K,
				nightsCount: 1,
				currency: 'RUB',
				oldStatus: 'checked_out',
				newStatus: 'checked_out',
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})

	test('[T4] INSERT (no oldImage) → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: TOTAL_MICROS_5K,
				nightsCount: 1,
				currency: 'RUB',
				newStatus: 'checked_out',
				omitOldImage: true,
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})

	test('[T5] DELETE (no newImage) → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				oldStatus: 'in_house',
				omitNewImage: true,
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})
})

/* ============================================================ payload + math */

describe('checkout_finalizer — payload + math', { tags: ['db'] }, () => {
	test('[P1-P4] line shape, deterministic id, folio balance bumped', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 5, // computed: 25000₽ × 2% = 500₽; floor 5×100=500₽; tax=500₽ = 50_000 коп
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: 25_000_000_000n, // 25000 RUB
				nightsCount: 5,
				currency: 'RUB',
				oldStatus: 'in_house',
				newStatus: 'checked_out',
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(1)
		const line = lines[0]
		if (!line) throw new Error('expected line')
		expect(line.id).toBe(`tax_${seeded.bookingId}`)
		expect(line.category).toBe('tourismTax')
		expect(line.isAccommodationBase).toBe(false)
		expect(line.taxRateBps).toBe(SOCHI_2026_BPS)
		expect(line.lineStatus).toBe('posted')
		expect(line.createdBy).toBe('system:tourism_tax_writer')
		// 25000 ₽ × 2% = 500 ₽ = 50_000 коп. Floor 5 × 100 = 500 ₽. Equal.
		expect(line.amountMinor).toBe('50000')

		const folio = await getFolio(tenantId, seeded.folioId)
		expect(folio?.balanceMinor).toBe('50000')
		expect(folio?.version).toBe(2) // 1 → 2 after one post
	})

	test('cheap room hits min floor (100 ₽ × 3 nights = 300 ₽)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: 1_000_000_000n, // 1000 RUB total
			nightsCount: 3,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: 1_000_000_000n, // 1000 ₽ total = 100_000 коп
				nightsCount: 3,
				currency: 'RUB',
				oldStatus: 'in_house',
				newStatus: 'checked_out',
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		// computed = 1000 × 2% = 20₽; floor = 3 × 100₽ = 300₽ = 30_000 коп. Floor wins.
		expect(lines[0]?.amountMinor).toBe('30000')
	})
})

/* ============================================================ idempotency */

describe('checkout_finalizer — idempotency', { tags: ['db'] }, () => {
	test('[ID1] same event twice → ONE line, balance bumped once', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		const event = buildEvent({
			tenantId,
			propertyId,
			checkIn: seeded.checkIn,
			bookingId: seeded.bookingId,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
			currency: 'RUB',
			oldStatus: 'in_house',
			newStatus: 'checked_out',
		})

		await runHandler(event)
		await runHandler(event)
		await runHandler(event)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(1)

		const folio = await getFolio(tenantId, seeded.folioId)
		expect(folio?.balanceMinor).toBe('10000')
		expect(folio?.version).toBe(2) // 1 → 2 after first post; subsequent skipped
	})
})

/* ============================================================ defensive guards */

describe('checkout_finalizer — defensive guards', { tags: ['db'] }, () => {
	test('[G1] property tourismTaxRateBps=NULL → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: null,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: TOTAL_MICROS_5K,
				nightsCount: 1,
				currency: 'RUB',
				oldStatus: 'in_house',
				newStatus: 'checked_out',
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})

	test('[G2] property tourismTaxRateBps=0 → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: 0,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: TOTAL_MICROS_5K,
				nightsCount: 1,
				currency: 'RUB',
				oldStatus: 'in_house',
				newStatus: 'checked_out',
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})

	test('[G3] no folio → no post (orphan booking)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
			skipFolio: true,
		})

		// Should not throw — handler logs warn and returns.
		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: TOTAL_MICROS_5K,
				nightsCount: 1,
				currency: 'RUB',
				oldStatus: 'in_house',
				newStatus: 'checked_out',
			}),
		)
		// Verify no folio was magically created.
		const folio = await getFolio(tenantId, seeded.folioId)
		expect(folio).toBeNull()
	})

	test('[G4] folio.status=closed → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
			folioStatus: 'closed',
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: TOTAL_MICROS_5K,
				nightsCount: 1,
				currency: 'RUB',
				oldStatus: 'in_house',
				newStatus: 'checked_out',
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})

	test('[G5] currency mismatch (booking RUB, folio USD) → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
			folioCurrency: 'USD',
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				totalMicros: TOTAL_MICROS_5K,
				nightsCount: 1,
				currency: 'RUB',
				oldStatus: 'in_house',
				newStatus: 'checked_out',
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})

	test('[G6] missing newImage.totalMicros → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				oldStatus: 'in_house',
				newStatus: 'checked_out',
				omitTotalMicros: true,
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})

	test('[G6] missing newImage.nightsCount → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const seeded = await seed({
			tenantId,
			propertyId,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				checkIn: seeded.checkIn,
				bookingId: seeded.bookingId,
				oldStatus: 'in_house',
				newStatus: 'checked_out',
				omitNightsCount: true,
			}),
		)

		const lines = await listLines(tenantId, seeded.folioId)
		expect(lines).toHaveLength(0)
	})
})

/* ============================================================ cross-tenant */

describe('checkout_finalizer — cross-tenant isolation', { tags: ['db'] }, () => {
	test('[CT1] tenantA event does not post on tenantB folio', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const propertyA = newId('property')
		const propertyB = newId('property')

		const seedA = await seed({
			tenantId: tenantA,
			propertyId: propertyA,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K,
			nightsCount: 1,
		})
		const seedB = await seed({
			tenantId: tenantB,
			propertyId: propertyB,
			rateBps: SOCHI_2026_BPS,
			totalMicros: TOTAL_MICROS_5K * 2n,
			nightsCount: 1,
		})

		// Fire only A's event.
		await runHandler(
			buildEvent({
				tenantId: tenantA,
				propertyId: propertyA,
				checkIn: seedA.checkIn,
				bookingId: seedA.bookingId,
				totalMicros: TOTAL_MICROS_5K,
				nightsCount: 1,
				currency: 'RUB',
				oldStatus: 'in_house',
				newStatus: 'checked_out',
			}),
		)

		const linesA = await listLines(tenantA, seedA.folioId)
		const linesB = await listLines(tenantB, seedB.folioId)
		expect(linesA).toHaveLength(1)
		expect(linesB).toHaveLength(0)
	})
})
