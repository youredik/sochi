/**
 * payment-webhook.routes — pipeline integration tests (P1, 2026-05).
 *
 * Strategy: mock provider/repo/service at boundary seams, exercise full Hono
 * route pipeline (IP allowlist → verify → tenant derive → dedup INSERT →
 * apply transition → markProcessed). NO live YDB — repo behaviour stubbed
 * via `mock()` from bun:test. End-to-end with YDB covered separately in
 * `.db.test.ts` (deferred — env setup heavy).
 *
 * Coverage:
 *   - happy path: valid IP + valid payload + new event → 200 + processed
 *   - duplicate dedupKey → 200 'duplicate' (idempotent replay)
 *   - non-allowlisted IP → 403
 *   - missing client IP → 400
 *   - malformed payload → 400
 *   - unknown payment (no tenant match) → 200 'no-match' (do not retry)
 *   - service.applyWebhookEvent throws → 500 + markFailed recorded
 *   - X-Forwarded-For first IP wins over X-Real-IP fallback
 */

import type {
	Payment,
	PaymentProvider,
	PaymentWebhookEvent,
	VerifiedWebhookEvent,
} from '@horeca/shared'
import { describe, expect, mock, test } from 'bun:test'
import {
	createPaymentWebhookRoutes,
	type PaymentWebhookRoutesDeps,
} from './payment-webhook.routes.ts'
import type { PaymentRepo } from './payment.repo.ts'
import type { PaymentService } from './payment.service.ts'
import type { PaymentWebhookEventRepo } from './payment-webhook-event.repo.ts'

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const TENANT = 'org_test_tenant_001'
const PAYMENT_PROVIDER_ID = '2c9b4e8f-aaaa-4000-9000-bbbbbbbbbbbb'
const LOCAL_PAYMENT_ID = 'pay_test_local_001'
const ALLOWED_IP = '185.71.76.10' // in 185.71.76.0/27
const FORBIDDEN_IP = '203.0.113.5' // RFC 5737 test-net-3 (outside allowlist)

const VERIFIED_PAYMENT_SUCCEEDED: VerifiedWebhookEvent = {
	dedupKey: `${PAYMENT_PROVIDER_ID}|payment.succeeded|succeeded|10000`,
	providerCode: 'yookassa',
	subject: {
		kind: 'payment',
		snapshot: {
			providerPaymentId: PAYMENT_PROVIDER_ID,
			status: 'succeeded',
			authorizedMinor: 100_00n,
			capturedMinor: 100_00n,
			confirmationUrl: null,
			holdExpiresAt: null,
			failureReason: null,
		},
	},
	receivedAt: '2026-05-19T10:00:00.000Z',
}

const PAYMENT_ROW: Payment = {
	tenantId: TENANT,
	propertyId: 'prop_001',
	bookingId: 'book_001',
	id: LOCAL_PAYMENT_ID,
	folioId: 'folio_001',
	providerCode: 'yookassa',
	providerPaymentId: PAYMENT_PROVIDER_ID,
	method: 'card',
	// Payment uses string-serialized money (YDB Int64 transport form).
	amountMinor: '10000',
	authorizedMinor: '10000',
	capturedMinor: '0',
	currency: 'RUB',
	status: 'pending',
	idempotencyKey: 'idem-001',
	version: 2,
	payerInn: null,
	saleChannel: 'direct',
	anomalyScore: null,
	holdExpiresAt: null,
	confirmationUrl: null,
	failureReason: null,
	createdAt: '2026-05-19T09:55:00.000Z',
	updatedAt: '2026-05-19T09:58:00.000Z',
	authorizedAt: null,
	capturedAt: null,
	refundedAt: null,
	canceledAt: null,
	failedAt: null,
	expiredAt: null,
	createdBy: 'user_alice',
	updatedBy: 'user_alice',
}

const WEBHOOK_EVENT_ROW: PaymentWebhookEvent = {
	tenantId: TENANT,
	providerCode: 'yookassa',
	dedupKey: VERIFIED_PAYMENT_SUCCEEDED.dedupKey,
	eventType: 'payment.succeeded',
	providerPaymentId: PAYMENT_PROVIDER_ID,
	providerRefundId: null,
	payloadJson: { dedupKey: VERIFIED_PAYMENT_SUCCEEDED.dedupKey },
	signatureHeader: null,
	sourceIp: ALLOWED_IP,
	verifiedAt: '2026-05-19T10:00:00.000Z',
	processedAt: null,
	processingError: null,
	processedBy: null,
}

// -----------------------------------------------------------------------------
// Build harness
// -----------------------------------------------------------------------------

type Harness = {
	deps: PaymentWebhookRoutesDeps
	verifyWebhook: ReturnType<typeof mock<PaymentProvider['verifyWebhook']>>
	findTenantByProviderPaymentId: ReturnType<
		typeof mock<PaymentRepo['findTenantByProviderPaymentId']>
	>
	insertOrSkip: ReturnType<typeof mock<PaymentWebhookEventRepo['insertOrSkip']>>
	markProcessed: ReturnType<typeof mock<PaymentWebhookEventRepo['markProcessed']>>
	markFailed: ReturnType<typeof mock<PaymentWebhookEventRepo['markFailed']>>
	applyWebhookEvent: ReturnType<typeof mock<PaymentService['applyWebhookEvent']>>
}

