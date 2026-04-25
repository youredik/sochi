/**
 * `tourism_tax_writer` CDC handler — fires on booking status transition into
 * `checked_out` and posts the tourism-tax line on the booking's primary guest
 * folio.
 *
 * Per memory `project_m7a3_tourism_tax_research.md` (синтез 2026-04-26):
 *   - Apaleo Russia / TravelLine canon: post AT CHECK-OUT (terminal event), one
 *     line per booking. Per-night posting вызывает сторно-стормы при mid-stay
 *     edits (продление / cancel ночей), потому что НК РФ ст. 418 предполагает
 *     налог на дату полного расчёта с гостем.
 *   - Idempotency: deterministic folioLine.id `tax_<bookingId>` — PK collision
 *     = no-op. Cron retry / restart catch-up / manual replay safe.
 *   - 54-ФЗ separation: turNalog в кассовом чеке НЕ выделяется, но в счёте-
 *     фолио ДА — отдельной строкой `category=tourismTax`.
 *
 * ## Trigger semantics
 *
 *   Fires ONLY on booking UPDATE where status crosses INTO `checked_out`:
 *     - oldImage.status !== 'checked_out' && newImage.status === 'checked_out'
 *
 *   Skipped:
 *     - INSERT events (no oldImage) — booking can't be created already-checked-out
 *     - status === 'checked_out' before transition (already finalized — would
 *       silently replay if `lineId` already exists; pre-check handles that)
 *     - DELETE events
 *
 * ## Pure-lib delegation
 *
 *   Math is in `workers/lib/tourism-tax.ts` (`computeTourismTax`,
 *   `tourismTaxLineId`). Handler is the I/O wrapper: read booking/property,
 *   compute, write line + bump folio balance. Mirrors `folio_balance_writer`
 *   handler / pure-lib split.
 */

import type { TX } from '@ydbjs/query'
import { NULL_TEXT, NULL_TIMESTAMP, toTs } from '../../db/ydb-helpers.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { computeTourismTax, tourismTaxLineId } from '../lib/tourism-tax.ts'
import type { HandlerLogger } from './refund-creator.ts'

const TOURISM_TAX_ACTOR_ID = 'system:tourism_tax_writer'

