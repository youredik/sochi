/**
 * ЮKassa REST API Zod schemas (production v3, verified 2026-05-18).
 *
 * Boundary types для REST request/response. Domain types live в
 * `packages/shared/src/payment.ts` (`PaymentProviderSnapshot`, etc) — этот
 * файл маппит ЮKassa-specific shapes ↔ domain shape.
 *
 * Canon refs:
 *   - API base: `https://api.yookassa.ru/v3` (v4 не существует, verified 2026-05-18)
 *   - `project_yookassa_canon_corrections.md` (2026-04-29 empirical baseline)
 *   - Q2 2026 research (2026-05-18): `alfa_pay` added 2026-04-29, `sber_bnpl`
 *     clamped ≤50_000 RUB 2026-04-23, VAT codes 11/12 (НДС 22%) since 01.01.2026
 *
 * Sources verified 2026-05-18:
 *   - https://yookassa.ru/developers/api
 *   - https://yookassa.ru/developers/payment-acceptance/getting-started/payment-methods
 *   - https://yookassa.ru/developers/using-api/changelog
 *   - https://yookassa.ru/developers/using-api/webhooks
 */

import { z } from 'zod'

// -----------------------------------------------------------------------------
// Money (amount.value as decimal-string "100.00", per ЮKassa contract)
// -----------------------------------------------------------------------------

/**
 * Decimal string "<int>.<2 digits>". ЮKassa requires exactly 2 decimal places
 * for RUB. We never trust the wire format implicitly — strict regex.
 */
export const yookassaAmountValueSchema = z
	.string()
	.regex(/^\d+\.\d{2}$/, 'amount.value must be "<int>.<2 digits>"')

export const yookassaAmountSchema = z.object({
	value: yookassaAmountValueSchema,
	currency: z.literal('RUB'), // V1 = RUB only
})

// -----------------------------------------------------------------------------
// Payment method codes (closed enum, verified 2026-05-18)
// -----------------------------------------------------------------------------

/**
 * `payment_method_data.type` enum. Updates 2026:
 *   - `alfa_pay` added 2026-04-29 (changelog)
 *   - `sber_bnpl` clamped to ≤50_000 RUB single-tx, 2-month term only (2026-04-23)
 *   - `apple_pay` / `google_pay` REMOVED from РФ — substituted by `mir_pay` /
 *     `sber_pay` / `t_pay` / `yoo_money` (research 2026-04-29)
 */
export const yookassaPaymentMethodCodeSchema = z.enum([
	'bank_card',
	'sbp',
	'mir_pay',
	'sber_pay',
	'sber_bnpl',
	't_pay',
	'alfa_pay', // new 2026-04-29
	'yoo_money',
	'tinkoff_bank',
	'b2b_sberbank', // SBP B2B rail (payerInn mandatory 2026-07-01)
	'cash',
])

/**
 * Max value for `sber_bnpl` (Плати частями) — clamped 2026-04-23 changelog.
 * Was 150_000.00, now 50_000.00 RUB single payment. Only 2-month term.
 */
export const YOOKASSA_SBER_BNPL_MAX_RUB_KOPECKS = 50_000_00n // 50 000 ₽ в копейках

// -----------------------------------------------------------------------------
// Status (closed enum)
// -----------------------------------------------------------------------------

export const yookassaPaymentStatusSchema = z.enum([
	'pending',
	'waiting_for_capture',
	'succeeded',
	'canceled',
])

export const yookassaRefundStatusSchema = z.enum(['pending', 'succeeded', 'canceled'])

// -----------------------------------------------------------------------------
// VAT codes (54-ФЗ ФФД 1.2, updated 2026-01-01 per 376-ФЗ)
// -----------------------------------------------------------------------------

// VAT code schema lands вместе с 54-ФЗ Чеки domain (separate slice).
// Reference values (verified 2026-05-19):
//   1 — без НДС | 2 — НДС 0% (accommodation льгота до 31.12.2030)
//   3 — НДС 10% | 4 — НДС 20% (legacy)
//   5 — НДС 10/110 расчётная | 6 — НДС 20/120 расчётная (legacy)
//   7-10 — special regimes (5%, 7%, 5/105, 7/107)
//   11 — НДС 22% direct (since 2026-01-01) — production default
//   12 — НДС 22/122 расчётная (since 2026-01-01) — для advance/special regime

// -----------------------------------------------------------------------------
// Confirmation (redirect — single supported method для PCI SAQ-A path)
// -----------------------------------------------------------------------------

export const yookassaConfirmationRedirectSchema = z.object({
	type: z.literal('redirect'),
	return_url: z.string().url(),
})

export const yookassaConfirmationResponseSchema = z.object({
	type: z.literal('redirect'),
	return_url: z.string().url(),
	confirmation_url: z.string().url(),
})

// -----------------------------------------------------------------------------
// POST /v3/payments request
// -----------------------------------------------------------------------------

