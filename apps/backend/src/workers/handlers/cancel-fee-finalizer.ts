/**
 * `cancel_fee_writer` CDC handler — fires on booking status transitions INTO
 * `cancelled` or `no_show` and posts the corresponding fee snapshot
 * (booking.cancellationFee or booking.noShowFee) onto the guest folio.
 *
 * Fee snapshot canon (M5 booking domain):
 *   - `cancellationFee` / `noShowFee` are Json columns on `booking`, snapshotted
 *     at booking creation per rate plan policy. Editing rate plan later does
 *     NOT change the snapshot — guest sees the policy active at booking time
 *     (Apaleo / 54-ФЗ snapshot principle).
 *   - Both are nullable: BAR-flex / fully-refundable plans have NO snapshot
 *     (null) → handler skips post.
 *   - `amountMicros` field is the headline; in V1 we ignore `dueDate` /
 *     `policyCode` / `policyVersion` as audit metadata (carried in
 *     description for human review).
 *
 * Trigger semantics:
 *   - oldStatus !== 'cancelled' && newStatus === 'cancelled' → post
 *     cancellationFee
 *   - oldStatus !== 'no_show' && newStatus === 'no_show'   → post noShowFee
 *
 * Skipped:
 *   - INSERT (no oldImage), DELETE (no newImage)
 *   - already in terminal state (no transition INTO it)
 *   - fee snapshot is null (no policy) or amountMicros = 0 (free cancel)
 *   - fee already posted (deterministic line id collision = idempotent)
 *
 * Why not merge with checkout-finalizer:
 *   - Different transitions (cancelled / no_show vs checked_out)
 *   - Different fee categories (cancellationFee / noShowFee vs tourismTax)
 *   - Different sources (booking-snapshot static vs computed-from-property-rate)
 *   - Mixing them would force complex `if status === X / Y / Z` branching;
 *     two focused handlers each doing one job is cheaper to reason about.
 */

import type { TX } from '@ydbjs/query'
import { NULL_TEXT, NULL_TIMESTAMP, toTs } from '../../db/ydb-helpers.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { cancelFeeLineId, feeMicrosToMinor, noShowFeeLineId } from '../lib/cancel-fees.ts'
import type { HandlerLogger } from './refund-creator.ts'

const CANCEL_FEE_ACTOR_ID = 'system:cancel_fee_writer'

type FeeKind = 'cancellation' | 'no_show'

interface FeeSnapshot {
	amountMicros: string | number | bigint
	currency?: string
	dueDate?: string | null
	policyCode?: string
	policyVersion?: string
}

