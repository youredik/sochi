/**
 * payment.service.applyWebhookEvent — strict isolation tests (B6, 2026-05-19).
 *
 * Canon regression guards for webhook event reordering per Q2 2026 research:
 *   - Service uses `snapshot.status` (event body) as ground truth, NOT
 *     sequence-derived status. Out-of-order events: each one independently
 *     calls applyTransition с event-body target. SM gate в repo.applyTransition
 *     decides valid/invalid (provider-aware).
 *   - Refund-subject events record audit only (refund-row creation = separate
 *     refund.service path); webhook handler delegates с typed discriminated
 *     union return.
 *   - Payment-not-found early-exit без calling applyTransition (saves work).
 *
 * Test-strategy: full mock seam at repo + provider boundary. NO YDB —
 * integration.db.test.ts covers full pipeline separately.
 */

import type { Payment, VerifiedWebhookEvent } from '@horeca/shared'
import { describe, expect, mock, test } from 'bun:test'
import type { FolioService } from '../folio/folio.service.ts'
import type { PaymentRepo } from './payment.repo.ts'
import { createPaymentService } from './payment.service.ts'

const TENANT = 'org_test'
const PAYMENT_ID = 'pay_test_001'
const PROVIDER_PAYMENT_ID = '2c9b4e8f-abcd-4000-9000-deadbeef0001'
const ACTOR = 'system'

const BASE_PAYMENT: Payment = {
	tenantId: TENANT,
	propertyId: 'prop_001',
	bookingId: 'book_001',
	id: PAYMENT_ID,
	folioId: null,
	providerCode: 'yookassa',
	providerPaymentId: PROVIDER_PAYMENT_ID,
	method: 'card',
	amountMinor: '10000',
	authorizedMinor: '10000',
	capturedMinor: '0',
	currency: 'RUB',
	status: 'pending',
	idempotencyKey: 'idem-1',
	version: 2,
	payerInn: null,
	saleChannel: 'direct',
	anomalyScore: null,
	holdExpiresAt: null,
	confirmationUrl: null,
	failureReason: null,
	createdAt: '2026-05-19T10:00:00.000Z',
	updatedAt: '2026-05-19T10:00:00.000Z',
	authorizedAt: null,
	capturedAt: null,
	refundedAt: null,
	canceledAt: null,
	failedAt: null,
	expiredAt: null,
	createdBy: ACTOR,
	updatedBy: ACTOR,
}

function paymentEvent(
	status: 'succeeded' | 'canceled' | 'waiting_for_capture',
): VerifiedWebhookEvent {
	return {
		dedupKey: `${PROVIDER_PAYMENT_ID}|payment.${status}|${status}|10000`,
		providerCode: 'yookassa',
		subject: {
			kind: 'payment',
			snapshot: {
				providerPaymentId: PROVIDER_PAYMENT_ID,
				status,
				authorizedMinor: 100_00n,
				capturedMinor: status === 'succeeded' ? 100_00n : 0n,
				confirmationUrl: null,
				holdExpiresAt: null,
				failureReason: null,
			},
		},
		receivedAt: '2026-05-19T10:01:00.000Z',
	}
}

function refundEvent(): VerifiedWebhookEvent {
	return {
		dedupKey: `${PROVIDER_PAYMENT_ID}|refund.succeeded|succeeded|5000`,
		providerCode: 'yookassa',
		subject: {
			kind: 'refund',
			refund: {
				providerRefundId: 'refund_test_001',
				status: 'succeeded',
				amountMinor: 50_00n,
				failureReason: null,
			},
			parentProviderPaymentId: PROVIDER_PAYMENT_ID,
		},
		receivedAt: '2026-05-19T10:02:00.000Z',
	}
}

function buildService(over?: {
	getByProviderId?: PaymentRepo['getByProviderId']
	applyTransition?: PaymentRepo['applyTransition']
}) {
	const getByProviderId = mock<PaymentRepo['getByProviderId']>(
		over?.getByProviderId ?? (async () => BASE_PAYMENT),
	)
	const applyTransition = mock<PaymentRepo['applyTransition']>(
		over?.applyTransition ??
			(async (_t, _id, _v, next) => ({
				...BASE_PAYMENT,
				status: next.status,
				version: BASE_PAYMENT.version + 1,
			})),
	)
	const repo = {
		getByProviderId,
		applyTransition,
	} as unknown as PaymentRepo
	const folioService = {} as unknown as FolioService
	const provider = {} as unknown as Parameters<typeof createPaymentService>[1]
	const service = createPaymentService(repo, provider, folioService)
	return { service, getByProviderId, applyTransition }
}

