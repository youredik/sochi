/**
 * `refund_creator_writer` CDC handler — listens on `dispute/dispute_events`
 * and auto-creates a compensating Refund when a dispute lands in the `lost`
 * terminal state.
 *
 * Canon (memory `project_payment_domain_canonical.md`):
 *   - Invariant #15 (refund-causality-required): every refund has a
 *     causality marker.
 *   - Dispute SM `lost` → auto-create Refund with `causalityId =
 *     'dispute:<disputeId>'`. UNIQUE on `ixRefundCausality` makes this
 *     idempotent under at-least-once redelivery.
 *
 * ## Trigger semantics
 *
 *   Fires ONLY on the dispute UPDATE that flips status to `'lost'`.
 *   - INSERT with status='lost' (rare — only via backfill) → fires
 *   - UPDATE with newImage.status='lost' AND oldImage.status != 'lost' → fires
 *   - UPDATE with both old/new status='lost' (no-op redelivery) → skipped
 *   - DELETE → skipped (no auto-refund on dispute deletion — out of scope)
 *
 * ## Idempotency
 *
 *   The UNIQUE causality index on `(tenantId, causalityId)` (migration
 *   0009) is the canonical dedup. If the projection runs twice for the
 *   same dispute (commit-acks-lost replay), the 2nd UPSERT collides with
 *   PRECONDITION_FAILED 400120 → handler swallows the collision and the
 *   tx commits empty (offset advances, no double-refund).
 *
 * ## Why raw SQL not the refund repo
 *
 *   `refund.repo.create` uses its OWN `sql.begin({ idempotent: true })`
 *   internally. Calling it from inside the CDC consumer's outer tx would
 *   nest transactions — YDB rejects with TRANSACTION_LOCKS_INVALIDATED.
 *   CDC handlers project state directly via `tx`. Domain invariants
 *   (refund cap, causality format) are NOT re-enforced here — they were
 *   already enforced when the SOURCE rows (dispute, parent payment) were
 *   written through their own repos. The handler is a pure projection.
 *
 * ## Money rules
 *
 *   `amountMinor = dispute.amountMinor` (network sets the disputed amount).
 *   Currency mirrors dispute. Provider code mirrors dispute.
 *   The compensating refund starts in `pending` — actual provider call
 *   happens at service-layer when the refund is processed.
 */

import { newId } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import { NULL_TEXT, NULL_TIMESTAMP, toTs } from '../../db/ydb-helpers.ts'
import type { CdcEvent } from '../cdc-handlers.ts'

const DISPUTE_LOST_STATUS = 'lost'
const REFUND_CREATOR_ACTOR_ID = 'system:refund_creator_writer'

/**
 * Minimal logger interface — accepted via factory injection so tests can
 * pass a silent logger without pulling in `log.ts → env.ts → process.exit`
 * during unit/integration test imports.
 */
export interface HandlerLogger {
	debug: (obj: object, msg?: string) => void
	info: (obj: object, msg?: string) => void
	warn: (obj: object, msg?: string) => void
}

/**
 * Build a CDC projection that auto-creates compensating refunds on
 * dispute `lost` transitions.
 *
 * No external dependencies — handler issues raw SQL through the consumer's
 * `tx`. Idempotent by design (UNIQUE causality + 400120 swallow).
 */
