/**
 * ЮKassa REST adapter — strict unit tests (P1, 2026-05).
 *
 * Canon (Bun 1.3.14 test, verified 2026-05-19 — bun.com/guides/test/spy-on):
 * use `mock()` from `bun:test` + `mock.calls[i]` array for argument inspection.
 * `let captured` closure pattern has TypeScript narrowing limitation
 * (microsoft/TypeScript#35124 — flow-sensitive narrowing does not extend into
 * closures, `let` mutation collapses to initial union). `mock.calls` IS the
 * structured store — type-safe из коробки.
 *
 * Coverage matrix (per `feedback_strict_tests.md`):
 *   - Happy path each method (initiate/capture/cancel/refund/verifyWebhook)
 *   - Adversarial: malformed JSON, content-length mismatch, unknown events
 *   - Error taxonomy: 400/401/404/429/5xx/network → typed exceptions
 *   - Resilience: 5xx retried, 401 NOT retried, max-attempts honored
 *   - Idempotence-Key header SPELLING LOCK (regression guard)
 *   - sber_bnpl 50_000 ₽ clamp (changelog 2026-04-23)
 *   - returnUrl override via metadata
 *   - Money conversion property-based (fast-check)
 *   - Constructor invariants (empty fields rejected)
 */

import {
	type PaymentInitiateRequest,
	type PaymentRefundRequest,
	synthesizeYookassaDedupKey,
} from '@horeca/shared'
import { describe, expect, mock, test } from 'bun:test'
import * as fc from 'fast-check'
import {
	amountValueToKopecks,
	kopecksToAmountValue,
	YOOKASSA_SBER_BNPL_MAX_RUB_KOPECKS,
} from './yookassa-schemas.ts'
import {
	createYooKassaPaymentProvider,
	YookassaAuthError,
	YookassaBadRequestError,
	YookassaNetworkError,
	YookassaNotFoundError,
	YookassaRateLimitError,
	YookassaSberBnplLimitError,
	YookassaTransientError,
	type YookassaProviderOptions,
} from './yookassa-provider.ts'

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const SHOP_ID = 'test_shop_999'
const SECRET_KEY = 'test_secret_abc'
const API_BASE = 'https://api.yookassa.ru/v3'
const RETURN_URL = 'https://example.com/booking/payment-return'

const FIXED_UUID = '00000000-0000-4000-8000-000000000001'

/** Canonical fetch shape для mock typing — matches provider's narrow boundary. */
type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Default `fetch` mock that throws — every test MUST supply its own via override.
 * Wrapped в bun:test `mock()` so call inspection is type-safe (Mock<T> preserves
 * Parameters<T> tuple).
 */
function baseOpts(over?: Partial<YookassaProviderOptions>): YookassaProviderOptions {
	const failFetch = mock<ProviderFetch>(async () => {
		throw new Error('fetch not stubbed — pass `fetch` in test')
	})
	return {
		shopId: SHOP_ID,
		secretKey: SECRET_KEY,
		apiBase: API_BASE,
		returnUrl: RETURN_URL,
		uuid: () => FIXED_UUID,
		fetch: failFetch,
		...over,
	}
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
	})
}

function textResponse(status: number, body: string, headers?: Record<string, string>): Response {
	return new Response(body, { status, headers: headers ?? {} })
}

/** Reads the first call's init headers from a bun-test mock. */
function firstCallHeaders(fetchMock: ReturnType<typeof mock<ProviderFetch>>): Headers {
	const call = fetchMock.mock.calls[0]
	if (call === undefined) throw new Error('fetchMock not called')
	const [, init] = call
	return new Headers(init?.headers)
}

/** Reads the first call's init body (as JSON-parsed object) from a bun-test mock. */
function firstCallBodyJson(fetchMock: ReturnType<typeof mock<ProviderFetch>>): unknown {
	const call = fetchMock.mock.calls[0]
	if (call === undefined) throw new Error('fetchMock not called')
	const [, init] = call
	if (typeof init?.body !== 'string') throw new Error('fetchMock body not a string')
	return JSON.parse(init.body)
}

const PAYMENT_OBJECT_SUCCEEDED = {
	id: '2c9b4e8f-aaaa-4000-9000-bbbbbbbbbbbb',
	status: 'succeeded' as const,
	amount: { value: '100.00', currency: 'RUB' as const },
	confirmation: {
		type: 'redirect' as const,
		return_url: RETURN_URL,
		confirmation_url: 'https://yoomoney.ru/checkout/payments/v2/contract/...',
	},
	created_at: '2026-05-18T12:00:00.000Z',
	paid: true,
	test: true,
}

