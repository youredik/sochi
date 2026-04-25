/**
 * `folio_balance_writer` CDC handler — recomputes `folio.balanceMinor`
 * from authoritative projections (folioLines + payments + refunds) per
 * canon invariant #12 (folio-balance-conservation):
 *
 *   balance = charges - paymentsApplied + refundsApplied
 *
 * Multi-source: registered on three topics simultaneously (per migration
 * 0015 ALTER TOPIC ADD CONSUMER):
 *   - `payment/payment_events`  → use `payment.folioId` from newImage
 *   - `refund/refund_events`    → load parent payment, use payment.folioId
 *   - `folio/folio_events`      → skip (recompute would write folio →
 *                                  fire folio_events again → loop)
 *
 * Pure-lib delegation: `computeChargesMinor` + `computeBalanceMinor` from
 * `folio-balance.ts` are the math. Handler is the I/O wrapper.
 *
 * Idempotency: pre-check `computed === current.balanceMinor` short-circuits
 * before any UPSERT. CDC-replays of the same offset re-run the SQL queries
 * but UPSERT only fires if the projection produced a different value.
 *
 * Why raw SQL, not folio.repo.recomputeBalance:
 *   The repo wraps in its own `sql.begin` — nesting inside cdc-consumer's
 *   outer tx surfaces TRANSACTION_LOCKS_INVALIDATED. Handler runs the
 *   recompute inline using the consumer's tx.
 */

import type { FolioLine } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import { NULL_TEXT, timestampOpt, toTs } from '../../db/ydb-helpers.ts'
import { computeBalanceMinor, computeChargesMinor } from '../../domains/folio/lib/folio-balance.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import type { HandlerLogger } from './refund-creator.ts'

const FOLIO_BALANCE_WRITER_ACTOR_ID = 'system:folio_balance_writer'

/** Source topic the handler is wired to — controls how folioId is resolved. */
export type FolioBalanceSource = 'payment' | 'refund' | 'folio'

type FolioRow = {
	tenantId: string
	propertyId: string
	bookingId: string
	id: string
	kind: string
	status: string
	currency: string
	balanceMinor: number | bigint
	version: number | bigint
	closedAt: Date | null
	settledAt: Date | null
	closedBy: string | null
	companyId: string | null
	createdAt: Date
	updatedAt: Date
	createdBy: string
	updatedBy: string
}

type FolioLineRow = {
	tenantId: string
	folioId: string
	id: string
	category: string
	description: string
	amountMinor: number | bigint
	isAccommodationBase: boolean
	taxRateBps: number | bigint
	lineStatus: string
	routingRuleId: string | null
	postedAt: Date | null
	voidedAt: Date | null
	voidReason: string | null
	version: number | bigint
	createdAt: Date
	updatedAt: Date
	createdBy: string
	updatedBy: string
}

/**
 * Build a folio-balance projection. The `source` parameter determines how
 * the folioId is extracted from each event — register one handler per
 * topic via factory (cdc-consumer wiring).
 */
