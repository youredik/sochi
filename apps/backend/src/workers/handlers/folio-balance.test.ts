/**
 * `folio_balance_writer` CDC handler — integration tests. Production-grade.
 *
 * **Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):**
 *
 *   Source disambiguation:
 *     [S1] source='payment' → folioId from event.newImage.folioId
 *     [S2] source='refund' → folioId loaded from parent payment
 *     [S3] source='folio' → skip (would loop)
 *
 *   Trigger semantics:
 *     [T1] payment INSERT with folioId → recompute fires
 *     [T2] payment UPDATE → recompute fires
 *     [T3] DELETE event (no newImage) → skip
 *     [T4] payment event with folioId=null → skip
 *     [T5] payment event with folioId='' (empty string) → skip
 *     [T6] refund event whose parent payment has no folioId → skip
 *     [T7] folio not found in DB → skip + warn
 *
 *   Balance math (canon #12 folio-balance-conservation):
 *     [B1] charges only (no payments, no refunds) → balance = charges
 *     [B2] charges + succeeded payment → balance = charges - capturedMinor
 *     [B3] charges + payment + succeeded refund → balance = charges - paid + refunded
 *     [B4] payment with status='pending' (not applied) → not subtracted
 *     [B5] refund with status='pending' or 'failed' → not added
 *     [B6] voided folioLine NOT counted in charges
 *     [B7] draft folioLine NOT counted in charges
 *     [B8] full refund (refund == captured) → balance = charges (back to original)
 *
 *   Idempotency:
 *     [ID1] running same event twice → balance bumped only once (version+=1)
 *     [ID2] computed === current → no UPSERT (version unchanged)
 *
 *   Cross-tenant isolation:
 *     [CT1] payment event in tenantA does NOT touch tenantB folio
 *
 *   Field preservation:
 *     [I1] folio metadata (kind, currency, status, createdAt, createdBy)
 *          preserved across recompute
 *     [I2] updatedBy = 'system:folio_balance_writer'
 *     [I3] version exactly +1
 *
 * Requires local YDB + migrations 0007-0016 applied.
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NULL_FLOAT, NULL_TEXT, NULL_TIMESTAMP, toTs } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { createFolioBalanceHandler, type FolioBalanceSource } from './folio-balance.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = { debug: () => {}, info: () => {}, warn: () => {} }
const handlers: Record<FolioBalanceSource, ReturnType<typeof createFolioBalanceHandler>> = {
	payment: createFolioBalanceHandler(silentLog, 'payment'),
	refund: createFolioBalanceHandler(silentLog, 'refund'),
	folio: createFolioBalanceHandler(silentLog, 'folio'),
}

interface SeedFolioInput {
	tenantId: string
	propertyId: string
	bookingId: string
	folioId: string
	balanceMinor?: bigint
	status?: string
}

async function seedFolio(input: SeedFolioInput): Promise<void> {
	const sql = getTestSql()
	const now = new Date()
	const nowTs = toTs(now)
	await sql`
		UPSERT INTO folio (
			\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
			\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
			\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${input.tenantId}, ${input.propertyId}, ${input.bookingId}, ${input.folioId},
			${'guest'}, ${input.status ?? 'open'}, ${'RUB'}, ${input.balanceMinor ?? 0n}, ${1},
			${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT}, ${NULL_TEXT},
			${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
		)
	`
}

interface SeedFolioLineInput {
	tenantId: string
	folioId: string
	amountMinor: bigint
	lineStatus?: 'posted' | 'draft' | 'void'
	category?: string
}

async function seedFolioLine(input: SeedFolioLineInput): Promise<void> {
	const sql = getTestSql()
	const now = new Date()
	const nowTs = toTs(now)
	const lineId = newId('folioLine')
	const status = input.lineStatus ?? 'posted'
	const postedAt = status === 'posted' ? toTs(now) : NULL_TIMESTAMP
	const voidedAt = status === 'void' ? toTs(now) : NULL_TIMESTAMP
	const voidReason = status === 'void' ? 'test' : NULL_TEXT
	await sql`
		UPSERT INTO folioLine (
			\`tenantId\`, \`folioId\`, \`id\`,
			\`category\`, \`description\`, \`amountMinor\`,
			\`isAccommodationBase\`, \`taxRateBps\`,
			\`lineStatus\`, \`routingRuleId\`, \`postedAt\`, \`voidedAt\`, \`voidReason\`,
			\`version\`, \`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${input.tenantId}, ${input.folioId}, ${lineId},
			${input.category ?? 'misc'}, ${'test charge'}, ${input.amountMinor},
			${false}, ${0},
			${status}, ${NULL_TEXT}, ${postedAt}, ${voidedAt}, ${voidReason},
			${1}, ${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
		)
	`
}

interface SeedPaymentInput {
	tenantId: string
	propertyId: string
	bookingId: string
	paymentId: string
	folioId: string | null
	capturedMinor?: bigint
	status?: string
}

async function seedPayment(input: SeedPaymentInput): Promise<void> {
	const sql = getTestSql()
	const now = new Date()
	const nowTs = toTs(now)
	const captured = input.capturedMinor ?? 0n
	await sql`
		UPSERT INTO payment (
			\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
			\`folioId\`, \`providerCode\`, \`providerPaymentId\`, \`confirmationUrl\`, \`method\`,
			\`status\`, \`amountMinor\`, \`authorizedMinor\`, \`capturedMinor\`, \`currency\`,
			\`idempotencyKey\`, \`version\`,
			\`payerInn\`, \`saleChannel\`, \`anomalyScore\`, \`holdExpiresAt\`,
			\`createdAt\`, \`updatedAt\`,
			\`authorizedAt\`, \`capturedAt\`, \`refundedAt\`,
			\`canceledAt\`, \`failedAt\`, \`expiredAt\`,
			\`failureReason\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${input.tenantId}, ${input.propertyId}, ${input.bookingId}, ${input.paymentId},
			${input.folioId ?? NULL_TEXT}, ${'stub'}, ${NULL_TEXT}, ${NULL_TEXT}, ${'stub'},
			${input.status ?? 'succeeded'}, ${captured}, ${captured}, ${captured}, ${'RUB'},
			${`idemp-${input.paymentId}`}, ${1},
			${NULL_TEXT}, ${'direct'}, ${NULL_FLOAT}, ${NULL_TIMESTAMP},
			${nowTs}, ${nowTs},
			${nowTs}, ${nowTs}, ${NULL_TIMESTAMP},
			${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP},
			${NULL_TEXT}, ${'test-actor'}, ${'test-actor'}
		)
	`
}

interface SeedRefundInput {
	tenantId: string
	paymentId: string
	refundId: string
	amountMinor: bigint
	status?: string
	causalitySuffix?: string
}

async function seedRefund(input: SeedRefundInput): Promise<void> {
	const sql = getTestSql()
	const now = new Date()
	const nowTs = toTs(now)
	const causality = `userInitiated:${input.causalitySuffix ?? newId('user')}`
	const status = input.status ?? 'succeeded'
	const succeededAt = status === 'succeeded' ? toTs(now) : NULL_TIMESTAMP
	await sql`
		UPSERT INTO refund (
			\`tenantId\`, \`paymentId\`, \`id\`,
			\`providerCode\`, \`providerRefundId\`, \`causalityId\`,
			\`status\`, \`amountMinor\`, \`currency\`, \`reason\`, \`version\`,
			\`requestedAt\`, \`succeededAt\`, \`failedAt\`, \`failureReason\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${input.tenantId}, ${input.paymentId}, ${input.refundId},
			${'stub'}, ${NULL_TEXT}, ${causality},
			${status}, ${input.amountMinor}, ${'RUB'}, ${'test'}, ${1},
			${nowTs}, ${succeededAt}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
			${nowTs}, ${nowTs}, ${'test-actor'}, ${'test-actor'}
		)
	`
}

function buildPaymentEvent(args: {
	tenantId: string
	propertyId: string
	bookingId: string
	paymentId: string
	folioId: string | null | undefined
}): CdcEvent {
	return {
		key: [args.tenantId, args.propertyId, args.bookingId, args.paymentId],
		newImage: {
			folioId: args.folioId,
			status: 'succeeded',
			updatedBy: 'system',
		},
	}
}

function buildRefundEvent(args: {
	tenantId: string
	paymentId: string
	refundId: string
}): CdcEvent {
	return {
		key: [args.tenantId, args.paymentId, args.refundId],
		newImage: { status: 'succeeded', amountMinor: '5000', updatedBy: 'system' },
	}
}

async function runHandler(source: FolioBalanceSource, event: CdcEvent): Promise<void> {
	const sql = getTestSql()
	await sql.begin({ idempotent: true }, async (tx) => {
		await handlers[source](tx, event)
	})
}

async function getFolio(
	tenantId: string,
	folioId: string,
): Promise<{ balanceMinor: string; version: number; updatedBy: string } | null> {
	const sql = getTestSql()
	const [rows = []] = await sql<
		{ balanceMinor: number | bigint; version: number | bigint; updatedBy: string }[]
	>`SELECT balanceMinor, version, updatedBy FROM folio WHERE tenantId = ${tenantId} AND id = ${folioId}`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	const row = rows[0]
	if (!row) return null
	return {
		balanceMinor: BigInt(row.balanceMinor).toString(),
		version: Number(row.version),
		updatedBy: row.updatedBy,
	}
}

interface FullScenario {
	tenantId: string
	propertyId: string
	bookingId: string
	folioId: string
	paymentId: string
}

async function setupScenario(): Promise<FullScenario> {
	const tenantId = newId('organization')
	const propertyId = newId('property')
	const bookingId = newId('booking')
	const folioId = newId('folio')
	const paymentId = newId('payment')
	await seedFolio({ tenantId, propertyId, bookingId, folioId, balanceMinor: 0n })
	return { tenantId, propertyId, bookingId, folioId, paymentId }
}

describe('folio_balance_writer — source disambiguation', { tags: ['db'] }, () => {
	test('[S3] source=folio → skip (no recompute, no version bump)', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 7000n })
		await runHandler('folio', {
			key: [s.tenantId, s.propertyId, s.bookingId, s.folioId],
			newImage: { status: 'open', balanceMinor: '0', updatedBy: 'system' },
		})
		const folio = await getFolio(s.tenantId, s.folioId)
		expect(folio?.version).toBe(1) // unchanged
		expect(folio?.balanceMinor).toBe('0') // unchanged — folio source is no-op
	})
})

describe('folio_balance_writer — trigger semantics', { tags: ['db'] }, () => {
	test('[T3] DELETE event (no newImage) → skip', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 5000n })
		await runHandler('payment', {
			key: [s.tenantId, s.propertyId, s.bookingId, s.paymentId],
			oldImage: { folioId: s.folioId, updatedBy: 'system' },
		})
		const folio = await getFolio(s.tenantId, s.folioId)
		expect(folio?.version).toBe(1)
	})

	test('[T4] folioId=null → skip', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 5000n })
		await runHandler('payment', buildPaymentEvent({ ...s, folioId: null }))
		const folio = await getFolio(s.tenantId, s.folioId)
		expect(folio?.version).toBe(1)
	})

	test('[T5] folioId=empty string → skip', async () => {
		const s = await setupScenario()
		await runHandler('payment', buildPaymentEvent({ ...s, folioId: '' }))
		const folio = await getFolio(s.tenantId, s.folioId)
		expect(folio?.version).toBe(1)
	})

	test('[T6] refund event whose parent payment has no folioId → skip', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 5000n })
		await seedPayment({ ...s, folioId: null, capturedMinor: 5000n })
		const refundId = newId('refund')
		await seedRefund({ tenantId: s.tenantId, paymentId: s.paymentId, refundId, amountMinor: 1000n })
		await runHandler(
			'refund',
			buildRefundEvent({ tenantId: s.tenantId, paymentId: s.paymentId, refundId }),
		)
		const folio = await getFolio(s.tenantId, s.folioId)
		expect(folio?.version).toBe(1) // skipped because parent payment has no folioId
	})

	test('[T7] folio not found → skip + warn (no throw)', async () => {
		const tenantId = newId('organization')
		const folioId = newId('folio')
		// No folio seeded.
		await runHandler('payment', {
			key: [tenantId, newId('property'), newId('booking'), newId('payment')],
			newImage: { folioId, status: 'succeeded', updatedBy: 'system' },
		})
		// Just asserting no throw.
		expect(true).toBe(true)
	})
})

describe('folio_balance_writer — balance math (canon #12)', { tags: ['db'] }, () => {
	test('[B1] charges only → balance = charges', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 7500n })
		await seedPayment({ ...s, folioId: s.folioId, capturedMinor: 0n, status: 'pending' })
		await runHandler('payment', buildPaymentEvent({ ...s, folioId: s.folioId }))
		const folio = await getFolio(s.tenantId, s.folioId)
		// pending payment NOT counted; balance = charges - 0 + 0 = 7500
		expect(folio?.balanceMinor).toBe('7500')
	})

	test('[B2] charges + succeeded payment → balance = charges - captured', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 10000n })
		await seedPayment({ ...s, folioId: s.folioId, capturedMinor: 6000n, status: 'succeeded' })
		await runHandler('payment', buildPaymentEvent({ ...s, folioId: s.folioId }))
		const folio = await getFolio(s.tenantId, s.folioId)
		expect(folio?.balanceMinor).toBe('4000') // 10000 - 6000
	})

	test('[B3] charges + payment + succeeded refund → balance = charges - paid + refunded', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 10000n })
		await seedPayment({
			...s,
			folioId: s.folioId,
			capturedMinor: 8000n,
			status: 'partially_refunded',
		})
		const refundId = newId('refund')
		await seedRefund({ tenantId: s.tenantId, paymentId: s.paymentId, refundId, amountMinor: 3000n })
		await runHandler(
			'refund',
			buildRefundEvent({ tenantId: s.tenantId, paymentId: s.paymentId, refundId }),
		)
		const folio = await getFolio(s.tenantId, s.folioId)
		// 10000 - 8000 + 3000 = 5000
		expect(folio?.balanceMinor).toBe('5000')
	})

	test('[B5] pending refund NOT counted; failed refund NOT counted', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 10000n })
		await seedPayment({ ...s, folioId: s.folioId, capturedMinor: 10000n, status: 'succeeded' })
		// Two refunds: one pending, one failed → neither counts toward balance.
		await seedRefund({
			tenantId: s.tenantId,
			paymentId: s.paymentId,
			refundId: newId('refund'),
			amountMinor: 2000n,
			status: 'pending',
		})
		await seedRefund({
			tenantId: s.tenantId,
			paymentId: s.paymentId,
			refundId: newId('refund'),
			amountMinor: 1500n,
			status: 'failed',
		})
		await runHandler('payment', buildPaymentEvent({ ...s, folioId: s.folioId }))
		const folio = await getFolio(s.tenantId, s.folioId)
		// 10000 - 10000 + 0 (no succeeded refunds) = 0
		expect(folio?.balanceMinor).toBe('0')
	})

	test('[B6] voided folioLine NOT counted in charges', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 5000n }) // posted
		await seedFolioLine({
			tenantId: s.tenantId,
			folioId: s.folioId,
			amountMinor: 3000n,
			lineStatus: 'void',
		})
		await runHandler('payment', buildPaymentEvent({ ...s, folioId: s.folioId }))
		const folio = await getFolio(s.tenantId, s.folioId)
		expect(folio?.balanceMinor).toBe('5000') // void line excluded
	})

	test('[B7] draft folioLine NOT counted', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 5000n })
		await seedFolioLine({
			tenantId: s.tenantId,
			folioId: s.folioId,
			amountMinor: 7000n,
			lineStatus: 'draft',
		})
		await runHandler('payment', buildPaymentEvent({ ...s, folioId: s.folioId }))
		const folio = await getFolio(s.tenantId, s.folioId)
		expect(folio?.balanceMinor).toBe('5000') // draft excluded
	})

	test('[B8] full refund → balance back to charges', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 10000n })
		await seedPayment({ ...s, folioId: s.folioId, capturedMinor: 10000n, status: 'refunded' })
		await seedRefund({
			tenantId: s.tenantId,
			paymentId: s.paymentId,
			refundId: newId('refund'),
			amountMinor: 10000n,
		})
		await runHandler('payment', buildPaymentEvent({ ...s, folioId: s.folioId }))
		const folio = await getFolio(s.tenantId, s.folioId)
		// 10000 - 10000 + 10000 = 10000
		expect(folio?.balanceMinor).toBe('10000')
	})
})

describe('folio_balance_writer — idempotency', { tags: ['db'] }, () => {
	test('[ID1] same event twice → only one version bump', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 6000n })
		await seedPayment({ ...s, folioId: s.folioId, capturedMinor: 4000n, status: 'succeeded' })
		const event = buildPaymentEvent({ ...s, folioId: s.folioId })
		await runHandler('payment', event)
		await runHandler('payment', event)
		const folio = await getFolio(s.tenantId, s.folioId)
		expect(folio?.balanceMinor).toBe('2000')
		expect(folio?.version).toBe(2) // only one bump (from initial 1)
	})
})

describe('folio_balance_writer — cross-tenant isolation', { tags: ['db'] }, () => {
	test('[CT1] payment event in tenantA does not touch tenantB folio', async () => {
		const a = await setupScenario()
		const b = await setupScenario()
		await seedFolioLine({ tenantId: a.tenantId, folioId: a.folioId, amountMinor: 7000n })
		await seedFolioLine({ tenantId: b.tenantId, folioId: b.folioId, amountMinor: 7000n })
		await seedPayment({ ...a, folioId: a.folioId, capturedMinor: 5000n, status: 'succeeded' })
		await seedPayment({ ...b, folioId: b.folioId, capturedMinor: 5000n, status: 'succeeded' })
		await runHandler('payment', buildPaymentEvent({ ...a, folioId: a.folioId }))
		const folioA = await getFolio(a.tenantId, a.folioId)
		const folioB = await getFolio(b.tenantId, b.folioId)
		expect(folioA?.balanceMinor).toBe('2000') // recomputed
		expect(folioB?.balanceMinor).toBe('0') // untouched (initial seed)
		expect(folioB?.version).toBe(1) // untouched
	})
})

describe('folio_balance_writer — field preservation', { tags: ['db'] }, () => {
	test('[I1-I3] folio metadata preserved; updatedBy = system; version+1', async () => {
		const s = await setupScenario()
		await seedFolioLine({ tenantId: s.tenantId, folioId: s.folioId, amountMinor: 6000n })
		await seedPayment({ ...s, folioId: s.folioId, capturedMinor: 1000n, status: 'succeeded' })
		await runHandler('payment', buildPaymentEvent({ ...s, folioId: s.folioId }))

		const sql = getTestSql()
		const [rows = []] = await sql<
			Array<{
				kind: string
				currency: string
				status: string
				createdBy: string
				updatedBy: string
				version: number | bigint
			}>
		>`SELECT kind, currency, status, createdBy, updatedBy, version FROM folio WHERE tenantId=${s.tenantId} AND id=${s.folioId}`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		const row = rows[0]
		if (!row) throw new Error('expected folio row')
		expect(row.kind).toBe('guest')
		expect(row.currency).toBe('RUB')
		expect(row.status).toBe('open')
		expect(row.createdBy).toBe('test-actor')
		expect(row.updatedBy).toBe('system:folio_balance_writer')
		expect(Number(row.version)).toBe(2)
	})
})
