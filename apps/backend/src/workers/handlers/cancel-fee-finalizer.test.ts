/**
 * `cancel_fee_writer` CDC handler — integration tests against real YDB.
 *
 * **Pre-done audit checklist (`feedback_pre_done_audit.md`):**
 *
 *   Trigger semantics:
 *     [T1] in_house → cancelled WITH cancellationFee → posts cancellationFee
 *     [T2] confirmed → no_show WITH noShowFee → posts noShowFee
 *     [T3] confirmed → cancelled WITH NULL cancellationFee → no post
 *     [T4] confirmed → cancelled WITH 0n amountMicros → no post
 *     [T5] cancelled → cancelled (already terminal, status flap) → no post
 *     [T6] confirmed → checked_out → no post (handler is for cancel/no_show only)
 *     [T7] INSERT (no oldImage) → no post
 *     [T8] DELETE (no newImage) → no post
 *
 *   Payload + balance:
 *     [P1] cancellationFee line shape: category='cancellationFee', deterministic id
 *     [P2] noShowFee line shape: category='noShowFee', deterministic id
 *     [P3] amountMinor = amountMicros / 10_000
 *     [P4] folio.balanceMinor bumped, version incremented
 *
 *   Idempotency:
 *     [ID1] same cancel event twice → ONE line, balance once
 *     [ID2] cancellationFee + later noShowFee on same booking → 2 distinct lines
 *           (impossible per SM but exercises separate ids)
 *
 *   Defensive guards:
 *     [G1] no folio for booking → skip
 *     [G2] folio.status='closed' → skip
 *     [G3] currency mismatch → skip
 *     [G4] missing booking.currency in newImage → skip
 *
 *   Cross-tenant:
 *     [CT1] tenantA event does NOT touch tenantB folio
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NULL_TEXT, NULL_TIMESTAMP, toTs } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { createCancelFeeFinalizerHandler } from './cancel-fee-finalizer.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = { debug: () => {}, info: () => {}, warn: () => {} }
const handler = createCancelFeeFinalizerHandler(silentLog)

interface SeedOpts {
	tenantId: string
	propertyId: string
	bookingId?: string
	folioId?: string
	folioStatus?: 'open' | 'closed'
	folioCurrency?: string
	skipFolio?: boolean
}

async function seedFolio(opts: SeedOpts) {
	const sql = getTestSql()
	const bookingId = opts.bookingId ?? newId('booking')
	const folioId = opts.folioId ?? newId('folio')
	const folioStatus = opts.folioStatus ?? 'open'
	const folioCurrency = opts.folioCurrency ?? 'RUB'
	const now = new Date()
	const nowTs = toTs(now)

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

	return { bookingId, folioId }
}

interface BuildEventArgs {
	tenantId: string
	propertyId: string
	checkIn?: string
	bookingId: string
	oldStatus?: string
	newStatus?: string
	cancellationFee?: { amountMicros: bigint | string; policyCode?: string } | null
	noShowFee?: { amountMicros: bigint | string; policyCode?: string } | null
	currency?: string | null
	omitOldImage?: boolean
	omitNewImage?: boolean
}

function buildEvent(args: BuildEventArgs): CdcEvent {
	const event: CdcEvent = {
		key: [args.tenantId, args.propertyId, args.checkIn ?? '2026-04-25', args.bookingId],
	}
	if (!args.omitOldImage) {
		event.oldImage = { status: args.oldStatus ?? 'confirmed' }
	}
	if (!args.omitNewImage) {
		const newImage: Record<string, unknown> = { status: args.newStatus ?? 'cancelled' }
		if (args.currency !== null) newImage.currency = args.currency ?? 'RUB'
		if (args.cancellationFee !== undefined) {
			newImage.cancellationFee =
				args.cancellationFee === null
					? null
					: {
							amountMicros: String(args.cancellationFee.amountMicros),
							policyCode: args.cancellationFee.policyCode ?? 'BAR-NR',
						}
		}
		if (args.noShowFee !== undefined) {
			newImage.noShowFee =
				args.noShowFee === null
					? null
					: {
							amountMicros: String(args.noShowFee.amountMicros),
							policyCode: args.noShowFee.policyCode ?? 'BAR-NR',
						}
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
		{
			id: string
			category: string
			amountMinor: number | bigint
			lineStatus: string
			createdBy: string
		}[]
	>`
		SELECT id, category, amountMinor, lineStatus, createdBy
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
		lineStatus: r.lineStatus,
		createdBy: r.createdBy,
	}))
}

const FEE_MICROS = 5_000_000_000n // 5000 ₽
const FEE_MINOR = 500_000n

/* ============================================================ trigger semantics */