const PAYMENT_OBJECT_PENDING = {
	...PAYMENT_OBJECT_SUCCEEDED,
	status: 'pending' as const,
	paid: false,
}

const REFUND_OBJECT_SUCCEEDED = {
	id: 'refund-aaaa-4000-9000-bbbb',
	status: 'succeeded' as const,
	amount: { value: '50.00', currency: 'RUB' as const },
	payment_id: PAYMENT_OBJECT_SUCCEEDED.id,
	created_at: '2026-05-18T12:01:00.000Z',
}

const INITIATE_REQ: PaymentInitiateRequest = {
	localPaymentId: 'pay_test_xyz',
	method: 'card',
	amountMinor: 100_00n,
	currency: 'RUB',
	providerIdempotencyKey: 'idem-test-uuid-1',
}

// -----------------------------------------------------------------------------
// Constructor invariants
// -----------------------------------------------------------------------------

describe('createYooKassaPaymentProvider — constructor', () => {
	test('rejects empty shopId', () => {
		expect(() => createYooKassaPaymentProvider(baseOpts({ shopId: '' }))).toThrow(/shopId/)
	})
	test('rejects empty secretKey', () => {
		expect(() => createYooKassaPaymentProvider(baseOpts({ secretKey: '' }))).toThrow(/secretKey/)
	})
	test('rejects empty apiBase', () => {
		expect(() => createYooKassaPaymentProvider(baseOpts({ apiBase: '' }))).toThrow(/apiBase/)
	})
	test('rejects empty returnUrl', () => {
		expect(() => createYooKassaPaymentProvider(baseOpts({ returnUrl: '' }))).toThrow(/returnUrl/)
	})
	test('code is "yookassa"', () => {
		expect(createYooKassaPaymentProvider(baseOpts()).code).toBe('yookassa')
	})
	test('capabilities (T+72h hold, partial-capture, native fiscalization)', () => {
		const p = createYooKassaPaymentProvider(baseOpts())
		expect(p.capabilities.holdPeriodHours).toBe(72)
		expect(p.capabilities.partialCapture).toBe(true)
		expect(p.capabilities.fiscalization).toBe('native')
		expect(p.capabilities.supportsCorrection).toBe(true)
		expect(p.capabilities.sbpNative).toBe(false)
	})
})

// -----------------------------------------------------------------------------
// initiate
// -----------------------------------------------------------------------------

