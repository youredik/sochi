import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Payment domain — provider-agnostic payment intent + state machine.
 *
 * Per canonical decisions (memory `project_payment_domain_canonical.md`):
 *   - One booking → 1+ payments (multiple captures, partial pre-pays,
 *     deposit then settlement). Each payment carries one provider intent.
 *   - 9-state Payment SM: created → pending → waiting_for_capture → succeeded
 *     → partially_refunded → refunded; alt: failed | canceled | expired.
 *     Terminal: failed/canceled/expired/refunded. Pseudo-terminal:
 *     succeeded/partially_refunded (mutate only via Refund children).
 *   - Money: Int64 минор копейки (NOT amountMicros). Three columns:
 *     `amountMinor` (intent), `authorizedMinor` (actually authorized),
 *     `capturedMinor` (actually captured). For SBP/stub: all three equal
 *     on success.
 *   - Provider-agnostic: 4 providers (stub/yookassa/tkassa/sbp), all behind
 *     one `PaymentProvider` interface. `digital_ruble` reserved for
 *     2026-09-01 mandate.
 *   - 2026-2027 reservation columns: `payerInn` (СБП B2B 01.07.2026),
 *     `saleChannel` (289-ФЗ 01.10.2026), `anomalyScore` (ML).
 *   - IETF Idempotency-Key dedup via UNIQUE `(tenantId, idempotencyKey)`.
 *   - Provider webhook dedup via UNIQUE `(tenantId, providerCode,
 *     providerPaymentId)` — NULL allowed multiple times (each NULL unique
 *     per YDB UNIQUE semantics).
 */

/**
 * 9-state Payment SM. Order matters for some derived helpers (e.g.
 * `isTerminal` checks against the terminal subset).
 *
 *   created → pending: `system.providerCall` (initiate sent)
 *   pending → waiting_for_capture: webhook (auth-hold for ЮKassa-style flow)
 *   pending → succeeded: webhook (autocapture path: SBP, stub, ЮKassa autocap=true)
 *   pending → failed: webhook (preauth_decline, 3ds_failed, fraud_suspected)
 *   waiting_for_capture → succeeded: user/system.capture
 *   waiting_for_capture → canceled: user.void (no-show, manual)
 *   waiting_for_capture → expired: scheduler (T+holdPeriodHours)
 *   succeeded → partially_refunded: derived (sum(refunds.succeeded) > 0 && < captured)
 *   succeeded → refunded: derived (sum(refunds.succeeded) === captured)
 *   partially_refunded → refunded: derived (cumulative full)
 */
const paymentStatusValues = [
	'created',
	'pending',
	'waiting_for_capture',
	'succeeded',
	'partially_refunded',
	'refunded',
	'canceled',
	'failed',
	'expired',
] as const
export const paymentStatusSchema = z.enum(paymentStatusValues)
export type PaymentStatus = z.infer<typeof paymentStatusSchema>

/** Terminal states (no further mutation allowed except via Refund children for the post-capture pair). */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
	'refunded',
	'canceled',
	'failed',
	'expired',
] as const

/**
 * Provider taxonomy. `digital_ruble` reserved per 01.09.2026 federal mandate
 * (>120М ₽ turnover compulsory). Adding the enum value now keeps the schema
 * forward-compatible without a migration.
 */
const paymentProviderCodeValues = ['stub', 'yookassa', 'tkassa', 'sbp', 'digital_ruble'] as const
export const paymentProviderCodeSchema = z.enum(paymentProviderCodeValues)
export type PaymentProviderCode = z.infer<typeof paymentProviderCodeSchema>

/**
 * Payment method (different from provider; e.g. `yookassa` provider supports
 * `card`, `sbp`, `bank_transfer` methods). `digital_ruble` is method+provider
 * combined per CBR design (01.09.2026 rollout).
 */
const paymentMethodValues = [
	'card',
	'sbp',
	'digital_ruble',
	'cash',
	'bank_transfer',
	'stub',
] as const
export const paymentMethodSchema = z.enum(paymentMethodValues)
export type PaymentMethod = z.infer<typeof paymentMethodSchema>

/**
 * Sale channel for 289-ФЗ Платформенная экономика (01.10.2026):
 *   direct   — hotel-to-guest (default)
 *   ota      — booked via OTA (Yandex.Travel, Ostrovok, etc.)
 *   platform — via a 289-ФЗ regulated digital platform (separate enum slot
 *              because regulatory reporting requirements differ from OTA)
 */
const paymentSaleChannelValues = ['direct', 'ota', 'platform'] as const
export const paymentSaleChannelSchema = z.enum(paymentSaleChannelValues)
export type PaymentSaleChannel = z.infer<typeof paymentSaleChannelSchema>

const currencySchema = z
	.string()
	.length(3)
	.regex(/^[A-Z]{3}$/, 'Expected ISO 4217 currency code')

/** Int64 копейки serialization. Coerced from string|number|bigint. Must be non-negative for amount. */
const bigIntMinorAmountSchema = z.coerce
	.bigint()
	.nonnegative()
	.refine((n) => n <= 9_223_372_036_854_775_807n, 'Overflow: must fit Int64')

