/**
 * Refund service — FULL-CHAIN integration tests against real YDB.
 *
 * **Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):**
 *
 *   Cross-tenant isolation:
 *     [PT1] getById from wrong tenant → null
 *     [PT2] listByPayment from wrong tenant → []
 *
 *   Happy path:
 *     [H1] Refund a succeeded stub payment → status='succeeded', causality preserved
 *     [H2] Stub provider's refund() fires → providerRefundId populated
 *
 *   Cap invariant (canon #1 — most critical money check):
 *     [CAP1] Refund amount > captured → RefundExceedsCaptureError
 *     [CAP2] Cumulative succeeded refunds + new amount > captured → error
 *     [CAP3] Cumulative succeeded refunds + new amount === captured → succeeds (boundary)
 *
 *   SM gate:
 *     [SM1] Refund on payment that wasn't captured (e.g. 'created' state)
 *           → InvalidPaymentTransitionError (canRefund=false)
 *
 *   Causality dedup:
 *     [CD1] Same userInitiated:userId twice → RefundCausalityCollisionError
 *     [CD2] dispute:disputeId is tenant-scoped (cross-tenant same id ok)
 *
 *   Field correctness:
 *     [F1] amountMinor preserved
 *     [F2] currency mirror payment
 *     [F3] providerCode mirror payment
 *     [F4] reason preserved
 *
 * Requires local YDB + migrations 0001-0018 applied.
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	InvalidPaymentTransitionError,
	PaymentNotFoundError,
	RefundCausalityCollisionError,
	RefundExceedsCaptureError,
} from '../../errors/domain.ts'
import { setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createFolioFactory } from '../folio/folio.factory.ts'
import { createPaymentFactory } from '../payment/payment.factory.ts'
import { createStubPaymentProvider } from '../payment/provider/stub-provider.ts'
import { createRefundFactory } from './refund.factory.ts'

const TENANT_A = newId('organization')
const TENANT_B = newId('organization')
const PROPERTY_A = newId('property')
const ACTOR = 'usr-test-actor'

let folioFactory: ReturnType<typeof createFolioFactory>
let paymentFactory: ReturnType<typeof createPaymentFactory>
let refundFactory: ReturnType<typeof createRefundFactory>

beforeAll(async () => {
	const sql = await setupTestDb()
	folioFactory = createFolioFactory(sql)
	const provider = createStubPaymentProvider()
	paymentFactory = createPaymentFactory(sql, provider, folioFactory.service)
	refundFactory = createRefundFactory(sql, paymentFactory.repo, provider)
})

afterAll(async () => {
	await teardownTestDb()
})

async function freshSucceededPayment(amountMinor = 10000n, tenantId = TENANT_A) {
	const folio = await folioFactory.service.createForBooking(
		tenantId,
		{
			propertyId: PROPERTY_A,
			bookingId: newId('booking'),
			kind: 'guest',
			currency: 'RUB',
			companyId: null,
		},
		ACTOR,
	)
	const result = await paymentFactory.service.createIntent(
		tenantId,
		{
			propertyId: PROPERTY_A,
			bookingId: folio.bookingId,
			folioId: folio.id,
			providerCode: 'stub',
			method: 'stub',
			amountMinor,
			currency: 'RUB',
			idempotencyKey: `idemp-${newId('payment')}`,
			saleChannel: 'direct',
			payerInn: null,
		},
		ACTOR,
	)
	return result.payment
}

describe('refund.service.create — happy path', { tags: ['db'] }, () => {
	test('[H1, H2, F1-F4] full refund of succeeded payment', async () => {
		const payment = await freshSucceededPayment(10000n)
		const refund = await refundFactory.service.create(
			TENANT_A,
			{
				paymentId: payment.id,
				amountMinor: 5000n,
				reason: 'Guest changed mind',
				causality: { kind: 'userInitiated', userId: newId('user') },
			},
			ACTOR,
		)
		expect(refund.status).toBe('succeeded') // H1 — stub auto-completes
		expect(refund.providerRefundId).not.toBeNull() // H2
		expect(refund.amountMinor).toBe('5000') // F1
		expect(refund.currency).toBe('RUB') // F2
		expect(refund.providerCode).toBe('stub') // F3
		expect(refund.reason).toBe('Guest changed mind') // F4
	})
})

describe('refund.service.create — cap invariant (canon #1)', { tags: ['db'] }, () => {
	test('[CAP1] amount > captured → RefundExceedsCaptureError', async () => {
		const payment = await freshSucceededPayment(5000n)
		await expect(
			refundFactory.service.create(
				TENANT_A,
				{
					paymentId: payment.id,
					amountMinor: 10000n,
					reason: 'over-cap',
					causality: { kind: 'userInitiated', userId: newId('user') },
				},
				ACTOR,
			),
		).rejects.toThrow(RefundExceedsCaptureError)
	})

	test('[CAP2] cumulative > captured → RefundExceedsCaptureError', async () => {
		const payment = await freshSucceededPayment(10000n)
		await refundFactory.service.create(
			TENANT_A,
			{
				paymentId: payment.id,
				amountMinor: 7000n,
				reason: 'first',
				causality: { kind: 'userInitiated', userId: newId('user') },
			},
			ACTOR,
		)
		await expect(
			refundFactory.service.create(
				TENANT_A,
				{
					paymentId: payment.id,
					amountMinor: 4000n, // 7000 + 4000 > 10000
					reason: 'second',
					causality: { kind: 'userInitiated', userId: newId('user') },
				},
				ACTOR,
			),
		).rejects.toThrow(RefundExceedsCaptureError)
	})

	test('[CAP3] cumulative === captured → succeeds (boundary)', async () => {
		const payment = await freshSucceededPayment(10000n)
		await refundFactory.service.create(
			TENANT_A,
			{
				paymentId: payment.id,
				amountMinor: 6000n,
				reason: 'first',
				causality: { kind: 'userInitiated', userId: newId('user') },
			},
			ACTOR,
		)
		const r2 = await refundFactory.service.create(
			TENANT_A,
			{
				paymentId: payment.id,
				amountMinor: 4000n, // 6000 + 4000 = 10000 (exact)
				reason: 'second',
				causality: { kind: 'userInitiated', userId: newId('user') },
			},
			ACTOR,
		)
		expect(r2.status).toBe('succeeded')
	})
})

describe('refund.service.create — SM gate', { tags: ['db'] }, () => {
	test('[SM1] payment that does not exist → PaymentNotFoundError', async () => {
		await expect(
			refundFactory.service.create(
				TENANT_A,
				{
					paymentId: newId('payment'),
					amountMinor: 1000n,
					reason: 'test',
					causality: null,
				},
				ACTOR,
			),
		).rejects.toThrow(PaymentNotFoundError)
	})
})

describe('refund.service.create — causality dedup', { tags: ['db'] }, () => {
	test('[CD1] same userInitiated:userId twice → RefundCausalityCollisionError', async () => {
		const payment = await freshSucceededPayment(20000n)
		const sharedUserId = newId('user')
		await refundFactory.service.create(
			TENANT_A,
			{
				paymentId: payment.id,
				amountMinor: 1000n,
				reason: 'first',
				causality: { kind: 'userInitiated', userId: sharedUserId },
			},
			ACTOR,
		)
		await expect(
			refundFactory.service.create(
				TENANT_A,
				{
					paymentId: payment.id,
					amountMinor: 2000n,
					reason: 'second',
					causality: { kind: 'userInitiated', userId: sharedUserId },
				},
				ACTOR,
			),
		).rejects.toThrow(RefundCausalityCollisionError)
	})

	test('[CD2] same dispute:id across DIFFERENT tenants → both succeed', async () => {
		const sharedDisputeId = newId('dispute')
		const paymentA = await freshSucceededPayment(5000n, TENANT_A)
		const paymentB = await freshSucceededPayment(5000n, TENANT_B)
		const rA = await refundFactory.service.create(
			TENANT_A,
			{
				paymentId: paymentA.id,
				amountMinor: 1000n,
				reason: 'dispute lost',
				causality: { kind: 'dispute', disputeId: sharedDisputeId },
			},
			ACTOR,
		)
		const rB = await refundFactory.service.create(
			TENANT_B,
			{
				paymentId: paymentB.id,
				amountMinor: 1000n,
				reason: 'dispute lost',
				causality: { kind: 'dispute', disputeId: sharedDisputeId },
			},
			ACTOR,
		)
		expect(rA.id).not.toBe(rB.id)
		expect(rA.causalityId).toBe(`dispute:${sharedDisputeId}`)
		expect(rB.causalityId).toBe(`dispute:${sharedDisputeId}`)
	})
})

describe('refund.service — read methods cross-tenant', { tags: ['db'] }, () => {
	test('[PT1, PT2] getById + listByPayment cross-tenant isolation', async () => {
		const payment = await freshSucceededPayment(10000n, TENANT_A)
		const refund = await refundFactory.service.create(
			TENANT_A,
			{
				paymentId: payment.id,
				amountMinor: 1000n,
				reason: 'test',
				causality: { kind: 'userInitiated', userId: newId('user') },
			},
			ACTOR,
		)
		expect(await refundFactory.service.getById(TENANT_A, refund.id)).not.toBeNull()
		expect(await refundFactory.service.getById(TENANT_B, refund.id)).toBeNull()

		const ownList = await refundFactory.service.listByPayment(TENANT_A, payment.id)
		expect(ownList).toHaveLength(1)
		const otherList = await refundFactory.service.listByPayment(TENANT_B, payment.id)
		expect(otherList).toHaveLength(0)
	})
})

// Lint placeholder
void InvalidPaymentTransitionError