export function createCancelFeeFinalizerHandler(log: HandlerLogger) {
	return async (tx: TX, event: CdcEvent): Promise<void> => {
		// 1. Trigger gate.
		if (!event.newImage || !event.oldImage) return // INSERT or DELETE
		const newStatus = event.newImage.status
		const oldStatus = event.oldImage.status

		let kind: FeeKind | null = null
		if (newStatus === 'cancelled' && oldStatus !== 'cancelled') kind = 'cancellation'
		else if (newStatus === 'no_show' && oldStatus !== 'no_show') kind = 'no_show'
		else return

		// 2. Booking PK shape (tenantId, propertyId, checkIn, id).
		const key = event.key ?? []
		if (key[0] === undefined || key[1] === undefined || key[3] === undefined) {
			log.warn({ key }, 'cancel_fee: malformed booking event key — skipping')
			return
		}
		const tenantId = String(key[0])
		const propertyId = String(key[1])
		const bookingId = String(key[3])

		// 3. Resolve fee snapshot from newImage. Json column → CDC delivers as
		// parsed object, not string.
		const feeRaw = (
			kind === 'cancellation' ? event.newImage.cancellationFee : event.newImage.noShowFee
		) as FeeSnapshot | null | undefined
		if (feeRaw === null || feeRaw === undefined) {
			log.debug(
				{ tenantId, bookingId, kind },
				'cancel_fee: no fee snapshot (BAR-flex policy) — skipping',
			)
			return
		}

		const amountMicros = BigInt(String(feeRaw.amountMicros))
		const amountMinor = feeMicrosToMinor(amountMicros)
		if (amountMinor === 0n) {
			log.debug(
				{ tenantId, bookingId, kind, amountMicros },
				'cancel_fee: fee amount = 0 — skipping',
			)
			return
		}

		const currency = typeof event.newImage.currency === 'string' ? event.newImage.currency : null
		if (!currency) {
			log.warn({ tenantId, bookingId, kind }, 'cancel_fee: booking missing currency — skipping')
			return
		}

		// 4. Resolve guest folio.
		const [folioRows = []] = await tx<
			{
				id: string
				status: string
				balanceMinor: number | bigint
				version: number | bigint
				kind: string
				currency: string
				closedAt: Date | null
				settledAt: Date | null
				closedBy: string | null
				companyId: string | null
				createdAt: Date
				createdBy: string
			}[]
		>`
			SELECT id, status, balanceMinor, version, kind, currency,
			       closedAt, settledAt, closedBy, companyId, createdAt, createdBy
			FROM folio VIEW ixFolioBooking
			WHERE tenantId = ${tenantId} AND bookingId = ${bookingId}
			  AND kind = 'guest'
			LIMIT 1
		`
		const folio = folioRows[0]
		if (!folio) {
			log.warn({ tenantId, bookingId, kind }, 'cancel_fee: no guest folio — skipping')
			return
		}
		if (folio.status !== 'open') {
			log.warn(
				{ tenantId, bookingId, kind, status: folio.status },
				'cancel_fee: folio not open — skipping',
			)
			return
		}
		if (folio.currency !== currency) {
			log.warn(
				{ tenantId, bookingId, kind, folioCurrency: folio.currency, bookingCurrency: currency },
				'cancel_fee: currency mismatch — skipping',
			)
			return
		}

		// 5. Idempotency pre-check.
		const lineId = kind === 'cancellation' ? cancelFeeLineId(bookingId) : noShowFeeLineId(bookingId)
		const [existing = []] = await tx<{ x: number }[]>`
			SELECT 1 AS x FROM folioLine
			WHERE tenantId = ${tenantId} AND folioId = ${folio.id} AND id = ${lineId}
			LIMIT 1
		`
		if (existing.length > 0) {
			log.debug(
				{ tenantId, bookingId, kind, folioId: folio.id, lineId },
				'cancel_fee: line already exists — idempotent skip',
			)
			return
		}

		// 6. Post line + bump folio balance.
		const now = new Date()
		const nowTs = toTs(now)
		const category = kind === 'cancellation' ? 'cancellationFee' : 'noShowFee'
		const policyCode = typeof feeRaw.policyCode === 'string' ? feeRaw.policyCode : 'unknown'
		const description =
			kind === 'cancellation'
				? `Штраф за отмену (${policyCode})`
				: `Штраф за неявку (${policyCode})`

		await tx`
			UPSERT INTO folioLine (
				\`tenantId\`, \`folioId\`, \`id\`,
				\`category\`, \`description\`, \`amountMinor\`,
				\`isAccommodationBase\`, \`taxRateBps\`,
				\`lineStatus\`, \`routingRuleId\`,
				\`postedAt\`, \`voidedAt\`, \`voidReason\`,
				\`version\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${folio.id}, ${lineId},
				${category}, ${description}, ${amountMinor},
				${false}, ${0},
				${'posted'}, ${NULL_TEXT},
				${nowTs}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${1},
				${nowTs}, ${nowTs}, ${CANCEL_FEE_ACTOR_ID}, ${CANCEL_FEE_ACTOR_ID}
			)
		`

		const newBalance = BigInt(folio.balanceMinor) + amountMinor
		const newVersion = Number(folio.version) + 1

		await tx`
			UPSERT INTO folio (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`kind\`, \`status\`, \`currency\`,
				\`balanceMinor\`, \`version\`,
				\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${propertyId}, ${bookingId}, ${folio.id},
				${folio.kind}, ${folio.status}, ${folio.currency},
				${newBalance}, ${newVersion},
				${folio.closedAt ? toTs(folio.closedAt) : NULL_TIMESTAMP},
				${folio.settledAt ? toTs(folio.settledAt) : NULL_TIMESTAMP},
				${folio.closedBy ?? NULL_TEXT}, ${folio.companyId ?? NULL_TEXT},
				${toTs(folio.createdAt)}, ${nowTs}, ${folio.createdBy}, ${CANCEL_FEE_ACTOR_ID}
			)
		`
		log.info(
			{
				tenantId,
				bookingId,
				kind,
				folioId: folio.id,
				lineId,
				amountMinor: amountMinor.toString(),
				policyCode,
			},
			'cancel_fee: posted fee on transition',
		)
	}
}
