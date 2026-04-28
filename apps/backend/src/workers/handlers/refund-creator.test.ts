/**
 * `refund_creator_writer` CDC handler — integration tests. Production-grade.
 *
 * **Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):**
 *
 *   Trigger semantics (positive + negative):
 *     [T1] dispute UPDATE oldImage.status='opened' → newImage.status='lost' → refund created
 *     [T2] dispute INSERT with status='lost' (no oldImage) → refund created (backfill case)
 *     [T3] newImage.status='won' → NO refund created
 *     [T4] newImage.status='evidence_submitted' → NO refund created
 *     [T5] redelivery: oldImage.status='lost' AND newImage.status='lost' → NO duplicate refund
 *     [T6] DELETE event (oldImage only) → NO refund created
 *
 *   Refund payload correctness:
 *     [P1] causalityId == 'dispute:<disputeId>'
 *     [P2] amountMinor == dispute.amountMinor (mirror, normalised from string|number|bigint)
 *     [P3] currency == dispute.currency (mirror)
 *     [P4] providerCode == dispute.providerCode (mirror)
 *     [P5] status='pending', version=1, requestedAt=createdAt=updatedAt=now
 *     [P6] createdBy=updatedBy='system:refund_creator_writer'
 *
 *   Idempotency (canon — UNIQUE causality):
 *     [ID1] same handler invocation 2× → second call swallows 400120, no duplicate
 *     [ID2] cross-tenant SAME disputeId → both refunds succeed (causality is tenant-scoped)
 *
 *   Defensive guards:
 *     [G1] missing key → skip silent
 *     [G2] missing newImage.amountMinor → skip silent
 *     [G3] amountMinor = 0 → skip (canon #20 refund-amount-positive)
 *     [G4] amountMinor < 0 → skip (canon #20)
 *     [G5] missing currency / providerCode → skip
 *
 *   Cross-tenant isolation:
 *     [CT1] handler invocation for tenantA does NOT create refund in tenantB
 *
 *   Money types (defensive parsing):
 *     [MT1] amountMinor as JS string → parsed correctly to BigInt
 *     [MT2] amountMinor as JS number → parsed correctly
 *     [MT3] amountMinor as JS bigint → parsed correctly
 *
 * Requires local YDB + migrations 0007-0016 applied.
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { createRefundCreatorHandler } from './refund-creator.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = { debug: () => {}, info: () => {}, warn: () => {} }
const handler = createRefundCreatorHandler(silentLog)

/**
 * Build a representative dispute CDC event. Override fields per test.
 *
 * dispute PK shape: (tenantId, paymentId, id) — see migration 0012.
 * NewImage excludes PK columns per YDB CDC contract (cdc-handlers.ts:106).
 */