export function createCheckoutFinalizerHandler(log: HandlerLogger) {
	return async (tx: TX, event: CdcEvent): Promise<void> => {
		// 1. Trigger gate — only on UPDATE crossing INTO 'checked_out'.
		if (!event.newImage) return // INSERT (no oldImage) or DELETE-only event
		if (!event.oldImage) return // INSERT — bookings created in confirmed state
		const newStatus = event.newImage.status
		const oldStatus = event.oldImage.status
		if (newStatus !== 'checked_out') return
		if (oldStatus === 'checked_out') return // already finalized

		// Booking PK shape: (tenantId, propertyId, checkIn, id) — see migration 0004.
		const key = event.key ?? []
		if (key[0] === undefined || key[1] === undefined || key[3] === undefined) {
			log.warn({ key }, 'tourism_tax: malformed booking event key — skipping')
			return
		}
		const tenantId = String(key[0])
		const propertyId = String(key[1])
		const bookingId = String(key[3])

		// 2. Pull required fields from newImage. With MODE=NEW_AND_OLD_IMAGES the
		// CDC event carries the full row image. totalMicros is the gross
		// accommodation base (excluding turNalog itself, which is computed here),
		// stored as Int64 string in JSON.
		const totalMicrosRaw = event.newImage.totalMicros
		const nightsCount = event.newImage.nightsCount
		const currency = event.newImage.currency
		if (
			totalMicrosRaw === undefined ||
			totalMicrosRaw === null ||
			typeof nightsCount !== 'number' ||
			typeof currency !== 'string'
		) {
			log.warn(
				{ tenantId, bookingId, totalMicrosRaw, nightsCount, currency },
				'tourism_tax: booking event missing required fields — skipping',
			)
			return
		}

		const totalMicros = BigInt(String(totalMicrosRaw))
		// Convert micros (×10^6 of base currency) to minor (kopecks for RUB).
		// 1 RUB = 1_000_000 micros = 100 kopecks → divide by 10_000.
		const baseMinor = totalMicros / 10_000n

		// 3. Read property tourismTaxRateBps. NULL → property hasn't been
		// configured yet (legacy data) → tax rate 0 → skip post.
		const [propertyRows = []] = await tx<{ tourismTaxRateBps: number | bigint | null }[]>`
			SELECT tourismTaxRateBps FROM property
			WHERE tenantId = ${tenantId} AND id = ${propertyId}
			LIMIT 1
		`
		const property = propertyRows[0]
		if (!property) {
			log.warn({ tenantId, propertyId, bookingId }, 'tourism_tax: property not found — skipping')
			return
		}
		const rateBp = property.tourismTaxRateBps === null ? 0 : Number(property.tourismTaxRateBps)
		if (rateBp === 0) {
			log.debug(
				{ tenantId, propertyId, bookingId },
				'tourism_tax: rate=0 (property not in adopted region) — skipping',
			)
			return
		}

		// 4. Compute tax. V1 — exemptNights=0 (М8 МВД flow lands льготы),
		// rooms=1 (single-room bookings are V1 inventory shape).
		const taxMinor = computeTourismTax(baseMinor, rateBp, nightsCount, 1, 0)
		if (taxMinor === 0n) {
			log.debug(
				{ tenantId, bookingId, baseMinor, rateBp, nightsCount },
				'tourism_tax: computed 0 (zero-base or zero-night) — skipping',
			)
			return
		}

		// 5. Resolve guest folio. ixFolioBooking on (tenantId, bookingId).
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
			log.warn(
				{ tenantId, bookingId },
				'tourism_tax: no guest folio for checked-out booking — skipping',
			)
			return
		}
		// Allow posting on `closed` folios? NO — once closed, no postings allowed.
		// If guest checks out before audit posts, line should already exist;
		// missing on close = configuration drift, log and skip.
		if (folio.status !== 'open') {
			log.warn(
				{ tenantId, bookingId, folioId: folio.id, status: folio.status },
				'tourism_tax: folio not open — skipping (close-before-finalize race)',
			)
			return
		}
		if (folio.currency !== currency) {
			log.warn(
				{ tenantId, bookingId, folioCurrency: folio.currency, bookingCurrency: currency },
				'tourism_tax: currency mismatch — skipping',
			)
			return
		}

		// 6. Idempotency pre-check — deterministic line ID may already exist
		// (replay scenario, status flapped, manual rerun).
		const lineId = tourismTaxLineId(bookingId)
		const [existing = []] = await tx<{ x: number }[]>`
			SELECT 1 AS x FROM folioLine
			WHERE tenantId = ${tenantId} AND folioId = ${folio.id} AND id = ${lineId}
			LIMIT 1
		`
		if (existing.length > 0) {
			log.debug(
				{ tenantId, bookingId, folioId: folio.id, lineId },
				'tourism_tax: line already exists — idempotent skip',
			)
			return
		}

		// 7. Post folioLine + bump folio.balanceMinor in same tx (CDC outer tx
		// is the boundary). Description includes amount in копейках for human
		// readability when reconciling with ФНС report.
		const now = new Date()
		const nowTs = toTs(now)
		const description = `Туристический налог (${(rateBp / 100).toFixed(2)}%, ${nightsCount} ноч.)`

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
				${'tourismTax'}, ${description}, ${taxMinor},
				${false}, ${rateBp},
				${'posted'}, ${NULL_TEXT},
				${nowTs}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${1},
				${nowTs}, ${nowTs}, ${TOURISM_TAX_ACTOR_ID}, ${TOURISM_TAX_ACTOR_ID}
			)
		`

		const newBalance = BigInt(folio.balanceMinor) + taxMinor
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
				${toTs(folio.createdAt)}, ${nowTs}, ${folio.createdBy}, ${TOURISM_TAX_ACTOR_ID}
			)
		`
		log.info(
			{
				tenantId,
				bookingId,
				folioId: folio.id,
				lineId,
				taxMinor: taxMinor.toString(),
				rateBp,
				nightsCount,
			},
			'tourism_tax: posted line on checkout',
		)
	}
}