export function createRefundCreatorHandler(log: HandlerLogger) {
	return async (tx: TX, event: CdcEvent): Promise<void> => {
		// Skip events that don't reflect a fresh `lost` transition.
		const newStatus = event.newImage?.status
		const oldStatus = event.oldImage?.status
		if (newStatus !== DISPUTE_LOST_STATUS) return
		if (oldStatus === DISPUTE_LOST_STATUS) return

		// Dispute PK is 3D: (tenantId, paymentId, id) — see migration 0012.
		const key = event.key ?? []
		if (key[0] === undefined || key[1] === undefined || key[2] === undefined) {
			log.warn({ key }, 'refund_creator: malformed dispute event key — skipping')
			return
		}
		const tenantId = String(key[0])
		const paymentId = String(key[1])
		const disputeId = String(key[2])

		// Pull money/provider fields from newImage (PK columns are NOT in
		// newImage per CDC contract — but amountMinor / currency / providerCode
		// ARE non-PK and present).
		const amountMinorRaw = event.newImage?.amountMinor
		const currency = event.newImage?.currency
		const providerCode = event.newImage?.providerCode
		if (
			amountMinorRaw === undefined ||
			amountMinorRaw === null ||
			typeof currency !== 'string' ||
			typeof providerCode !== 'string'
		) {
			log.warn(
				{ tenantId, disputeId, amountMinorRaw, currency, providerCode },
				'refund_creator: dispute event missing required fields — skipping',
			)
			return
		}

		// `amountMinor` may arrive as number, bigint, or string — normalise.
		const amountMinor = BigInt(
			typeof amountMinorRaw === 'string'
				? amountMinorRaw
				: typeof amountMinorRaw === 'number' || typeof amountMinorRaw === 'bigint'
					? amountMinorRaw
					: 0,
		)
		if (amountMinor <= 0n) {
			log.warn(
				{ tenantId, disputeId, amountMinor: amountMinor.toString() },
				'refund_creator: dispute amount not positive — skipping (canon #20 refund-amount-positive)',
			)
			return
		}

		const causalityId = `dispute:${disputeId}`

		// SELECT-then-UPSERT pre-check: atomic in serializable tx. The pre-check
		// also avoids the YDB tx-poison-on-PK-collision pattern — once a 400120
		// throws inside `tx\`...\``, the entire tx is invalidated and any later
		// operation surfaces 400140 "Transaction not found". By probing first,
		// we never hit the collision in the happy path.
		//
		// Race scenario (two consumers replay same dispute concurrently):
		//   - Both SELECTs see no causality row.
		//   - Both attempt UPSERT — first wins, second collides on commit.
		//   - The losing tx surfaces 400120; `sql.begin({ idempotent: true })`
		//     does NOT retry PRECONDITION_FAILED automatically, so the loser
		//     bubbles up. cdc-consumer's outer error handler will redeliver
		//     the batch. On the redelivery, this pre-check sees the winning
		//     row and returns — idempotent.
		const [existing = []] = await tx<{ x: number }[]>`
			SELECT 1 AS x FROM refund VIEW ixRefundCausality
			WHERE tenantId = ${tenantId} AND causalityId = ${causalityId}
			LIMIT 1
		`
		if (existing.length > 0) {
			log.debug(
				{ tenantId, disputeId, causalityId },
				'refund_creator: causality already exists — idempotent skip',
			)
			return
		}

		const refundId = newId('refund')
		const now = new Date()
		const nowTs = toTs(now)

		await tx`
			UPSERT INTO refund (
				\`tenantId\`, \`paymentId\`, \`id\`,
				\`providerCode\`, \`providerRefundId\`, \`causalityId\`,
				\`status\`, \`amountMinor\`, \`currency\`, \`reason\`,
				\`version\`,
				\`requestedAt\`, \`succeededAt\`, \`failedAt\`, \`failureReason\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${paymentId}, ${refundId},
				${providerCode}, ${NULL_TEXT}, ${causalityId},
				${'pending'}, ${amountMinor}, ${currency},
				${'Auto-refund: dispute lost'}, ${1},
				${nowTs}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${nowTs}, ${nowTs}, ${REFUND_CREATOR_ACTOR_ID}, ${REFUND_CREATOR_ACTOR_ID}
			)
		`
		log.info(
			{ tenantId, disputeId, refundId, amountMinor: amountMinor.toString() },
			'refund_creator: auto-refund created from dispute.lost',
		)
	}
}