describe('cancel_fee_writer — trigger semantics', { tags: ['db'] }, () => {
	test('[T1] in_house → cancelled WITH fee → posts cancellationFee', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'in_house',
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: FEE_MICROS, policyCode: 'BAR-NR' },
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(1)
		expect(lines[0]?.category).toBe('cancellationFee')
		expect(lines[0]?.id).toBe(`cancelFee_${bookingId}`)
		expect(lines[0]?.amountMinor).toBe(FEE_MINOR.toString())
		expect(lines[0]?.createdBy).toBe('system:cancel_fee_writer')
	})

	test('[T2] confirmed → no_show WITH fee → posts noShowFee', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'confirmed',
				newStatus: 'no_show',
				noShowFee: { amountMicros: FEE_MICROS, policyCode: 'BAR-NR' },
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(1)
		expect(lines[0]?.category).toBe('noShowFee')
		expect(lines[0]?.id).toBe(`noShowFee_${bookingId}`)
		expect(lines[0]?.amountMinor).toBe(FEE_MINOR.toString())
	})

	test('[T3] cancelled WITH NULL cancellationFee → no post (BAR-flex)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'confirmed',
				newStatus: 'cancelled',
				cancellationFee: null,
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(0)
	})

	test('[T4] cancelled WITH 0n amountMicros → no post (zero fee)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'confirmed',
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: 0n },
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(0)
	})

	test('[T5] cancelled → cancelled (status flap, no transition INTO) → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'cancelled',
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: FEE_MICROS },
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(0)
	})

	test('[T6] checked_out → no post (handler scope: cancel + no_show only)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'in_house',
				newStatus: 'checked_out',
				cancellationFee: { amountMicros: FEE_MICROS },
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(0)
	})

	test('[T7] INSERT (no oldImage) → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: FEE_MICROS },
				omitOldImage: true,
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(0)
	})

	test('[T8] DELETE (no newImage) → no post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'cancelled',
				omitNewImage: true,
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(0)
	})
})

/* ============================================================ payload + balance */

describe('cancel_fee_writer — payload + balance', { tags: ['db'] }, () => {
	test('[P3-P4] balance bumped, version incremented', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'confirmed',
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: FEE_MICROS },
			}),
		)

		const folio = await getFolio(tenantId, folioId)
		expect(folio?.balanceMinor).toBe(FEE_MINOR.toString())
		expect(folio?.version).toBe(2)
	})
})

/* ============================================================ idempotency */

describe('cancel_fee_writer — idempotency', { tags: ['db'] }, () => {
	test('[ID1] same cancel event 3× → ONE line, balance once', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		const event = buildEvent({
			tenantId,
			propertyId,
			bookingId,
			oldStatus: 'in_house',
			newStatus: 'cancelled',
			cancellationFee: { amountMicros: FEE_MICROS },
		})
		await runHandler(event)
		await runHandler(event)
		await runHandler(event)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(1)
		const folio = await getFolio(tenantId, folioId)
		expect(folio?.balanceMinor).toBe(FEE_MINOR.toString())
		expect(folio?.version).toBe(2)
	})
})

/* ============================================================ defensive guards */

describe('cancel_fee_writer — defensive guards', { tags: ['db'] }, () => {
	test('[G1] no folio for booking → skip (no error)', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const bookingId = newId('booking')

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'confirmed',
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: FEE_MICROS },
			}),
		)
		// Verify no folio created.
		const sql = getTestSql()
		const [rows = []] = await sql<{ x: number }[]>`
			SELECT 1 AS x FROM folio VIEW ixFolioBooking
			WHERE tenantId = ${tenantId} AND bookingId = ${bookingId}
		`
		expect(rows).toHaveLength(0)
	})

	test('[G2] folio.status=closed → skip post', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({
			tenantId,
			propertyId,
			folioStatus: 'closed',
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'in_house',
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: FEE_MICROS },
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(0)
	})

	test('[G3] currency mismatch (booking RUB, folio USD) → skip', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({
			tenantId,
			propertyId,
			folioCurrency: 'USD',
		})

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'confirmed',
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: FEE_MICROS },
				currency: 'RUB',
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(0)
	})

	test('[G4] missing booking.currency in newImage → skip', async () => {
		const tenantId = newId('organization')
		const propertyId = newId('property')
		const { bookingId, folioId } = await seedFolio({ tenantId, propertyId })

		await runHandler(
			buildEvent({
				tenantId,
				propertyId,
				bookingId,
				oldStatus: 'confirmed',
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: FEE_MICROS },
				currency: null,
			}),
		)

		const lines = await listLines(tenantId, folioId)
		expect(lines).toHaveLength(0)
	})
})

/* ============================================================ cross-tenant */

describe('cancel_fee_writer — cross-tenant isolation', { tags: ['db'] }, () => {
	test('[CT1] tenantA event does NOT post on tenantB folio', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const propertyA = newId('property')
		const propertyB = newId('property')

		const { bookingId: bookingA, folioId: folioA } = await seedFolio({
			tenantId: tenantA,
			propertyId: propertyA,
		})
		const { folioId: folioB } = await seedFolio({
			tenantId: tenantB,
			propertyId: propertyB,
		})

		await runHandler(
			buildEvent({
				tenantId: tenantA,
				propertyId: propertyA,
				bookingId: bookingA,
				oldStatus: 'confirmed',
				newStatus: 'cancelled',
				cancellationFee: { amountMicros: FEE_MICROS },
			}),
		)

		expect(await listLines(tenantA, folioA)).toHaveLength(1)
		expect(await listLines(tenantB, folioB)).toHaveLength(0)
	})
})