describe('payment.service.applyWebhookEvent — payment subject (B6 canon)', () => {
	test('ground-truth canon: event-body status flows к applyTransition target', async () => {
		// Out-of-order scenario: succeeded event arrives first. Service blindly
		// uses event-body status — repo.applyTransition decides valid (its SM
		// gate is authoritative, NOT service).
		const { service, applyTransition } = buildService()
		const result = await service.applyWebhookEvent(TENANT, paymentEvent('succeeded'), ACTOR)
		expect(result.kind).toBe('payment-transitioned')
		expect(applyTransition.mock.calls.length).toBe(1)
		const next = applyTransition.mock.calls[0]![3]
		expect(next.status).toBe('succeeded') // event-body target preserved
		expect(next.capturedMinor).toBe(100_00n)
	})

	test('out-of-order: waiting_for_capture after succeeded — service still calls applyTransition (SM authority delegated)', async () => {
		// Service trusts event ground truth; if SM gate rejects regression,
		// repo.applyTransition throws → caller (route) handles markFailed.
		const { service, applyTransition } = buildService({
			// Simulate already-succeeded state — repo.getByProviderId returns succeeded payment
			getByProviderId: mock(
				async () => ({ ...BASE_PAYMENT, status: 'succeeded' as const, version: 3 }) as Payment,
			),
			// applyTransition throws (simulating SM rejection)
			applyTransition: mock(async () => {
				throw new Error('Forbidden transition: succeeded → waiting_for_capture')
			}),
		})
		// Service propagates error — route handler catches + markFailed
		await expect(
			service.applyWebhookEvent(TENANT, paymentEvent('waiting_for_capture'), ACTOR),
		).rejects.toThrow(/Forbidden transition/)
		expect(applyTransition.mock.calls.length).toBe(1)
	})

	test('payment-not-found early-exit — no applyTransition call', async () => {
		const { service, applyTransition } = buildService({
			getByProviderId: mock(async () => null),
		})
		const result = await service.applyWebhookEvent(TENANT, paymentEvent('succeeded'), ACTOR)
		expect(result.kind).toBe('payment-not-found')
		if (result.kind === 'payment-not-found') {
			expect(result.providerPaymentId).toBe(PROVIDER_PAYMENT_ID)
		}
		expect(applyTransition.mock.calls.length).toBe(0)
	})

	test('lookup uses snapshot.providerPaymentId (not parentProviderPaymentId)', async () => {
		const { service, getByProviderId } = buildService()
		await service.applyWebhookEvent(TENANT, paymentEvent('succeeded'), ACTOR)
		expect(getByProviderId.mock.calls.length).toBe(1)
		const [tenant, providerCode, providerPaymentId] = getByProviderId.mock.calls[0]!
		expect(tenant).toBe(TENANT)
		expect(providerCode).toBe('yookassa')
		expect(providerPaymentId).toBe(PROVIDER_PAYMENT_ID)
	})

	test('canceled event: status flows + canceledAt timestamp set', async () => {
		const { service, applyTransition } = buildService()
		await service.applyWebhookEvent(TENANT, paymentEvent('canceled'), ACTOR)
		const next = applyTransition.mock.calls[0]![3]
		expect(next.status).toBe('canceled')
		expect(next.canceledAt).toBeInstanceOf(Date)
		expect(next.capturedAt).toBeNull()
	})
})

describe('payment.service.applyWebhookEvent — refund subject (audit-only)', () => {
	test('refund event: returns refund-noted + parent + amount, NO applyTransition', async () => {
		const { service, applyTransition } = buildService()
		const result = await service.applyWebhookEvent(TENANT, refundEvent(), ACTOR)
		expect(result.kind).toBe('refund-noted')
		if (result.kind === 'refund-noted') {
			expect(result.parentPayment.id).toBe(PAYMENT_ID)
			expect(result.refundAmountMinor).toBe(50_00n)
		}
		// Refund row creation = separate slice (refund.service path); webhook
		// handler records audit ONLY (no payment SM transition on refund event).
		expect(applyTransition.mock.calls.length).toBe(0)
	})

	test('refund event: lookup uses parentProviderPaymentId (NOT snapshot.providerPaymentId)', async () => {
		const { service, getByProviderId } = buildService()
		await service.applyWebhookEvent(TENANT, refundEvent(), ACTOR)
		const [, , providerPaymentId] = getByProviderId.mock.calls[0]!
		// Refund's parent payment id — used к find parent for audit/cross-ref
		expect(providerPaymentId).toBe(PROVIDER_PAYMENT_ID)
	})

	test('refund event с unknown parent — payment-not-found returned', async () => {
		const { service } = buildService({
			getByProviderId: mock(async () => null),
		})
		const result = await service.applyWebhookEvent(TENANT, refundEvent(), ACTOR)
		expect(result.kind).toBe('payment-not-found')
		if (result.kind === 'payment-not-found') {
			expect(result.providerPaymentId).toBe(PROVIDER_PAYMENT_ID)
		}
	})
})

describe('payment.service.applyWebhookEvent — adversarial', () => {
	test("subsequent calls don't share state (stateless service contract)", async () => {
		const { service, applyTransition } = buildService()
		await service.applyWebhookEvent(TENANT, paymentEvent('waiting_for_capture'), ACTOR)
		await service.applyWebhookEvent(TENANT, paymentEvent('succeeded'), ACTOR)
		expect(applyTransition.mock.calls.length).toBe(2)
		// Each call independent — sequence preserved через repo, not service state.
		expect(applyTransition.mock.calls[0]![3].status).toBe('waiting_for_capture')
		expect(applyTransition.mock.calls[1]![3].status).toBe('succeeded')
	})
})