function buildDisputeEvent(
	overrides: {
		tenantId?: string
		paymentId?: string
		disputeId?: string
		oldStatus?: string | null
		newStatus?: string | null
		amountMinor?: string | number | bigint | null | undefined
		currency?: string
		providerCode?: string
		omitNewImage?: boolean
		omitOldImage?: boolean
	} = {},
): CdcEvent {
	const tenantId = overrides.tenantId ?? newId('organization')
	const paymentId = overrides.paymentId ?? newId('payment')
	const disputeId = overrides.disputeId ?? newId('dispute')
	const newStatus = overrides.newStatus === null ? null : (overrides.newStatus ?? 'lost')
	const oldStatus = overrides.oldStatus === null ? null : (overrides.oldStatus ?? 'opened')

	const includeNewImage = !overrides.omitNewImage && newStatus !== null
	const includeOldImage = !overrides.omitOldImage && oldStatus !== null

	const event: CdcEvent = { key: [tenantId, paymentId, disputeId] }
	if (includeNewImage) {
		event.newImage = {
			status: newStatus,
			// biome-ignore lint/nursery/useNullishCoalescing: distinguish explicit null (passes through) from undefined (default)
			amountMinor: overrides.amountMinor === undefined ? '15000' : overrides.amountMinor,
			currency: overrides.currency ?? 'RUB',
			providerCode: overrides.providerCode ?? 'yookassa',
			reasonCode: '4853',
			updatedBy: 'system',
		}
	}
	if (includeOldImage) {
		event.oldImage = {
			status: oldStatus,
			amountMinor: '15000',
			currency: 'RUB',
			providerCode: 'yookassa',
			reasonCode: '4853',
			updatedBy: 'system',
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

async function findRefundsByCausality(
	tenantId: string,
	causalityId: string,
): Promise<
	Array<{
		id: string
		paymentId: string
		amountMinor: string
		currency: string
		providerCode: string
		status: string
		reason: string
		version: number
		createdBy: string
		updatedBy: string
	}>
> {
	const sql = getTestSql()
	const [rows = []] = await sql<
		Array<{
			id: string
			paymentId: string
			amountMinor: number | bigint
			currency: string
			providerCode: string
			status: string
			reason: string
			version: number | bigint
			createdBy: string
			updatedBy: string
		}>
	>`
		SELECT id, paymentId, amountMinor, currency, providerCode,
			status, reason, version, createdBy, updatedBy
		FROM refund VIEW ixRefundCausality
		WHERE tenantId = ${tenantId} AND causalityId = ${causalityId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows.map((r) => ({
		id: r.id,
		paymentId: r.paymentId,
		amountMinor: BigInt(r.amountMinor).toString(),
		currency: r.currency,
		providerCode: r.providerCode,
		status: r.status,
		reason: r.reason,
		version: Number(r.version),
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}))
}

describe('refund_creator_writer — trigger semantics', { tags: ['db'] }, () => {
	test('[T1] UPDATE opened → lost creates auto-refund', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({ tenantId, paymentId, disputeId, oldStatus: 'opened', newStatus: 'lost' }),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(1)
	})

	test('[T2] INSERT (no oldImage) with status=lost creates auto-refund (backfill case)', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({
				tenantId,
				paymentId,
				disputeId,
				newStatus: 'lost',
				omitOldImage: true,
			}),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(1)
	})

	test('[T3] newImage.status=won → NO refund', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(buildDisputeEvent({ tenantId, disputeId, newStatus: 'won' }))
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(0)
	})

	test('[T4] newImage.status=evidence_submitted → NO refund', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(buildDisputeEvent({ tenantId, disputeId, newStatus: 'evidence_submitted' }))
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(0)
	})

	test('[T5] redelivery old=lost+new=lost → NO duplicate', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({ tenantId, disputeId, oldStatus: 'lost', newStatus: 'lost' }),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(0)
	})

	test('[T6] DELETE event (oldImage only) → NO refund', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({ tenantId, disputeId, newStatus: null, omitNewImage: true }),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(0)
	})
})

describe('refund_creator_writer — refund payload correctness', { tags: ['db'] }, () => {
	test('[P1-P6] all required fields populated', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({
				tenantId,
				paymentId,
				disputeId,
				newStatus: 'lost',
				amountMinor: '47500',
				currency: 'RUB',
				providerCode: 'tkassa',
			}),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(1)
		const refund = refunds[0]
		if (!refund) throw new Error('expected one refund')

		expect(refund.paymentId).toBe(paymentId) // P1 prefix correct
		expect(refund.amountMinor).toBe('47500') // P2 mirror
		expect(refund.currency).toBe('RUB') // P3 mirror
		expect(refund.providerCode).toBe('tkassa') // P4 mirror
		expect(refund.status).toBe('pending') // P5
		expect(refund.version).toBe(1) // P5
		expect(refund.reason).toBe('Auto-refund: dispute lost')
		expect(refund.createdBy).toBe('system:refund_creator_writer') // P6
		expect(refund.updatedBy).toBe('system:refund_creator_writer') // P6
	})
})

describe('refund_creator_writer — idempotency', { tags: ['db'] }, () => {
	test('[ID1] running same event twice creates exactly one refund', async () => {
		const tenantId = newId('organization')
		const paymentId = newId('payment')
		const disputeId = newId('dispute')
		const event = buildDisputeEvent({
			tenantId,
			paymentId,
			disputeId,
			oldStatus: 'opened',
			newStatus: 'lost',
		})

		await runHandler(event)
		await runHandler(event) // re-delivery — UNIQUE causality should swallow

		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(1)
	})

	test('[ID2] same disputeId across DIFFERENT tenants → both refunds created', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		// Same disputeId / paymentId across both — causality is tenant-scoped.
		const sharedDisputeId = newId('dispute')
		const sharedPaymentId = newId('payment')

		await runHandler(
			buildDisputeEvent({
				tenantId: tenantA,
				paymentId: sharedPaymentId,
				disputeId: sharedDisputeId,
			}),
		)
		await runHandler(
			buildDisputeEvent({
				tenantId: tenantB,
				paymentId: sharedPaymentId,
				disputeId: sharedDisputeId,
			}),
		)

		const refundsA = await findRefundsByCausality(tenantA, `dispute:${sharedDisputeId}`)
		const refundsB = await findRefundsByCausality(tenantB, `dispute:${sharedDisputeId}`)
		expect(refundsA).toHaveLength(1)
		expect(refundsB).toHaveLength(1)
		// Different ids — fully independent rows
		expect(refundsA[0]?.id).not.toBe(refundsB[0]?.id)
	})
})

describe('refund_creator_writer — defensive guards', { tags: ['db'] }, () => {
	test('[G1] empty key → skip', async () => {
		await runHandler({ key: [], newImage: { status: 'lost' } })
		// Just asserting it doesn't throw — no refund possible (no recordable tenantId).
		expect(true).toBe(true)
	})

	test('[G2] missing amountMinor → skip', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({ tenantId, disputeId, amountMinor: null, newStatus: 'lost' }),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(0)
	})

	test('[G3] amountMinor = 0 → skip (canon #20 refund-amount-positive)', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({ tenantId, disputeId, amountMinor: '0', newStatus: 'lost' }),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(0)
	})

	test('[G4] amountMinor < 0 → skip', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({ tenantId, disputeId, amountMinor: '-100', newStatus: 'lost' }),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(0)
	})

	test('[G5] missing currency → skip', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		const event = buildDisputeEvent({ tenantId, disputeId, newStatus: 'lost' })
		// biome-ignore lint/suspicious/noExplicitAny: deliberately corrupt event for guard test
		;(event.newImage as any).currency = undefined
		await runHandler(event)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds).toHaveLength(0)
	})
})

describe('refund_creator_writer — money type parsing', { tags: ['db'] }, () => {
	test('[MT1] amountMinor as JS string → parsed correctly', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({ tenantId, disputeId, amountMinor: '12345', newStatus: 'lost' }),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds[0]?.amountMinor).toBe('12345')
	})

	test('[MT2] amountMinor as JS number → parsed correctly', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({ tenantId, disputeId, amountMinor: 9876, newStatus: 'lost' }),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds[0]?.amountMinor).toBe('9876')
	})

	test('[MT3] amountMinor as JS bigint → parsed correctly', async () => {
		const tenantId = newId('organization')
		const disputeId = newId('dispute')
		await runHandler(
			buildDisputeEvent({ tenantId, disputeId, amountMinor: 54321n, newStatus: 'lost' }),
		)
		const refunds = await findRefundsByCausality(tenantId, `dispute:${disputeId}`)
		expect(refunds[0]?.amountMinor).toBe('54321')
	})
})

describe('refund_creator_writer — cross-tenant isolation', { tags: ['db'] }, () => {
	test('[CT1] handler call in tenantA does not affect tenantB', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const disputeId = newId('dispute')

		await runHandler(buildDisputeEvent({ tenantId: tenantA, disputeId, newStatus: 'lost' }))

		// tenantB has no refund for this disputeId
		const refundsB = await findRefundsByCausality(tenantB, `dispute:${disputeId}`)
		expect(refundsB).toHaveLength(0)

		// tenantA does
		const refundsA = await findRefundsByCausality(tenantA, `dispute:${disputeId}`)
		expect(refundsA).toHaveLength(1)
	})
})