function buildHarness(
	overrides: Partial<{
		verifyWebhook: PaymentProvider['verifyWebhook']
		findTenantByProviderPaymentId: PaymentRepo['findTenantByProviderPaymentId']
		insertOrSkip: PaymentWebhookEventRepo['insertOrSkip']
		applyWebhookEvent: PaymentService['applyWebhookEvent']
	}> = {},
): Harness {
	const verifyWebhook = mock<PaymentProvider['verifyWebhook']>(
		overrides.verifyWebhook ?? (async () => VERIFIED_PAYMENT_SUCCEEDED),
	)
	const findTenantByProviderPaymentId = mock<PaymentRepo['findTenantByProviderPaymentId']>(
		overrides.findTenantByProviderPaymentId ??
			(async () => ({ tenantId: TENANT, paymentId: LOCAL_PAYMENT_ID })),
	)
	const insertOrSkip = mock<PaymentWebhookEventRepo['insertOrSkip']>(
		overrides.insertOrSkip ?? (async () => ({ kind: 'inserted', event: WEBHOOK_EVENT_ROW })),
	)
	const markProcessed = mock<PaymentWebhookEventRepo['markProcessed']>(async () => {})
	const markFailed = mock<PaymentWebhookEventRepo['markFailed']>(async () => {})
	const applyWebhookEvent = mock<PaymentService['applyWebhookEvent']>(
		overrides.applyWebhookEvent ??
			(async () => ({ kind: 'payment-transitioned', payment: PAYMENT_ROW })),
	)

	const providerStub = {
		code: 'yookassa',
		capabilities: {
			partialCapture: true,
			holdPeriodHours: 72,
			sbpNative: false,
			fiscalization: 'native',
			supportsCorrection: true,
		},
		verifyWebhook,
		initiate: mock(),
		capture: mock(),
		cancel: mock(),
		refund: mock(),
		releaseResidualHold: mock(),
	} as unknown as PaymentProvider

	const deps: PaymentWebhookRoutesDeps = {
		yookassaProvider: providerStub,
		paymentRepo: {
			findTenantByProviderPaymentId,
		} as unknown as PaymentRepo,
		paymentService: {
			applyWebhookEvent,
		} as unknown as PaymentService,
		webhookEventRepo: {
			insertOrSkip,
			markProcessed,
			markFailed,
		} as unknown as PaymentWebhookEventRepo,
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
	}

	return {
		deps,
		verifyWebhook,
		findTenantByProviderPaymentId,
		insertOrSkip,
		markProcessed,
		markFailed,
		applyWebhookEvent,
	}
}

