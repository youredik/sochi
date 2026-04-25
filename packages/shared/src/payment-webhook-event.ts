import { z } from 'zod'
import { paymentProviderCodeSchema } from './payment.ts'
import { idSchema } from './schemas.ts'

/**
 * Payment webhook event — provider-agnostic inbox row.
 *
 * Per canonical decisions (memory `project_payment_domain_canonical.md`):
 *   - Distinct from generic `webhookInbox` (0001) which is for МВД / РКЛ /
 *     channel-manager webhooks. This table is payment-domain-only with
 *     tenantId NOT NULL.
 *   - PK is `(tenantId, providerCode, dedupKey)` — duplicate redelivery
 *     hits PK collision, translated to domain `WebhookAlreadyProcessedError`
 *     via canonical `err.cause.code === 400120` pattern (M6.2/M6.3).
 *   - Provider-specific dedup key construction (canon "Webhook
 *     signature/dedup matrix"):
 *       * T-Kassa: HMAC-SHA256-verified `event_id` from header
 *       * ЮKassa: synthesized
 *         `${providerPaymentId}|${event}|${status}|${amount_value}`
 *       * СБП (НСПК): mTLS cert verified + НСПК `transactionId`
 *       * Stub: header `X-Stub-Signature: stub-ok` + UUID(requestId)
 *   - 30-day TTL on `verifiedAt` covers max replay window
 *     (T-Kassa 24h + ЮKassa 14d + dispute correlation 30d).
 *   - NO CHANGEFEED — event sink table (downstream effects emit own events).
 */

/* --------------------------------------------------------------- domain rows */

/** Inbox row shape (read model). */
export type PaymentWebhookEvent = {
	tenantId: string
	providerCode: string
	dedupKey: string
	eventType: string
	providerPaymentId: string | null
	providerRefundId: string | null
	payloadJson: unknown
	signatureHeader: string | null
	sourceIp: string | null
	verifiedAt: string
	processedAt: string | null
	processingError: string | null
	processedBy: string | null
}

/* ----------------------------------------------------------------- API inputs */

/**
 * Inbound webhook envelope normalized AFTER signature verification —
 * NEVER call this with un-verified bytes. HMAC is checked on raw bytes
 * BEFORE JSON.parse (canon: signature verify on raw bytes).
 */
export const paymentWebhookEventInsert = z.object({
	tenantId: idSchema('organization'),
	providerCode: paymentProviderCodeSchema,
	dedupKey: z.string().min(1).max(512),
	eventType: z.string().min(1).max(100),
	providerPaymentId: z.string().min(1).max(255).nullable().optional(),
	providerRefundId: z.string().min(1).max(255).nullable().optional(),
	payloadJson: z.unknown(),
	signatureHeader: z.string().max(1024).nullable().optional(),
	sourceIp: z
		.string()
		.max(45) // IPv6 max
		.nullable()
		.optional(),
})
export type PaymentWebhookEventInsert = z.infer<typeof paymentWebhookEventInsert>

/* --------------------------------------------------------- dedup-key helpers */

/**
 * Synthesize a stable ЮKassa dedup key from webhook payload fields.
 *
 * ЮKassa does NOT sign webhooks (IP allowlist only — see canon "Webhook
 * signature/dedup matrix"). To make replays idempotent, we construct a
 * deterministic key from the fields that uniquely identify the event:
 * payment id + event name + status + amount.value (kopecks-string).
 *
 * Example output:
 *   `2c9b4e8f-...|payment.succeeded|succeeded|159000`
 */
export function synthesizeYookassaDedupKey(args: {
	providerPaymentId: string
	event: string
	status: string
	amountValue: string
}): string {
	return `${args.providerPaymentId}|${args.event}|${args.status}|${args.amountValue}`
}