export function createFolioBalanceHandler(log: HandlerLogger, source: FolioBalanceSource) {
	return async (tx: TX, event: CdcEvent): Promise<void> => {
		// folio_events: skip outright (recompute writes folio → emits folio_event → loop).
		if (source === 'folio') return

		// DELETE events: oldImage only, no newImage. Skip — payments/refunds aren't deleted
		// in our domain, and any future hard-delete would still want recompute on the
		// REMAINING rows, not on a vanishing one.
		if (!event.newImage) return

		const key = event.key ?? []
		if (key[0] === undefined) return
		const tenantId = String(key[0])

		// Resolve folioId per source.
		let folioId: string | null = null
		if (source === 'payment') {
			// payment PK 4D: (tenantId, propertyId, bookingId, paymentId).
			// payment.folioId is a non-PK column → present in newImage.
			const folioField = event.newImage.folioId
			if (folioField === null || folioField === undefined || folioField === '') {
				log.debug({ tenantId }, 'folio_balance: payment event has no folioId — skipping')
				return
			}
			folioId = String(folioField)
		} else if (source === 'refund') {
			// refund PK 3D: (tenantId, paymentId, id) → key[1] is paymentId.
			if (key[1] === undefined) return
			const paymentId = String(key[1])
			const [paymentRows = []] = await tx<{ folioId: string | null }[]>`
				SELECT folioId FROM payment
				WHERE tenantId = ${tenantId} AND id = ${paymentId} LIMIT 1
			`
			const folioField = paymentRows[0]?.folioId
			if (!folioField) {
				log.debug(
					{ tenantId, paymentId },
					'folio_balance: refund event parent payment has no folioId — skipping',
				)
				return
			}
			folioId = folioField
		}
		if (!folioId) return

		// Load folio + lines + payment/refund sums for this folio in the same tx.
		const [folioRows = []] = await tx<FolioRow[]>`
			SELECT * FROM folio WHERE tenantId = ${tenantId} AND id = ${folioId} LIMIT 1
		`
		const folio = folioRows[0]
		if (!folio) {
			log.warn({ tenantId, folioId }, 'folio_balance: folio not found — skipping')
			return
		}

		const [lineRows = []] = await tx<FolioLineRow[]>`
			SELECT amountMinor, lineStatus FROM folioLine
			WHERE tenantId = ${tenantId} AND folioId = ${folioId}
		`
		const lines: Array<Pick<FolioLine, 'amountMinor' | 'lineStatus'>> = lineRows.map((r) => ({
			amountMinor: BigInt(r.amountMinor).toString(),
			lineStatus: r.lineStatus as FolioLine['lineStatus'],
		}))

		// SUM payments applied to this folio. Status set per canon (#12):
		// captures count once payment reaches succeeded; further refunds DO NOT
		// reduce capturedMinor — they're tracked in refunds_applied (line below).
		const [paymentSumRows = []] = await tx<{ sumMinor: number | bigint }[]>`
			SELECT COALESCE(SUM(capturedMinor), 0) AS sumMinor FROM payment
			WHERE tenantId = ${tenantId} AND folioId = ${folioId}
			  AND status IN ('succeeded', 'partially_refunded', 'refunded')
		`
		const paymentsApplied = BigInt(paymentSumRows[0]?.sumMinor ?? 0)

		// SUM refunds (succeeded only) — load payment ids on this folio first
		// because refund.folioId doesn't exist (refund is keyed by paymentId).
		// Two-step join because YDB's correlated subquery support varies by
		// version; explicit IN-list is portable.
		const [paymentIdRows = []] = await tx<{ id: string }[]>`
			SELECT id FROM payment
			WHERE tenantId = ${tenantId} AND folioId = ${folioId}
		`
		let refundsApplied = 0n
		if (paymentIdRows.length > 0) {
			const paymentIds = paymentIdRows.map((r) => r.id)
			const [refundSumRows = []] = await tx<{ sumMinor: number | bigint }[]>`
				SELECT COALESCE(SUM(amountMinor), 0) AS sumMinor FROM refund
				WHERE tenantId = ${tenantId}
				  AND paymentId IN ${paymentIds}
				  AND status = 'succeeded'
			`
			refundsApplied = BigInt(refundSumRows[0]?.sumMinor ?? 0)
		}

		const charges = computeChargesMinor(lines)
		const computed = computeBalanceMinor({
			chargesMinor: charges,
			paymentsAppliedMinor: paymentsApplied,
			refundsAppliedMinor: refundsApplied,
		})

		const currentBalance = BigInt(folio.balanceMinor)
		if (computed === currentBalance) {
			log.debug(
				{ tenantId, folioId, balanceMinor: computed.toString() },
				'folio_balance: computed === current — idempotent skip',
			)
			return
		}

		const now = new Date()
		const nowTs = toTs(now)
		const newVersion = Number(folio.version) + 1

		await tx`
			UPSERT INTO folio (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
				\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${folio.tenantId}, ${folio.propertyId}, ${folio.bookingId}, ${folio.id},
				${folio.kind}, ${folio.status}, ${folio.currency}, ${computed}, ${newVersion},
				${timestampOpt(folio.closedAt)},
				${timestampOpt(folio.settledAt)},
				${folio.closedBy ?? NULL_TEXT},
				${folio.companyId ?? NULL_TEXT},
				${toTs(folio.createdAt)}, ${nowTs},
				${folio.createdBy}, ${FOLIO_BALANCE_WRITER_ACTOR_ID}
			)
		`

		log.info(
			{
				tenantId,
				folioId,
				source,
				prevBalance: currentBalance.toString(),
				newBalance: computed.toString(),
				charges: charges.toString(),
				paymentsApplied: paymentsApplied.toString(),
				refundsApplied: refundsApplied.toString(),
			},
			'folio_balance: recomputed',
		)
	}
}