/** ML anomaly score in [0, 1]. Nullable column; explicit number when set. Used by ML pipeline V2. */
export const anomalyScoreSchema = z.coerce.number().min(0).max(1)

/** ИНН validation. RU INN is 10 digits (юр.лицо) or 12 digits (физлицо/ИП). */
const innSchema = z.string().regex(/^(\d{10}|\d{12})$/, 'Expected RU ИНН (10 or 12 digits)')

/** Idempotency-Key per IETF draft-07. We accept any non-empty string up to 255 chars (Stripe-compatible). */
const idempotencyKeySchema = z.string().min(1).max(255)

/* --------------------------------------------------------------- domain rows */

/** Payment row shape (read model). Money fields are bigint string for JSON. */
export type Payment = {
	tenantId: string
	propertyId: string
	bookingId: string
	id: string
	folioId: string | null
	providerCode: PaymentProviderCode
	providerPaymentId: string | null
	confirmationUrl: string | null
	method: PaymentMethod
	status: PaymentStatus
	/** Int64 копейки serialized as decimal string. */
	amountMinor: string
	authorizedMinor: string
	capturedMinor: string
	currency: string
	idempotencyKey: string
	version: number
	payerInn: string | null
	saleChannel: PaymentSaleChannel
	anomalyScore: number | null
	holdExpiresAt: string | null
	createdAt: string
	updatedAt: string
	authorizedAt: string | null
	capturedAt: string | null
	refundedAt: string | null
	canceledAt: string | null
	failedAt: string | null
	expiredAt: string | null
	failureReason: string | null
	createdBy: string
	updatedBy: string
}

/* ----------------------------------------------------------------- API inputs */

/**
 * POST /properties/:propertyId/bookings/:bookingId/payments — create a payment intent.
 *
 * Note: `idempotencyKey` is canonically passed via the `Idempotency-Key` HTTP
 * header (IETF draft-07 §3); we mirror it into the body for ergonomic test
 * fixtures. Real route handlers MUST prefer the header.
 */
export const paymentCreateInput = z.object({
	folioId: idSchema('folio').nullable().optional(),
	providerCode: paymentProviderCodeSchema,
	method: paymentMethodSchema,
	amountMinor: bigIntMinorAmountSchema,
	currency: currencySchema.default('RUB'),
	idempotencyKey: idempotencyKeySchema,
	saleChannel: paymentSaleChannelSchema.default('direct'),
	payerInn: innSchema.nullable().optional(),
})
export type PaymentCreateInput = z.infer<typeof paymentCreateInput>

/** PATCH /payments/:id/capture — manual capture of a `waiting_for_capture` row. */
export const paymentCaptureInput = z.object({
	/** Partial capture amount; null = capture full authorized. */
	amountMinor: bigIntMinorAmountSchema.nullable().optional(),
})
export type PaymentCaptureInput = z.infer<typeof paymentCaptureInput>

/** PATCH /payments/:id/cancel — void a payment before capture (waiting_for_capture only). */
export const paymentCancelInput = z.object({
	reason: z.string().min(1).max(500),
})
export type PaymentCancelInput = z.infer<typeof paymentCancelInput>

/* --------------------------------------------------------------- id params */

export const paymentIdParam = z.object({ id: idSchema('payment') })

export const paymentBookingParam = z.object({
	propertyId: idSchema('property'),
	bookingId: idSchema('booking'),
})

/* ------------------------------------------------------------- list filters */

export const paymentListParams = z.object({
	bookingId: idSchema('booking').optional(),
	folioId: idSchema('folio').optional(),
	status: paymentStatusSchema.optional(),
	providerCode: paymentProviderCodeSchema.optional(),
})
export type PaymentListParams = z.infer<typeof paymentListParams>

/* ============================================================ provider types */

/**
 * Provider capability matrix. Used by service layer to gate UI affordances
 * (e.g. "Show partial-capture button" only for providers that support it)
 * and pick the right strategy per provider.
 */
export type PaymentProviderCapabilities = {
	/** Whether the provider supports capturing less than the authorized amount. */
	partialCapture: boolean
	/** Auth-hold lifetime in hours (T+72 for ЮKassa, T+168 for T-Kassa). 0 if synchronous. */
	holdPeriodHours: number
	/** Whether SBP (НСПК) is the native rail. SBP-native skips waiting_for_capture state. */
	sbpNative: boolean
	/** Native 54-ФЗ fiscalization (e.g. ЮKassa Чеки) or external provider needed. */
	fiscalization: 'native' | 'external' | 'none'
	/** Чек коррекции (correction cheque) supported (54-ФЗ requirement for tax error fix-up). */
	supportsCorrection: boolean
}

/**
 * Snapshot of a provider's view of a payment. `PaymentProvider` methods
 * return this shape so the service layer can reconcile against the local
 * Payment row without parsing provider-specific JSON.
 */
