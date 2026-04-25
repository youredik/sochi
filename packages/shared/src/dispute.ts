import { z } from 'zod'
import { paymentProviderCodeSchema } from './payment.ts'
import { idSchema } from './schemas.ts'

/**
 * Dispute / chargeback domain — first-class card-network case row.
 *
 * Per canonical decisions (memory `project_payment_domain_canonical.md`):
 *   - 5-state SM: opened → evidence_submitted → won | lost | expired
 *     (terminal: won/lost/expired).
 *   - won: blocks new dispute-causality refund 180d (canon invariant #5
 *     dispute-won-no-refund-180d).
 *   - lost: auto-creates compensating Refund with
 *     `causalityId='dispute:<id>'` UNIQUE (canon invariant #15
 *     refund-causality-required + canon "Dispute SM" auto-refund flow).
 *   - expired: dueAt passed without evidence → auto-lost in most cases.
 *   - Money: Int64 копейки. Disputed amount may differ from
 *     `payment.amountMinor` for partial disputes.
 *
 * One Payment → 0+ Disputes. Rare but high-impact (single dispute can be
 * 100K+ ₽). Storing as a child table mirrors network model 1:1.
 */

/* --------------------------------------------------------------- enums + SM */

const disputeStatusValues = ['opened', 'evidence_submitted', 'won', 'lost', 'expired'] as const
export const disputeStatusSchema = z.enum(disputeStatusValues)
export type DisputeStatus = z.infer<typeof disputeStatusSchema>

/** Terminal states (no further transition). */
export const TERMINAL_DISPUTE_STATUSES: readonly DisputeStatus[] = [
	'won',
	'lost',
	'expired',
] as const

/* --------------------------------------------------------------- domain rows */

/** Dispute row shape (read model). Money is bigint string for JSON. */
export type Dispute = {
	tenantId: string
	paymentId: string
	id: string
	providerCode: string
	providerDisputeId: string | null
	reasonCode: string
	status: DisputeStatus
	amountMinor: string
	currency: string
	evidenceJson: unknown | null
	dueAt: string
	submittedAt: string | null
	resolvedAt: string | null
	outcome: string | null
	representmentBlockedUntil: string | null
	version: number
	createdAt: string
	updatedAt: string
	createdBy: string
	updatedBy: string
}

/* ----------------------------------------------------------------- API inputs */

const disputeAmountMinorSchema = z.coerce
	.bigint()
	.refine((n) => n > 0n, 'amountMinor must be > 0')
	.refine((n) => n <= 9_223_372_036_854_775_807n, 'Overflow: must fit Int64')

/** POST /payments/:id/disputes — open a dispute (typically from webhook). */
export const disputeOpenInput = z.object({
	providerCode: paymentProviderCodeSchema,
	providerDisputeId: z.string().min(1).max(255).nullable().optional(),
	reasonCode: z.string().min(1).max(50),
	amountMinor: disputeAmountMinorSchema,
	currency: z.literal('RUB'),
	// Accept ISO 8601 datetime with `Z` OR `±HH:MM` offset. ЮKassa/T-Kassa
	// webhooks routinely include MSK `+03:00` offset; rejecting offsets would
	// fail every Russian dispute at the boundary. Backend normalises to UTC
	// on storage. Caught by adversarial unit test FROM START.
	dueAt: z.iso.datetime({ offset: true }),
})
export type DisputeOpenInput = z.infer<typeof disputeOpenInput>

/** PATCH /disputes/:id/evidence — attach evidence package. */
export const disputeSubmitEvidenceInput = z.object({
	evidenceJson: z.record(z.string(), z.unknown()),
})
export type DisputeSubmitEvidenceInput = z.infer<typeof disputeSubmitEvidenceInput>

/** PATCH /disputes/:id/resolve — provider webhook brings final outcome. */
export const disputeResolveInput = z.object({
	outcomeStatus: z.enum(['won', 'lost', 'expired']),
	outcome: z.string().max(2000).nullable().optional(),
})
export type DisputeResolveInput = z.infer<typeof disputeResolveInput>

export const disputeIdParam = z.object({ id: idSchema('dispute') })

export const disputeListParams = z.object({
	paymentId: idSchema('payment').optional(),
	status: disputeStatusSchema.optional(),
})
export type DisputeListParams = z.infer<typeof disputeListParams>

/** Network re-presentment block window after `won` decision. */
export const DISPUTE_REPRESENTMENT_BLOCK_DAYS = 180
