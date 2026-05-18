/**
 * Payment provider factory — P1 strict tests.
 *
 * Verifies env-driven provider selection + adapter registry metadata. After P1
 * the yookassa branch is REAL (initiate/capture/refund/verifyWebhook are wired
 * to fetch). Tests use stub-friendly assertions that don't require live fetch
 * (deeper provider behaviour exercised в `yookassa-provider.test.ts` via MSW).
 *
 * Coverage:
 *   - stub default: mock-mode
 *   - yookassa + APP_MODE=sandbox → sandbox-mode metadata
 *   - yookassa + APP_MODE=production → live-mode metadata
 *   - missing creds fail-loud (matches env.ts refine; defensive narrowing in factory)
 *   - empty apiBase / empty returnUrl rejected (provider constructor invariants)
 *   - exhaustive-switch guard (compile-time + runtime)
 */

import { describe, expect, test } from 'bun:test'
import { createPaymentProviderFromEnv, type PaymentProviderEnv } from './factory.ts'

const VALID_YK: Pick<
	PaymentProviderEnv,
	'yookassaShopId' | 'yookassaSecretKey' | 'yookassaApiBase' | 'yookassaReturnUrl'
> = {
	yookassaShopId: 'test_shop_123',
	yookassaSecretKey: 'test_secret_abc',
	yookassaApiBase: 'https://api.yookassa.ru/v3',
	yookassaReturnUrl: 'https://example.com/booking/payment-return',
}

const STUB_BASELINE: Omit<PaymentProviderEnv, 'paymentProvider' | 'appMode'> = {
	yookassaShopId: undefined,
	yookassaSecretKey: undefined,
	yookassaApiBase: 'https://api.yookassa.ru/v3',
	yookassaReturnUrl: 'https://example.com/booking/payment-return',
}

describe('createPaymentProviderFromEnv', () => {
	describe('stub provider', () => {
		test('returns stub provider в default dev mode', () => {
			const { provider, metadata } = createPaymentProviderFromEnv({
				paymentProvider: 'stub',
				appMode: 'sandbox',
				...STUB_BASELINE,
			})
			expect(provider.code).toBe('stub')
			expect(metadata.name).toBe('payment.stub')
			expect(metadata.category).toBe('payment')
			expect(metadata.mode).toBe('mock')
		})

		test('stub mode unchanged at APP_MODE=production (refused later by assertProductionReady)', () => {
			const { metadata } = createPaymentProviderFromEnv({
				paymentProvider: 'stub',
				appMode: 'production',
				...STUB_BASELINE,
			})
			expect(metadata.mode).toBe('mock')
		})

		test('stub capabilities exposed via factory (regression — must autocapture-mirror SBP)', () => {
			const { provider } = createPaymentProviderFromEnv({
				paymentProvider: 'stub',
				appMode: 'sandbox',
				...STUB_BASELINE,
			})
			expect(provider.capabilities.holdPeriodHours).toBe(0)
			expect(provider.capabilities.partialCapture).toBe(true)
		})
	})

	describe('yookassa provider', () => {
		test('returns yookassa provider with sandbox metadata when APP_MODE=sandbox', () => {
			const { provider, metadata } = createPaymentProviderFromEnv({
				paymentProvider: 'yookassa',
				appMode: 'sandbox',
				...VALID_YK,
			})
			expect(provider.code).toBe('yookassa')
			expect(metadata.name).toBe('payment.yookassa')
			expect(metadata.category).toBe('payment')
			expect(metadata.mode).toBe('sandbox')
			expect(metadata.providerVersion).toBe('v3')
		})

		test('returns yookassa with live metadata when APP_MODE=production', () => {
			const { metadata } = createPaymentProviderFromEnv({
				paymentProvider: 'yookassa',
				appMode: 'production',
				...VALID_YK,
			})
			expect(metadata.mode).toBe('live')
		})

		test('yookassa capabilities — T+72h hold, partial-capture, native fiscalization, correction supported', () => {
			const { provider } = createPaymentProviderFromEnv({
				paymentProvider: 'yookassa',
				appMode: 'sandbox',
				...VALID_YK,
			})
			expect(provider.capabilities.holdPeriodHours).toBe(72)
			expect(provider.capabilities.partialCapture).toBe(true)
			expect(provider.capabilities.fiscalization).toBe('native')
			expect(provider.capabilities.supportsCorrection).toBe(true)
			expect(provider.capabilities.sbpNative).toBe(false)
		})

		test('rejects missing shopId', () => {
			expect(() =>
				createPaymentProviderFromEnv({
					paymentProvider: 'yookassa',
					appMode: 'sandbox',
					yookassaShopId: undefined,
					yookassaSecretKey: 'test_secret_abc',
					yookassaApiBase: 'https://api.yookassa.ru/v3',
					yookassaReturnUrl: 'https://example.com/return',
				}),
			).toThrow(/YOOKASSA_SHOP_ID/)
		})

		test('rejects missing secretKey', () => {
			expect(() =>
				createPaymentProviderFromEnv({
					paymentProvider: 'yookassa',
					appMode: 'sandbox',
					yookassaShopId: 'test_shop_123',
					yookassaSecretKey: undefined,
					yookassaApiBase: 'https://api.yookassa.ru/v3',
					yookassaReturnUrl: 'https://example.com/return',
				}),
			).toThrow(/YOOKASSA_SHOP_ID/)
		})

		test('rejects empty-string shopId (defensive — bypasses Zod .optional() if forced)', () => {
			expect(() =>
				createPaymentProviderFromEnv({
					paymentProvider: 'yookassa',
					appMode: 'sandbox',
					yookassaShopId: '',
					yookassaSecretKey: 'test_secret_abc',
					yookassaApiBase: 'https://api.yookassa.ru/v3',
					yookassaReturnUrl: 'https://example.com/return',
				}),
			).toThrow(/YOOKASSA_SHOP_ID/)
		})

		test('rejects empty apiBase (provider constructor invariant)', () => {
			expect(() =>
				createPaymentProviderFromEnv({
					paymentProvider: 'yookassa',
					appMode: 'sandbox',
					...VALID_YK,
					yookassaApiBase: '',
				}),
			).toThrow(/apiBase/)
		})

		test('rejects empty returnUrl (PCI SAQ-A redirect requires HTTPS URL)', () => {
			expect(() =>
				createPaymentProviderFromEnv({
					paymentProvider: 'yookassa',
					appMode: 'sandbox',
					...VALID_YK,
					yookassaReturnUrl: '',
				}),
			).toThrow(/returnUrl/)
		})
	})

	describe('exhaustive switch (unknown provider)', () => {
		test('throws on unrecognized provider value (escape hatch from enum)', () => {
			expect(() =>
				createPaymentProviderFromEnv({
					// @ts-expect-error — runtime escape, simulates corrupt env
					paymentProvider: 'unknown-rail',
					appMode: 'sandbox',
					...STUB_BASELINE,
				}),
			).toThrow(/Unknown PAYMENT_PROVIDER/)
		})
	})
})
