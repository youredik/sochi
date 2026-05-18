/**
 * Payment provider factory — selects `stub` | `yookassa` per env.
 *
 * P1 (2026-05-18) — env-driven switch + REAL ЮKassa REST adapter (initiate /
 * capture / cancel / refund / verifyWebhook). Resilience via Cockatiel 3.2,
 * IP allowlist канон + Idempotence-Key header dedup per ЮKassa v3 spec.
 *
 * Registry metadata semantics:
 *   - `stub`                            → `payment.stub`     mode='mock'
 *   - `yookassa` + APP_MODE=sandbox     → `payment.yookassa` mode='sandbox'
 *   - `yookassa` + APP_MODE=production  → `payment.yookassa` mode='live'
 *
 * `assertProductionReady()` (registry.ts) rejects startup if mode='mock' OR
 * 'sandbox' under APP_MODE=production without explicit whitelist.
 */

import type { PaymentProvider } from '@horeca/shared'
import type { AdapterMetadata } from '../../../lib/adapters/types.ts'
import { createStubPaymentProvider } from './stub-provider.ts'
import { createYooKassaPaymentProvider } from './yookassa-provider.ts'

/**
 * Subset of `env` consumed by the provider factory. Explicit subset (not
 * dependency on `env.ts`) keeps factory.ts unit-testable without booting
 * the whole env schema.
 */
export type PaymentProviderEnv = {
	paymentProvider: 'stub' | 'yookassa'
	appMode: 'sandbox' | 'production'
	yookassaShopId: string | undefined
	yookassaSecretKey: string | undefined
	yookassaApiBase: string
	/**
	 * Default `return_url` для ЮKassa confirmation redirect. Caller can override
	 * per-request via `metadata.returnUrl`. PCI SAQ-A path requires HTTPS in
	 * production. Convention: `${PUBLIC_BASE_URL}/booking/payment-return`.
	 */
	yookassaReturnUrl: string
}

export type CreatePaymentProviderResult = {
	provider: PaymentProvider
	metadata: AdapterMetadata
}

export function createPaymentProviderFromEnv(env: PaymentProviderEnv): CreatePaymentProviderResult {
	if (env.paymentProvider === 'stub') {
		return {
			provider: createStubPaymentProvider(),
			metadata: {
				name: 'payment.stub',
				category: 'payment',
				mode: 'mock',
				description:
					'In-process payment stub (synchronous-success autocapture, mirrors СБП rail). ' +
					'Switch via PAYMENT_PROVIDER=yookassa when sandbox credentials available.',
			},
		}
	}
	if (env.paymentProvider === 'yookassa') {
		// `env.refine` уже гарантирует обоих, но defensive-narrowing для
		// TypeScript control-flow + ясное сообщение операторам если refinement
		// был обойдён (e.g. test seeds bypass parse).
		if (!env.yookassaShopId || !env.yookassaSecretKey) {
			throw new Error(
				'PAYMENT_PROVIDER=yookassa requires YOOKASSA_SHOP_ID + YOOKASSA_SECRET_KEY. ' +
					'Get sandbox creds at https://yookassa.ru/my (test_xxx keys, free, instant).',
			)
		}
		const provider = createYooKassaPaymentProvider({
			shopId: env.yookassaShopId,
			secretKey: env.yookassaSecretKey,
			apiBase: env.yookassaApiBase,
			returnUrl: env.yookassaReturnUrl,
		})
		return {
			provider,
			metadata: {
				name: 'payment.yookassa',
				category: 'payment',
				mode: env.appMode === 'production' ? 'live' : 'sandbox',
				description:
					'ЮKassa REST adapter (api.yookassa.ru/v3). HTTP Basic auth, ' +
					'Idempotence-Key dedup, IP allowlist webhook verify (NO HMAC). ' +
					'Test mode = test_xxx shopId+secretKey; live mode = production creds in APP_MODE=production.',
				providerVersion: 'v3',
			},
		}
	}
	// Closed enum already exhausted; exhaustive switch для future provider additions.
	const _exhaustive: never = env.paymentProvider
	throw new Error(`Unknown PAYMENT_PROVIDER: ${String(_exhaustive)}`)
}