describe('initiate', () => {
	test('happy path — returns snapshot with confirmation_url', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const snap = await p.initiate(INITIATE_REQ)
		expect(snap.providerPaymentId).toBe(PAYMENT_OBJECT_SUCCEEDED.id)
		expect(snap.status).toBe('succeeded')
		expect(snap.authorizedMinor).toBe(100_00n)
		expect(snap.capturedMinor).toBe(100_00n)
		expect(snap.confirmationUrl).toBe(PAYMENT_OBJECT_SUCCEEDED.confirmation.confirmation_url)
	})

	test('Idempotence-Key header SPELLING LOCK (canon — RFC autocorrect would break dedup)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await p.initiate(INITIATE_REQ)
		const headers = firstCallHeaders(fetchMock)
		expect(headers.get('Idempotence-Key')).toBe('idem-test-uuid-1')
		// Anti-canon — `Idempotency-Key` (RFC style) MUST NOT be sent — ЮKassa
		// would 400 on missing required header.
		expect(headers.get('Idempotency-Key')).toBeNull()
	})

	test('HTTP Basic auth header sent (shopId:secretKey base64)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await p.initiate(INITIATE_REQ)
		const expected = `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`, 'utf-8').toString('base64')}`
		expect(firstCallHeaders(fetchMock).get('Authorization')).toBe(expected)
	})

	test('returnUrl default — appends ?paymentId=<localPaymentId>', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await p.initiate(INITIATE_REQ)
		const body = firstCallBodyJson(fetchMock) as {
			confirmation: { return_url: string }
		}
		expect(body.confirmation.return_url).toBe(
			`${RETURN_URL}?paymentId=${INITIATE_REQ.localPaymentId}`,
		)
	})

	test('SECURITY: returnUrl override via metadata IGNORED (P2.5 OWASP A10 hardening)', async () => {
		// Per-request `req.metadata.returnUrl` override was a phishing vector
		// (open-redirect class). Adapter MUST always use `opts.returnUrl`.
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await p.initiate({
			...INITIATE_REQ,
			metadata: { returnUrl: 'https://attacker.example/phish' },
		})
		const body = firstCallBodyJson(fetchMock) as {
			confirmation: { return_url: string }
		}
		// Override attempted but ignored — adapter uses opts.returnUrl only.
		expect(body.confirmation.return_url).toBe(
			`${RETURN_URL}?paymentId=${INITIATE_REQ.localPaymentId}`,
		)
		expect(body.confirmation.return_url).not.toContain('attacker.example')
	})

	test('SECURITY: Idempotency-Key invalid format rejected (CRLF inject defense)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		// CRLF + control chars must be rejected pre-send.
		await expect(
			p.initiate({
				...INITIATE_REQ,
				providerIdempotencyKey: 'evil\r\nX-Injected: foo',
			}),
		).rejects.toThrow(/Idempotency-Key/i)
		// Bytes / colons / spaces also rejected.
		await expect(
			p.initiate({ ...INITIATE_REQ, providerIdempotencyKey: 'key with spaces' }),
		).rejects.toThrow(/Idempotency-Key/i)
		// Over-length (>64) rejected.
		await expect(
			p.initiate({ ...INITIATE_REQ, providerIdempotencyKey: 'a'.repeat(65) }),
		).rejects.toThrow(/Idempotency-Key/i)
		// Empty rejected.
		await expect(p.initiate({ ...INITIATE_REQ, providerIdempotencyKey: '' })).rejects.toThrow(
			/Idempotency-Key/i,
		)
		// fetch NEVER called.
		expect(fetchMock.mock.calls.length).toBe(0)
	})

	test('SECURITY: malicious confirmation_url host filtered (supply-chain defense)', async () => {
		// Simulate ЮKassa SDK chain compromise returning attacker-controlled URL.
		const fetchMock = mock<ProviderFetch>(async () =>
			jsonResponse(200, {
				...PAYMENT_OBJECT_SUCCEEDED,
				confirmation: {
					type: 'redirect',
					return_url: RETURN_URL,
					confirmation_url: 'https://phisher.example/steal-pan?token=XYZ',
				},
			}),
		)
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const snap = await p.initiate(INITIATE_REQ)
		// Bad host filtered → confirmationUrl null (caller treats as "no redirect")
		expect(snap.confirmationUrl).toBeNull()
	})

	test('confirmation_url with allowed yookassa.ru host passed through', async () => {
		const fetchMock = mock<ProviderFetch>(async () =>
			jsonResponse(200, {
				...PAYMENT_OBJECT_SUCCEEDED,
				confirmation: {
					type: 'redirect',
					return_url: RETURN_URL,
					confirmation_url: 'https://yookassa.ru/v3/redirect/abc',
				},
			}),
		)
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const snap = await p.initiate(INITIATE_REQ)
		expect(snap.confirmationUrl).toBe('https://yookassa.ru/v3/redirect/abc')
	})

	test('amount formatted as "<int>.<2 digits>"', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await p.initiate({ ...INITIATE_REQ, amountMinor: 100_50n })
		const body = firstCallBodyJson(fetchMock) as { amount: { value: string } }
		expect(body.amount.value).toBe('100.50')
	})

	test('sber_bnpl clamp — rejects > 50 000 ₽ (changelog 2026-04-23)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(
			p.initiate({
				...INITIATE_REQ,
				amountMinor: 50_001_00n, // 50 001 ₽ в копейках — over limit
				metadata: { yookassaPaymentMethodType: 'sber_bnpl' },
			}),
		).rejects.toThrow(YookassaSberBnplLimitError)
	})

	test('sber_bnpl accepts exact boundary 50 000 ₽', async () => {
		const fetchMock = mock<ProviderFetch>(async () =>
			jsonResponse(200, {
				...PAYMENT_OBJECT_SUCCEEDED,
				amount: { value: '50000.00', currency: 'RUB' },
			}),
		)
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const snap = await p.initiate({
			...INITIATE_REQ,
			amountMinor: YOOKASSA_SBER_BNPL_MAX_RUB_KOPECKS,
			metadata: { yookassaPaymentMethodType: 'sber_bnpl' },
		})
		expect(snap.authorizedMinor).toBe(YOOKASSA_SBER_BNPL_MAX_RUB_KOPECKS)
	})

	test('400 → YookassaBadRequestError', async () => {
		const fetchMock = mock<ProviderFetch>(async () =>
			jsonResponse(400, { type: 'error', code: 'invalid_request' }),
		)
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(p.initiate(INITIATE_REQ)).rejects.toBeInstanceOf(YookassaBadRequestError)
	})

	test('401 → YookassaAuthError (NOT retried — auth fails forever)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(401, {}))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(p.initiate(INITIATE_REQ)).rejects.toBeInstanceOf(YookassaAuthError)
		expect(fetchMock.mock.calls.length).toBe(1) // ZERO retries for 401
	})

	test('404 → YookassaNotFoundError (NOT retried)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(404, {}))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(p.initiate(INITIATE_REQ)).rejects.toBeInstanceOf(YookassaNotFoundError)
		expect(fetchMock.mock.calls.length).toBe(1)
	})

	test('429 → YookassaRateLimitError with Retry-After parsed (retried)', async () => {
		const fetchMock = mock<ProviderFetch>(async () =>
			jsonResponse(429, {}, { 'Retry-After': '12' }),
		)
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const err = await p.initiate(INITIATE_REQ).catch((e) => e)
		expect(err).toBeInstanceOf(YookassaRateLimitError)
		expect((err as YookassaRateLimitError).retryAfterSeconds).toBe(12)
		expect(fetchMock.mock.calls.length).toBe(2) // 1 initial + 1 retry
	})

	test('500 → YookassaTransientError retried (max-attempts cap = 2 calls total)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => textResponse(500, 'internal error'))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(p.initiate(INITIATE_REQ)).rejects.toBeInstanceOf(YookassaTransientError)
		expect(fetchMock.mock.calls.length).toBe(2)
	})

	test('5xx then 200 — retry recovers', async () => {
		let n = 0
		const fetchMock = mock<ProviderFetch>(async () => {
			n++
			if (n === 1) return textResponse(503, 'unavailable')
			return jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED)
		})
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const snap = await p.initiate(INITIATE_REQ)
		expect(snap.status).toBe('succeeded')
		expect(fetchMock.mock.calls.length).toBe(2)
	})

	test('network error → YookassaNetworkError (wrapped, retried)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => {
			throw new TypeError('failed to fetch')
		})
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(p.initiate(INITIATE_REQ)).rejects.toBeInstanceOf(YookassaNetworkError)
		expect(fetchMock.mock.calls.length).toBe(2)
	})

	test('non-JSON 2xx body → YookassaBadRequestError', async () => {
		const fetchMock = mock<ProviderFetch>(async () => textResponse(200, '<html>not json</html>'))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(p.initiate(INITIATE_REQ)).rejects.toBeInstanceOf(YookassaBadRequestError)
	})

	test('pending status maps capturedMinor=0 (paid=false)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_PENDING))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const snap = await p.initiate(INITIATE_REQ)
		expect(snap.status).toBe('pending')
		expect(snap.authorizedMinor).toBe(100_00n)
		expect(snap.capturedMinor).toBe(0n) // not yet paid
	})

	test('cancellation_details propagated to failureReason', async () => {
		const fetchMock = mock<ProviderFetch>(async () =>
			jsonResponse(200, {
				...PAYMENT_OBJECT_SUCCEEDED,
				status: 'canceled',
				cancellation_details: { party: 'yoo_money', reason: 'fraud_suspected' },
			}),
		)
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const snap = await p.initiate(INITIATE_REQ)
		expect(snap.status).toBe('canceled')
		expect(snap.failureReason).toBe('yoo_money:fraud_suspected')
	})
})

// -----------------------------------------------------------------------------
// capture
// -----------------------------------------------------------------------------

describe('capture', () => {
	test('full capture (amount=null) — empty body', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await p.capture(PAYMENT_OBJECT_SUCCEEDED.id, null)
		expect(firstCallBodyJson(fetchMock)).toEqual({})
	})

	test('partial capture — body includes amount', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await p.capture(PAYMENT_OBJECT_SUCCEEDED.id, 50_00n)
		const body = firstCallBodyJson(fetchMock) as { amount: { value: string } }
		expect(body.amount.value).toBe('50.00')
	})

	test('negative amount rejected with RangeError', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(p.capture(PAYMENT_OBJECT_SUCCEEDED.id, -1n)).rejects.toBeInstanceOf(RangeError)
	})

	test('uses auto-generated Idempotence-Key (from opts.uuid)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await p.capture(PAYMENT_OBJECT_SUCCEEDED.id, null)
		expect(firstCallHeaders(fetchMock).get('Idempotence-Key')).toBe(FIXED_UUID)
	})
})

// -----------------------------------------------------------------------------
// cancel
// -----------------------------------------------------------------------------

describe('cancel', () => {
	test('returns PaymentProviderSnapshot when canceled', async () => {
		const fetchMock = mock<ProviderFetch>(async () =>
			jsonResponse(200, { ...PAYMENT_OBJECT_SUCCEEDED, status: 'canceled', paid: false }),
		)
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const result = await p.cancel(PAYMENT_OBJECT_SUCCEEDED.id)
		expect('providerPaymentId' in result).toBe(true)
		if ('providerPaymentId' in result) {
			expect(result.status).toBe('canceled')
		}
	})
})

// -----------------------------------------------------------------------------
// refund
// -----------------------------------------------------------------------------

describe('refund', () => {
	const REFUND_REQ: PaymentRefundRequest = {
		providerPaymentId: PAYMENT_OBJECT_SUCCEEDED.id,
		amountMinor: 50_00n,
		providerIdempotencyKey: 'refund-idem-uuid-2',
		reason: 'guest cancellation',
	}

	test('happy path — returns RefundProviderSnapshot', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, REFUND_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const snap = await p.refund(REFUND_REQ)
		expect(snap.providerRefundId).toBe(REFUND_OBJECT_SUCCEEDED.id)
		expect(snap.status).toBe('succeeded')
		expect(snap.amountMinor).toBe(50_00n)
	})

	test('negative amount rejected', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, REFUND_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(p.refund({ ...REFUND_REQ, amountMinor: -1n })).rejects.toBeInstanceOf(RangeError)
	})

	test('refund.canceled → domain status `failed` (canon: domain не различает)', async () => {
		const fetchMock = mock<ProviderFetch>(async () =>
			jsonResponse(200, {
				...REFUND_OBJECT_SUCCEEDED,
				status: 'canceled',
				cancellation_details: { party: 'yoo_money', reason: 'expired_on_confirmation' },
			}),
		)
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		const snap = await p.refund(REFUND_REQ)
		expect(snap.status).toBe('failed')
		expect(snap.failureReason).toBe('yoo_money:expired_on_confirmation')
	})

	test('uses request idempotency key (not auto-generated UUID)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(200, REFUND_OBJECT_SUCCEEDED))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await p.refund(REFUND_REQ)
		expect(firstCallHeaders(fetchMock).get('Idempotence-Key')).toBe(
			REFUND_REQ.providerIdempotencyKey,
		)
	})
})

// -----------------------------------------------------------------------------
// B2 dual-secret 48h fallback (2026-05-19)
// -----------------------------------------------------------------------------

describe('B2 dual-secret 48h fallback', () => {
	test('401 + secretKeyPrevious set → retries with previous, returns success', async () => {
		let n = 0
		const fetchMock = mock<ProviderFetch>(async (_input, init) => {
			n++
			const auth = new Headers(init?.headers).get('Authorization')
			// First call uses current key → 401. Second call uses previous → success.
			if (n === 1) {
				expect(auth).toContain(Buffer.from('test_shop_999:test_secret_abc').toString('base64'))
				return jsonResponse(401, {})
			}
			expect(auth).toContain(Buffer.from('test_shop_999:previous_secret_xyz').toString('base64'))
			return jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED)
		})
		const p = createYooKassaPaymentProvider(
			baseOpts({ fetch: fetchMock, secretKeyPrevious: 'previous_secret_xyz' }),
		)
		const snap = await p.initiate(INITIATE_REQ)
		expect(snap.status).toBe('succeeded')
		expect(fetchMock.mock.calls.length).toBe(2) // current + previous fallback
	})

	test('401 + NO secretKeyPrevious → throws YookassaAuthError (existing behavior preserved)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(401, {}))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock }))
		await expect(p.initiate(INITIATE_REQ)).rejects.toBeInstanceOf(YookassaAuthError)
		expect(fetchMock.mock.calls.length).toBe(1) // NO retry without previous
	})

	test('401 on current + 401 on previous → throws YookassaAuthError after both tried', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(401, {}))
		const p = createYooKassaPaymentProvider(
			baseOpts({ fetch: fetchMock, secretKeyPrevious: 'previous_secret_xyz' }),
		)
		await expect(p.initiate(INITIATE_REQ)).rejects.toBeInstanceOf(YookassaAuthError)
		expect(fetchMock.mock.calls.length).toBe(2) // both keys attempted
	})

	test('logger.warn fires when previous key used (audit signal)', async () => {
		let n = 0
		const fetchMock = mock<ProviderFetch>(async () => {
			n++
			return n === 1 ? jsonResponse(401, {}) : jsonResponse(200, PAYMENT_OBJECT_SUCCEEDED)
		})
		const warnCalls: Array<{ obj: Record<string, unknown>; msg: string | undefined }> = []
		const p = createYooKassaPaymentProvider(
			baseOpts({
				fetch: fetchMock,
				secretKeyPrevious: 'previous_secret_xyz',
				logger: {
					debug: () => {},
					info: () => {},
					warn: (obj, msg) => warnCalls.push({ obj, msg }),
					error: () => {},
				},
			}),
		)
		await p.initiate(INITIATE_REQ)
		expect(warnCalls.length).toBeGreaterThan(0)
		const audit = warnCalls.find((c) => c.obj.reason === 'auth_retry_with_previous_secret')
		// Exact-value assertion (canon: NO toBeDefined per weak_assertions=0).
		expect(audit?.obj.reason).toBe('auth_retry_with_previous_secret')
		expect(audit?.obj.provider).toBe('yookassa')
	})

	test('empty-string secretKeyPrevious treated as not-provided (defensive)', async () => {
		const fetchMock = mock<ProviderFetch>(async () => jsonResponse(401, {}))
		const p = createYooKassaPaymentProvider(baseOpts({ fetch: fetchMock, secretKeyPrevious: '' }))
		await expect(p.initiate(INITIATE_REQ)).rejects.toBeInstanceOf(YookassaAuthError)
		expect(fetchMock.mock.calls.length).toBe(1) // empty string → no fallback
	})
})

// -----------------------------------------------------------------------------
// verifyWebhook
// -----------------------------------------------------------------------------

describe('verifyWebhook', () => {
	const provider = createYooKassaPaymentProvider(baseOpts())

	function bytes(s: string): Uint8Array {
		return new TextEncoder().encode(s)
	}

	test('payment.succeeded → payment subject + canonical dedup key', async () => {
		const payload = {
			type: 'notification',
			event: 'payment.succeeded',
			object: PAYMENT_OBJECT_SUCCEEDED,
		}
		const body = bytes(JSON.stringify(payload))
		const ev = await provider.verifyWebhook(new Headers(), body)
		expect(ev.providerCode).toBe('yookassa')
		expect(ev.subject.kind).toBe('payment')
		expect(ev.dedupKey).toBe(
			synthesizeYookassaDedupKey({
				providerPaymentId: PAYMENT_OBJECT_SUCCEEDED.id,
				event: 'payment.succeeded',
				status: 'succeeded',
				amountValue: PAYMENT_OBJECT_SUCCEEDED.amount.value,
			}),
		)
	})

	test('payment.canceled → payment subject', async () => {
		const payload = {
			type: 'notification',
			event: 'payment.canceled',
			object: { ...PAYMENT_OBJECT_SUCCEEDED, status: 'canceled', paid: false },
		}
		const ev = await provider.verifyWebhook(new Headers(), bytes(JSON.stringify(payload)))
		expect(ev.subject.kind).toBe('payment')
	})

	test('refund.succeeded → refund subject with parent provider id', async () => {
		const payload = {
			type: 'notification',
			event: 'refund.succeeded',
			object: REFUND_OBJECT_SUCCEEDED,
		}
		const ev = await provider.verifyWebhook(new Headers(), bytes(JSON.stringify(payload)))
		expect(ev.subject.kind).toBe('refund')
		if (ev.subject.kind === 'refund') {
			expect(ev.subject.parentProviderPaymentId).toBe(REFUND_OBJECT_SUCCEEDED.payment_id)
		}
	})

	test('payment.waiting_for_capture → payment subject', async () => {
		const payload = {
			type: 'notification',
			event: 'payment.waiting_for_capture',
			object: { ...PAYMENT_OBJECT_SUCCEEDED, status: 'waiting_for_capture', paid: false },
		}
		const ev = await provider.verifyWebhook(new Headers(), bytes(JSON.stringify(payload)))
		expect(ev.subject.kind).toBe('payment')
	})

	test('payout.succeeded → not handled (throws — caller logs для audit)', async () => {
		const payload = {
			type: 'notification',
			event: 'payout.succeeded',
			object: { id: 'p-1', amount: { value: '10.00', currency: 'RUB' } },
		}
		await expect(
			provider.verifyWebhook(new Headers(), bytes(JSON.stringify(payload))),
		).rejects.toThrow(/payout\.succeeded/)
	})

	test('malformed JSON → YookassaBadRequestError', async () => {
		await expect(provider.verifyWebhook(new Headers(), bytes('{not json'))).rejects.toBeInstanceOf(
			YookassaBadRequestError,
		)
	})

	test('Content-Length mismatch → YookassaBadRequestError (defensive)', async () => {
		const body = bytes(JSON.stringify({ type: 'notification', event: 'payment.succeeded' }))
		const headers = new Headers({ 'content-length': '999' })
		await expect(provider.verifyWebhook(headers, body)).rejects.toBeInstanceOf(
			YookassaBadRequestError,
		)
	})

	test('Content-Length match — accepted', async () => {
		const payload = {
			type: 'notification',
			event: 'payment.succeeded',
			object: PAYMENT_OBJECT_SUCCEEDED,
		}
		const body = bytes(JSON.stringify(payload))
		const headers = new Headers({ 'content-length': String(body.byteLength) })
		const ev = await provider.verifyWebhook(headers, body)
		expect(ev.providerCode).toBe('yookassa')
	})

	test('refund.canceled event NOT in closed enum — Zod rejects', async () => {
		const payload = {
			type: 'notification',
			event: 'refund.canceled', // NOT в YooKassa closed enum (canon 2026-05-19)
			object: REFUND_OBJECT_SUCCEEDED,
		}
		await expect(
			provider.verifyWebhook(new Headers(), bytes(JSON.stringify(payload))),
		).rejects.toThrow()
	})
})

// -----------------------------------------------------------------------------
// releaseResidualHold
// -----------------------------------------------------------------------------

describe('releaseResidualHold', () => {
	test('no-op (does not throw) — ЮKassa auto-releases T+72h', async () => {
		const p = createYooKassaPaymentProvider(baseOpts())
		await p.releaseResidualHold('any-id')
		// reaching here = test passes (no throw)
	})
})

// -----------------------------------------------------------------------------
// Money conversion (property-based)
// -----------------------------------------------------------------------------

describe('money helpers (yookassa-schemas)', () => {
	test('property: kopecksToAmountValue ∘ amountValueToKopecks = identity', async () => {
		await fc.assert(
			fc.asyncProperty(fc.bigInt({ min: 0n, max: 10n ** 12n }), async (kopecks) => {
				const value = kopecksToAmountValue(kopecks)
				const roundTrip = amountValueToKopecks(value)
				return roundTrip === kopecks
			}),
			{ numRuns: 1000 },
		)
	})

	test('exact known mappings', () => {
		expect(kopecksToAmountValue(0n)).toBe('0.00')
		expect(kopecksToAmountValue(1n)).toBe('0.01')
		expect(kopecksToAmountValue(100n)).toBe('1.00')
		expect(kopecksToAmountValue(10050n)).toBe('100.50')
		expect(amountValueToKopecks('0.00')).toBe(0n)
		expect(amountValueToKopecks('100.50')).toBe(10050n)
	})

	test('kopecksToAmountValue rejects negative', () => {
		expect(() => kopecksToAmountValue(-1n)).toThrow(RangeError)
	})

	test('amountValueToKopecks rejects malformed string', () => {
		expect(() => amountValueToKopecks('100')).toThrow(TypeError)
		expect(() => amountValueToKopecks('100.5')).toThrow(TypeError)
		expect(() => amountValueToKopecks('100.555')).toThrow(TypeError)
		expect(() => amountValueToKopecks('abc')).toThrow(TypeError)
	})
})
