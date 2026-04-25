/**
 * `payment_status_writer` CDC handler — listens on `refund/refund_events`
 * and derives the parent payment's status from the cumulative refund
 * projection (canon invariant #23 partial-refund-derived-flag).
 *
 * Logic:
 *   On a refund transition INTO `succeeded`:
 *     1. Load parent payment (refund.paymentId → payment.id).
 *     2. SUM(amountMinor) for all refunds with status='succeeded' on this
 *        payment, in the SAME tx (read-your-write isolation: includes the
 *        refund whose succeeded transition just fired).
 *     3. derivedStatus = deriveRefundStatus(payment.capturedMinor, sumSucceeded)
 *          - 0 < refunded < captured  → 'partially_refunded'
 *          - refunded === captured    → 'refunded'
 *          - refunded === 0           → 'succeeded' (no-op, already there)
 *     4. If derivedStatus !== payment.status AND canTransitionForProvider:
 *        full-row UPSERT with status=derived, version+=1, refundedAt=now if
 *        derived='refunded'.
 *
 * Trigger gate (forward-only):
 *   - newImage.status === 'succeeded' AND oldImage.status !== 'succeeded'
 *     → fires (the refund just entered succeeded).
 *   - All other paths skip (refund.failed, idempotent redelivery,
 *     transitions into pending, etc.) so we don't double-derive.
 *
 * Idempotency: pre-check `derivedStatus === payment.status` short-circuits
 * before any UPSERT. If the projection runs twice for the same refund event
 * (commit-acks-lost replay), the second run sees the already-derived
 * payment.status and skips.
 *
 * Concurrency / OCC:
 *   payment.version is bumped exactly +1 on transition. Two refunds
 *   transitioning to succeeded concurrently → both consumers race to bump
 *   payment. The serializable tx + version-CAS make one win; the loser's
 *   tx surfaces a conflict and `sql.begin({ idempotent: true })` retries.
 *   On retry, the SUM and current.status reflect the winner — second
 *   derivation either no-ops or transitions further (succeeded →
 *   partially_refunded → refunded).
 *
 * Why raw SQL not the payment repo:
 *   `payment.repo.applyTransition` uses its own `sql.begin` — nesting
 *   would surface TRANSACTION_LOCKS_INVALIDATED. Handler runs inside the
 *   cdc-consumer's outer tx and does the full-row UPSERT inline.
 */

import type { PaymentProviderCode, PaymentStatus } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import { NULL_FLOAT, NULL_TIMESTAMP, textOpt, timestampOpt, toTs } from '../../db/ydb-helpers.ts'
import {
	canTransitionForProvider,
	deriveRefundStatus,
} from '../../domains/payment/lib/payment-transitions.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import type { HandlerLogger } from './refund-creator.ts'

const REFUND_SUCCEEDED_STATUS = 'succeeded'
const PAYMENT_STATUS_WRITER_ACTOR_ID = 'system:payment_status_writer'

type PaymentRow = {
	tenantId: string
	propertyId: string
	bookingId: string
	id: string
	folioId: string | null
	providerCode: string
	providerPaymentId: string | null
	confirmationUrl: string | null
	method: string
	status: string
	amountMinor: number | bigint
	authorizedMinor: number | bigint
	capturedMinor: number | bigint
	currency: string
	idempotencyKey: string
	version: number | bigint
	payerInn: string | null
	saleChannel: string
	anomalyScore: number | null
	holdExpiresAt: Date | null
	createdAt: Date
	updatedAt: Date
	authorizedAt: Date | null
	capturedAt: Date | null
	refundedAt: Date | null
	canceledAt: Date | null
	failedAt: Date | null
	expiredAt: Date | null
	failureReason: string | null
	createdBy: string
	updatedBy: string
}

/**
 * Build the CDC projection. Returns a `(tx, event) => Promise<void>` that
 * derives parent payment status from refund-events.
 */
