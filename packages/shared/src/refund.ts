import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Refund domain — provider-agnostic refund row keyed by parent payment.
 *
 * Per canonical decisions (memory `project_payment_domain_canonical.md`):
 *   - One Payment → 0+ Refunds. Cumulative cap: SUM(refunds.succeeded) ≤
 *     payment.capturedMinor (canon invariant #1, the most critical money
 *     invariant in the entire payment domain).
 *   - 3-state SM: pending → succeeded | failed. Both terminal.
 *     Once `succeeded`, immutable; refund correction = new compensating row.
 *   - Money: Int64 минор копейки (same as payment + folio).
 *   - Causality marker (UNIQUE):
 *     - `userInitiated:<userId>` — manual ops refund
 *     - `dispute:<disputeId>` — auto-created on dispute lost (canon #15)
 *     - `tkassa_cancel:<paymentId>` — polymorphic T-Kassa cancel-after-capture
 *     UNIQUE prevents double-creation against the same trigger.
 *   - Provider-id UNIQUE: `(tenantId, providerCode, providerRefundId)` —
 *     dedup webhook replays at the DB level.
 */

/** 3-state Refund SM. Both `succeeded` and `failed` are terminal. */
const refundStatusValues = ['pending', 'succeeded', 'failed'] as const
export const refundStatusSchema = z.enum(refundStatusValues)
export type RefundStatus = z.infer<typeof refundStatusSchema>

/** Terminal states (once entered, no further mutation). */
export const TERMINAL_REFUND_STATUSES: readonly RefundStatus[] = ['succeeded', 'failed'] as const

/**
 * Causality marker — origin of the refund. Used as the dedup key on the
 * UNIQUE INDEX `(tenantId, causalityId)`. NULL allowed (multiple null-causality
 * refunds OK; each NULL is unique per YDB UNIQUE semantics).
 *
 * Wire format is the prefixed string; we expose helpers to construct/parse.
 */
export type RefundCausality =
	| { kind: 'userInitiated'; userId: string }
	| { kind: 'dispute'; disputeId: string }
	| { kind: 'tkassa_cancel'; paymentId: string }

/**
 * Encode a `RefundCausality` into the wire string. Inverse of `parseCausalityId`.
 */
export function encodeCausalityId(c: RefundCausality): string {
	switch (c.kind) {
		case 'userInitiated':
			return `userInitiated:${c.userId}`
		case 'dispute':
			return `dispute:${c.disputeId}`
		case 'tkassa_cancel':
			return `tkassa_cancel:${c.paymentId}`
	}
}

/**
 * Parse a causality wire string back into a tagged union. Throws on
 * unrecognized prefix — these MUST be enumerated and we want a loud signal
 * if a future kind is added without updating this parser.
 */
export function parseCausalityId(raw: string): RefundCausality {
	if (raw.startsWith('userInitiated:')) {
		return { kind: 'userInitiated', userId: raw.slice('userInitiated:'.length) }
	}
	if (raw.startsWith('dispute:')) {
		return { kind: 'dispute', disputeId: raw.slice('dispute:'.length) }
	}
	if (raw.startsWith('tkassa_cancel:')) {
		return { kind: 'tkassa_cancel', paymentId: raw.slice('tkassa_cancel:'.length) }
	}
	throw new Error(`Unrecognized refund causality: ${raw}`)
}

/** Refund amount: strictly positive Int64 копейки (canon #20 refund-amount-positive). */
const refundAmountMinorSchema = z.coerce
	.bigint()
	.refine((n) => n > 0n, 'Refund amount must be > 0')
	.refine((n) => n <= 9_223_372_036_854_775_807n, 'Overflow: must fit Int64')

/* --------------------------------------------------------------- domain rows */

/** Refund row shape (read model). Money is bigint string for JSON. */
export type Refund = {
	tenantId: string
	paymentId: string
	id: string
	providerCode: string
	providerRefundId: string | null
	causalityId: string | null
	status: RefundStatus
	/** Int64 копейки serialized as decimal string. Always > 0. */
	amountMinor: string
	currency: string
	reason: string
	version: number
	requestedAt: string
	succeededAt: string | null
	failedAt: string | null
	failureReason: string | null
	createdAt: string
	updatedAt: string
	createdBy: string
	updatedBy: string
}

/* ----------------------------------------------------------------- API inputs */

/** POST /payments/:id/refunds — create a refund request. */
export const refundCreateInput = z.object({
	amountMinor: refundAmountMinorSchema,
	reason: z.string().min(1).max(500),
	causality: z
		.discriminatedUnion('kind', [
			z.object({ kind: z.literal('userInitiated'), userId: idSchema('user') }),
			z.object({ kind: z.literal('dispute'), disputeId: idSchema('dispute') }),
			z.object({ kind: z.literal('tkassa_cancel'), paymentId: idSchema('payment') }),
		])
		.nullable()
		.optional(),
})
export type RefundCreateInput = z.infer<typeof refundCreateInput>

export const refundIdParam = z.object({ id: idSchema('refund') })
export const refundPaymentParam = z.object({ paymentId: idSchema('payment') })

export const refundListParams = z.object({
	paymentId: idSchema('payment').optional(),
	status: refundStatusSchema.optional(),
})
export type RefundListParams = z.infer<typeof refundListParams>