async function post(
	app: ReturnType<typeof createPaymentWebhookRoutes>,
	body: string,
	headers: Record<string, string>,
): Promise<Response> {
	return await app.fetch(
		new Request('http://test/yookassa', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-forwarded-for': ALLOWED_IP,
				...headers,
			},
			body,
		}),
		// Hono needs a logger в `c.var` — empty AppEnv passed via Hono fetch helper.
		// Default Hono provides c.var; our route uses c.var.logger.
	)
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('createPaymentWebhookRoutes — POST /yookassa', () => {
	const VALID_BODY = JSON.stringify({
		type: 'notification',
		event: 'payment.succeeded',
		object: { id: PAYMENT_PROVIDER_ID, status: 'succeeded' },
	})

	test('happy path — 200 with action=payment-transitioned', async () => {
		const h = buildHarness()
		const app = createPaymentWebhookRoutes(h.deps)
		const res = await post(app, VALID_BODY, {})
		expect(res.status).toBe(200)
		const json = (await res.json()) as { status: string; action: string }
		expect(json.status).toBe('ok')
		expect(json.action).toBe('payment-transitioned')
		expect(h.verifyWebhook.mock.calls.length).toBe(1)
		expect(h.findTenantByProviderPaymentId.mock.calls.length).toBe(1)
		expect(h.insertOrSkip.mock.calls.length).toBe(1)
		expect(h.applyWebhookEvent.mock.calls.length).toBe(1)
		expect(h.markProcessed.mock.calls.length).toBe(1)
		expect(h.markFailed.mock.calls.length).toBe(0)
	})

	test('duplicate dedupKey — 200 with action=duplicate (replay-safe)', async () => {
		const h = buildHarness({
			insertOrSkip: async () => ({ kind: 'duplicate', existing: WEBHOOK_EVENT_ROW }),
		})
		const app = createPaymentWebhookRoutes(h.deps)
		const res = await post(app, VALID_BODY, {})
		expect(res.status).toBe(200)
		const json = (await res.json()) as { action: string }
		expect(json.action).toBe('duplicate')
		// MUST NOT call applyWebhookEvent on duplicate
		expect(h.applyWebhookEvent.mock.calls.length).toBe(0)
	})

	test('IP not in allowlist → 403', async () => {
		const h = buildHarness()
		const app = createPaymentWebhookRoutes(h.deps)
		const res = await post(app, VALID_BODY, { 'x-forwarded-for': FORBIDDEN_IP })
		expect(res.status).toBe(403)
		// MUST NOT call provider verify on rejected IP
		expect(h.verifyWebhook.mock.calls.length).toBe(0)
	})

	test('missing client IP → 400', async () => {
		const h = buildHarness()
		const app = createPaymentWebhookRoutes(h.deps)
		const res = await app.fetch(
			new Request('http://test/yookassa', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: VALID_BODY,
			}),
		)
		expect(res.status).toBe(400)
		expect(h.verifyWebhook.mock.calls.length).toBe(0)
	})

	test('all 7 ЮKassa CIDRs accepted (canon 2026-05-19 verified)', async () => {
		const ips = [
			'185.71.76.5',
			'185.71.77.5',
			'77.75.153.5',
			'77.75.154.130',
			'77.75.156.11',
			'77.75.156.35',
			'2a02:5180::1',
		]
		for (const ip of ips) {
			const h = buildHarness()
			const app = createPaymentWebhookRoutes(h.deps)
			const res = await post(app, VALID_BODY, { 'x-forwarded-for': ip })
			expect(res.status).toBe(200)
		}
	})

	test('provider.verifyWebhook throws → 400 invalid_payload', async () => {
		const h = buildHarness({
			verifyWebhook: async () => {
				throw new Error('malformed JSON')
			},
		})
		const app = createPaymentWebhookRoutes(h.deps)
		const res = await post(app, 'not json', {})
		expect(res.status).toBe(400)
		expect(h.insertOrSkip.mock.calls.length).toBe(0)
	})

	test('unknown payment (no tenant match) → 200 no-match', async () => {
		const h = buildHarness({
			findTenantByProviderPaymentId: async () => null,
		})
		const app = createPaymentWebhookRoutes(h.deps)
		const res = await post(app, VALID_BODY, {})
		expect(res.status).toBe(200)
		const json = (await res.json()) as { action: string }
		expect(json.action).toBe('no-match')
		expect(h.insertOrSkip.mock.calls.length).toBe(0)
		expect(h.applyWebhookEvent.mock.calls.length).toBe(0)
	})

	test('applyWebhookEvent throws → 500 + markFailed recorded', async () => {
		const h = buildHarness({
			applyWebhookEvent: async () => {
				throw new Error('SM transition rejected')
			},
		})
		const app = createPaymentWebhookRoutes(h.deps)
		const res = await post(app, VALID_BODY, {})
		expect(res.status).toBe(500)
		expect(h.markProcessed.mock.calls.length).toBe(0)
		expect(h.markFailed.mock.calls.length).toBe(1)
		const failCall = h.markFailed.mock.calls[0]!
		expect(failCall[3]).toContain('SM transition rejected')
	})

	test('X-Forwarded-For multi-hop — first IP wins (RFC 7239)', async () => {
		const h = buildHarness()
		const app = createPaymentWebhookRoutes(h.deps)
		// First IP (closest to client) — ALLOWED. Subsequent hops irrelevant.
		const res = await post(app, VALID_BODY, {
			'x-forwarded-for': `${ALLOWED_IP}, 10.0.0.1, 192.168.0.1`,
		})
		expect(res.status).toBe(200)
	})

	test('X-Real-IP fallback when X-Forwarded-For missing', async () => {
		const h = buildHarness()
		const app = createPaymentWebhookRoutes(h.deps)
		const res = await app.fetch(
			new Request('http://test/yookassa', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-real-ip': ALLOWED_IP,
				},
				body: VALID_BODY,
			}),
		)
		expect(res.status).toBe(200)
	})

	test('refund subject event → 200 with action=refund-noted', async () => {
		const refundEvent: VerifiedWebhookEvent = {
			dedupKey: `${PAYMENT_PROVIDER_ID}|refund.succeeded|succeeded|5000`,
			providerCode: 'yookassa',
			subject: {
				kind: 'refund',
				refund: {
					providerRefundId: 'refund-1',
					status: 'succeeded',
					amountMinor: 50_00n,
					failureReason: null,
				},
				parentProviderPaymentId: PAYMENT_PROVIDER_ID,
			},
			receivedAt: '2026-05-19T10:01:00.000Z',
		}
		const h = buildHarness({
			verifyWebhook: async () => refundEvent,
			applyWebhookEvent: async () => ({
				kind: 'refund-noted',
				parentPayment: PAYMENT_ROW,
				refundAmountMinor: 50_00n,
			}),
		})
		const app = createPaymentWebhookRoutes(h.deps)
		const res = await post(
			app,
			JSON.stringify({ type: 'notification', event: 'refund.succeeded' }),
			{},
		)
		expect(res.status).toBe(200)
		const json = (await res.json()) as { action: string }
		expect(json.action).toBe('refund-noted')
	})
})