export function createPaymentStatusHandler(log: HandlerLogger) {
	return async (tx: TX, event: CdcEvent): Promise<void> => {
		// Trigger gate — forward-only on refund's succeeded transition.
		const newStatus = event.newImage?.status
		const oldStatus = event.oldImage?.status
		if (newStatus !== REFUND_SUCCEEDED_STATUS) return
		if (oldStatus === REFUND_SUCCEEDED_STATUS) return

		// Refund PK 3D: (tenantId, paymentId, id) — see migration 0009.
		const key = event.key ?? []
		if (key[0] === undefined || key[1] === undefined) {
			log.warn({ key }, 'payment_status: malformed refund event key — skipping')
			return
		}
		const tenantId = String(key[0])
		const paymentId = String(key[1])

		// Load parent payment via VIEW-less scan; PK starts with tenantId.
		const [paymentRows = []] = await tx<PaymentRow[]>`
			SELECT * FROM payment WHERE tenantId = ${tenantId} AND id = ${paymentId} LIMIT 1
		`
		const payment = paymentRows[0]
		if (!payment) {
			log.warn(
				{ tenantId, paymentId },
				'payment_status: parent payment not found — skipping (race or orphan refund)',
			)
			return
		}

		// SUM succeeded refunds for this payment. PK starts (tenantId, paymentId)
		// → single-shard range scan. COALESCE handles empty result (returns 0n).
		const [sumRows = []] = await tx<{ sumMinor: number | bigint }[]>`
			SELECT COALESCE(SUM(amountMinor), 0) AS sumMinor FROM refund
			WHERE tenantId = ${tenantId}
			  AND paymentId = ${paymentId}
			  AND status = ${REFUND_SUCCEEDED_STATUS}
		`
		const sumSucceeded = BigInt(sumRows[0]?.sumMinor ?? 0)
		const capturedMinor = BigInt(payment.capturedMinor)

		let derivedStatus: 'succeeded' | 'partially_refunded' | 'refunded'
		try {
			derivedStatus = deriveRefundStatus(capturedMinor, sumSucceeded)
		} catch (err) {
			log.warn(
				{
					err,
					tenantId,
					paymentId,
					capturedMinor: capturedMinor.toString(),
					sumSucceeded: sumSucceeded.toString(),
				},
				'payment_status: deriveRefundStatus threw (cap violation or negative) — skipping',
			)
			return
		}

		// Idempotent skip: already at the derived status.
		if (derivedStatus === payment.status) {
			log.debug(
				{ tenantId, paymentId, derivedStatus },
				'payment_status: derived equals current — idempotent skip',
			)
			return
		}

		// SM guard. Provider gate via canTransitionForProvider so SBP /
		// stub / yookassa-specific edges (e.g. sbp-no-preauth canon #17)
		// are honoured the same way as service-layer applyTransition.
		const providerCode = payment.providerCode as PaymentProviderCode
		if (!canTransitionForProvider(providerCode, payment.status as PaymentStatus, derivedStatus)) {
			log.warn(
				{
					tenantId,
					paymentId,
					from: payment.status,
					to: derivedStatus,
					providerCode,
				},
				'payment_status: forbidden SM transition — skipping (state drift?)',
			)
			return
		}

		// Full-row UPSERT with version+1 and the right state-transition timestamp.
		const now = new Date()
		const nowTs = toTs(now)
		const newVersion = Number(payment.version) + 1
		const refundedAtBind =
			derivedStatus === 'refunded'
				? toTs(now)
				: payment.refundedAt
					? toTs(payment.refundedAt)
					: NULL_TIMESTAMP

		await tx`
			UPSERT INTO payment (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`folioId\`,
				\`providerCode\`, \`providerPaymentId\`, \`confirmationUrl\`, \`method\`,
				\`status\`,
				\`amountMinor\`, \`authorizedMinor\`, \`capturedMinor\`, \`currency\`,
				\`idempotencyKey\`, \`version\`,
				\`payerInn\`, \`saleChannel\`, \`anomalyScore\`, \`holdExpiresAt\`,
				\`createdAt\`, \`updatedAt\`,
				\`authorizedAt\`, \`capturedAt\`, \`refundedAt\`,
				\`canceledAt\`, \`failedAt\`, \`expiredAt\`,
				\`failureReason\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${payment.tenantId}, ${payment.propertyId}, ${payment.bookingId}, ${payment.id},
				${textOpt(payment.folioId)},
				${payment.providerCode}, ${textOpt(payment.providerPaymentId)},
				${textOpt(payment.confirmationUrl)}, ${payment.method},
				${derivedStatus},
				${BigInt(payment.amountMinor)}, ${BigInt(payment.authorizedMinor)},
				${BigInt(payment.capturedMinor)}, ${payment.currency},
				${payment.idempotencyKey}, ${newVersion},
				${textOpt(payment.payerInn)}, ${payment.saleChannel},
				${payment.anomalyScore ?? NULL_FLOAT},
				${timestampOpt(payment.holdExpiresAt)},
				${toTs(payment.createdAt)}, ${nowTs},
				${timestampOpt(payment.authorizedAt)},
				${timestampOpt(payment.capturedAt)},
				${refundedAtBind},
				${timestampOpt(payment.canceledAt)},
				${timestampOpt(payment.failedAt)},
				${timestampOpt(payment.expiredAt)},
				${textOpt(payment.failureReason)},
				${payment.createdBy}, ${PAYMENT_STATUS_WRITER_ACTOR_ID}
			)
		`

		log.info(
			{
				tenantId,
				paymentId,
				from: payment.status,
				to: derivedStatus,
				sumSucceeded: sumSucceeded.toString(),
				capturedMinor: capturedMinor.toString(),
			},
			'payment_status: parent payment status derived from refunds',
		)
	}
}