export type PaymentProviderSnapshot = {
	providerPaymentId: string
	status: PaymentStatus
	/** Authorized amount as the provider sees it. Use for reconciliation. */
	authorizedMinor: bigint
	/** Captured amount as the provider sees it. Use for reconciliation. */
	capturedMinor: bigint
	/** Optional redirect URL for hosted-checkout (ЮKassa-style). */
	confirmationUrl: string | null
	/** Optional hold expiry timestamp (ISO). null for synchronous providers. */
	holdExpiresAt: string | null
	/** Free-form failure reason from provider (PAN never included). */
	failureReason: string | null
}

/**
 * Snapshot of a refund as the provider sees it. Returned from
 * `PaymentProvider.refund` and `cancel` (when cancel-after-capture is
 * polymorphically a refund — T-Kassa pattern).
 */
export type RefundProviderSnapshot = {
	providerRefundId: string
	status: 'pending' | 'succeeded' | 'failed'
	amountMinor: bigint
	failureReason: string | null
}

/**
 * Initiate a new payment intent at the provider. Caller passes the local
 * payment row's identity + amount; provider returns its own id (and optional
 * redirect URL for hosted checkout).
 */
export type PaymentInitiateRequest = {
	/** Local payment id, used to correlate webhook back to the row. */
	localPaymentId: string
	method: PaymentMethod
	amountMinor: bigint
	currency: string
	/** Idempotency key — the provider's own dedup, NOT our IETF header. */
	providerIdempotencyKey: string
	/** Optional metadata to attach (provider-specific limits, e.g. ЮKassa 16 keys × 512B). */
	metadata?: Record<string, string>
}

/** Refund request (provider-agnostic). */
export type PaymentRefundRequest = {
	providerPaymentId: string
	amountMinor: bigint
	/** Idempotency-key for the refund (separate namespace from payment idempotency). */
	providerIdempotencyKey: string
	reason: string
}

/**
 * Verified webhook event after signature/IP check. Caller must NOT trust the
 * raw body until verifyWebhook returns this struct.
 */
export type VerifiedWebhookEvent = {
	/** Provider's event id (HMAC-derived for T-Kassa, synthesized for ЮKassa). */
	dedupKey: string
	providerCode: PaymentProviderCode
	/** Subject of the event — payment status change OR refund status change. */
	subject:
		| { kind: 'payment'; snapshot: PaymentProviderSnapshot }
		| { kind: 'refund'; refund: RefundProviderSnapshot; parentProviderPaymentId: string }
	receivedAt: string
}

/**
 * Canonical PaymentProvider interface. All 4 implementations
 * (StubPaymentProvider, YooKassaPaymentProvider, TKassaPaymentProvider,
 * SbpPaymentProvider) MUST conform without runtime adapters.
 *
 * All methods MUST:
 *   - Be retry-safe — caller may invoke twice with same idempotency key.
 *   - Map provider-specific errors to a stable shape (provider classes own
 *     their error taxonomy; we surface `failureReason` only).
 *   - NEVER return PAN or full card data; hosted checkout pattern only.
 */
export interface PaymentProvider {
	readonly code: PaymentProviderCode
	readonly capabilities: PaymentProviderCapabilities

	/**
	 * Initiate a fresh payment at the provider. Returns the provider's id +
	 * optional redirect URL. Does NOT capture the payment yet — that's a
	 * separate step (or auto-capture for SBP/stub).
	 */
	initiate(req: PaymentInitiateRequest): Promise<PaymentProviderSnapshot>

	/**
	 * Capture an authorized amount. `amountMinor === null` means capture full
	 * authorized (most common case). Partial capture supported per
	 * `capabilities.partialCapture`.
	 */
	capture(providerPaymentId: string, amountMinor: bigint | null): Promise<PaymentProviderSnapshot>

	/**
	 * Cancel a payment. Polymorphic per provider:
	 *   - Pre-capture: void; returns PaymentProviderSnapshot with status='canceled'.
	 *   - Post-capture (T-Kassa): auto-creates a refund; returns
	 *     RefundProviderSnapshot. Caller distinguishes via `'providerRefundId' in result`.
	 */
	cancel(providerPaymentId: string): Promise<PaymentProviderSnapshot | RefundProviderSnapshot>

	/** Issue a refund against a captured payment. Partial supported. */
	refund(req: PaymentRefundRequest): Promise<RefundProviderSnapshot>

	/**
	 * Verify webhook authenticity (HMAC for T-Kassa, IP allowlist + synth
	 * dedupKey for ЮKassa, mTLS for СБП). MUST happen on raw body before
	 * JSON.parse to avoid signature drift through middleware.
	 */
	verifyWebhook(headers: Headers, rawBody: Uint8Array): Promise<VerifiedWebhookEvent>

	/**
	 * Explicitly release any residual auth-hold on a partial capture.
	 * No-op for providers that auto-release (ЮKassa); explicit call for T-Kassa.
	 */
	releaseResidualHold(providerPaymentId: string): Promise<void>
}