export const yookassaPaymentCreateRequestSchema = z.object({
	amount: yookassaAmountSchema,
	capture: z.boolean(),
	confirmation: yookassaConfirmationRedirectSchema,
	payment_method_data: z
		.object({
			type: yookassaPaymentMethodCodeSchema,
		})
		.optional(),
	description: z.string().max(128).optional(),
	metadata: z.record(z.string(), z.string()).optional(),
})

// -----------------------------------------------------------------------------
// Payment object (response shape — partial; we only validate fields we read)
// -----------------------------------------------------------------------------

export const yookassaPaymentObjectSchema = z.object({
	id: z.string().min(1).max(255),
	status: yookassaPaymentStatusSchema,
	amount: yookassaAmountSchema,
	income_amount: yookassaAmountSchema.optional(),
	confirmation: yookassaConfirmationResponseSchema.optional(),
	created_at: z.string().min(1),
	captured_at: z.string().optional(),
	expires_at: z.string().optional(),
	paid: z.boolean(),
	refundable: z.boolean().optional(),
	test: z.boolean(),
	description: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	cancellation_details: z
		.object({
			party: z.string(),
			reason: z.string(),
		})
		.optional(),
})
export type YookassaPaymentObject = z.infer<typeof yookassaPaymentObjectSchema>

// -----------------------------------------------------------------------------
// POST /v3/payments/{id}/capture request
// -----------------------------------------------------------------------------

export const yookassaCaptureRequestSchema = z.object({
	amount: yookassaAmountSchema.optional(),
})

// -----------------------------------------------------------------------------
// POST /v3/refunds request + response
// -----------------------------------------------------------------------------

export const yookassaRefundCreateRequestSchema = z.object({
	payment_id: z.string().min(1).max(255),
	amount: yookassaAmountSchema,
	description: z.string().max(250).optional(),
})

export const yookassaRefundObjectSchema = z.object({
	id: z.string().min(1).max(255),
	status: yookassaRefundStatusSchema,
	amount: yookassaAmountSchema,
	payment_id: z.string(),
	created_at: z.string(),
	description: z.string().optional(),
	cancellation_details: z
		.object({
			party: z.string(),
			reason: z.string(),
		})
		.optional(),
})
export type YookassaRefundObject = z.infer<typeof yookassaRefundObjectSchema>

// -----------------------------------------------------------------------------
// Webhook notification (closed event enum, verified 2026-05-18)
// -----------------------------------------------------------------------------

/**
 * Closed enum (verified at yookassa.ru/developers/using-api/webhooks 2026-05-18):
 *   - `refund.canceled` НЕ существует — для canceled refund poll
 *     `GET /v3/refunds/{id}` (canon 2026-04-29 holds)
 */
export const yookassaWebhookEventSchema = z.enum([
	'payment.waiting_for_capture',
	'payment.succeeded',
	'payment.canceled',
	'refund.succeeded',
	'payout.succeeded',
	'payout.canceled',
	'deal.closed',
	'payment_method.active',
])

/**
 * Generic webhook envelope — `object` shape varies by event type.
 * We do narrow type-discrimination после verify в provider.
 */
export const yookassaWebhookPayloadSchema = z.object({
	type: z.literal('notification'),
	event: yookassaWebhookEventSchema,
	object: z.unknown(), // discriminated downstream
})

// -----------------------------------------------------------------------------
// Webhook IP allowlist (CIDR), verified 2026-05-18 (unchanged from 2026-04-29)
// -----------------------------------------------------------------------------

export const YOOKASSA_WEBHOOK_IP_CIDRS = [
	'185.71.76.0/27',
	'185.71.77.0/27',
	'77.75.153.0/25',
	'77.75.154.128/25',
	'77.75.156.11/32',
	'77.75.156.35/32',
	'2a02:5180::/32',
] as const

// -----------------------------------------------------------------------------
// Money conversion helpers (kopecks Int64 ↔ ЮKassa "100.00" decimal-string)
// -----------------------------------------------------------------------------

/**
 * Convert kopecks (Int64) → ЮKassa decimal-string "100.00".
 * `100n` (kopecks) → `"1.00"`.
 */
export function kopecksToAmountValue(kopecks: bigint): string {
	if (kopecks < 0n) {
		throw new RangeError(`kopecksToAmountValue: negative kopecks ${kopecks}`)
	}
	const rubles = kopecks / 100n
	const fraction = kopecks % 100n
	return `${rubles}.${String(fraction).padStart(2, '0')}`
}

/**
 * Convert ЮKassa decimal-string "100.00" → kopecks (Int64).
 * `"1.00"` → `100n`.
 */
export function amountValueToKopecks(value: string): bigint {
	const match = /^(\d+)\.(\d{2})$/.exec(value)
	const rubles = match?.[1]
	const fraction = match?.[2]
	if (rubles === undefined || fraction === undefined) {
		throw new TypeError(`amountValueToKopecks: malformed value "${value}"`)
	}
	return BigInt(rubles) * 100n + BigInt(fraction)
}
