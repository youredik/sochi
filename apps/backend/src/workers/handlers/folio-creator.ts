/**
 * `folio_creator_writer` CDC handler — listens on `booking/booking_events`
 * and auto-creates a `guest` folio on every new booking INSERT.
 *
 * Per memory `project_payment_domain_canonical.md` + Apaleo canon:
 *   - Folio created upfront on reservation creation; charges accumulate
 *     via night-audit cron (M7.A.2 follow-up phase).
 *   - Group bookings can have additional folios; this handler ensures
 *     ONE primary `guest` folio exists, allowing manual creation of
 *     `company` / `group_master` / `ota_*` folios on top.
 *
 * ## Trigger semantics
 *
 *   Fires ONLY on INSERT events.
 *   - INSERT (newImage present, oldImage absent) → fires
 *   - UPDATE (both images present) → skipped (folio independent of booking edits)
 *   - DELETE → skipped (folio cleanup is out of scope; manual ops via service)
 *
 * ## Idempotency
 *
 *   Pre-check via `ixFolioBooking GLOBAL SYNC ON (tenantId, bookingId)` —
 *   if ANY folio exists for the booking, skip. Race scenario (two consumers
 *   replay same booking insert): both SELECTs see no row, both UPSERT —
 *   second collides on PK conflict → cdc-consumer outer error redelivers,
 *   on redelivery this pre-check sees the winning row and returns.
 *
 *   PK collision is impossible for same `id` only if id is deterministic.
 *   We generate fresh `newId('folio')` per call → if both consumers race,
 *   they could create TWO folios. The `ixFolioBooking` pre-check is the
 *   real dedup. SELECT-then-UPSERT in serializable tx makes the read
 *   guard against concurrent inserts.
 *
 * ## Why raw SQL not the folio repo
 *
 *   `folio.repo.createForBooking` uses its own `sql.begin({ idempotent: true })`
 *   internally. Calling it from inside the CDC consumer's outer tx would nest
 *   transactions — YDB rejects with TRANSACTION_LOCKS_INVALIDATED. CDC
 *   handlers project state directly via `tx`. Same canon as `refund_creator`.
 */

import { newId } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import { NULL_TEXT, NULL_TIMESTAMP, toTs } from '../../db/ydb-helpers.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import type { HandlerLogger } from './refund-creator.ts'

const FOLIO_CREATOR_ACTOR_ID = 'system:folio_creator_writer'
const DEFAULT_FOLIO_KIND = 'guest'
const DEFAULT_FOLIO_STATUS = 'open'

/**
 * Build a CDC projection that auto-creates `guest` folios on booking inserts.
 *
 * No external dependencies — handler issues raw SQL through the consumer's
 * `tx`. Idempotent by design (pre-check on `ixFolioBooking`).
 */
export function createFolioCreatorHandler(log: HandlerLogger) {
	return async (tx: TX, event: CdcEvent): Promise<void> => {
		// Skip non-INSERT events. INSERT has newImage but no oldImage.
		if (!event.newImage) return
		if (event.oldImage) return // UPDATE — booking edits don't trigger folio create

		// Booking PK is 4D: (tenantId, propertyId, checkIn, id) — see migration 0004.
		const key = event.key ?? []
		if (
			key[0] === undefined ||
			key[1] === undefined ||
			key[2] === undefined ||
			key[3] === undefined
		) {
			log.warn({ key }, 'folio_creator: malformed booking event key — skipping')
			return
		}
		const tenantId = String(key[0])
		const propertyId = String(key[1])
		// key[2] = checkIn (date), not used directly for folio
		const bookingId = String(key[3])

		// Pull currency from newImage (booking-level Utf8 NOT NULL column).
		const currency = event.newImage.currency
		if (typeof currency !== 'string' || currency.length === 0) {
			log.warn(
				{ tenantId, bookingId, currency },
				'folio_creator: booking event missing currency — skipping',
			)
			return
		}

		// Idempotency pre-check via ixFolioBooking. Returns LIMIT 1 to short-circuit.
		// If any folio (even of different kind) exists for this booking, this
		// handler considers its job done — manual ops can create additional folios.
		const [existing = []] = await tx<{ x: number }[]>`
			SELECT 1 AS x FROM folio VIEW ixFolioBooking
			WHERE tenantId = ${tenantId} AND bookingId = ${bookingId}
			LIMIT 1
		`
		if (existing.length > 0) {
			log.debug(
				{ tenantId, bookingId },
				'folio_creator: folio already exists for booking — idempotent skip',
			)
			return
		}

		const folioId = newId('folio')
		const now = new Date()
		const nowTs = toTs(now)

		await tx`
			UPSERT INTO folio (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`kind\`, \`status\`, \`currency\`, \`balanceMinor\`, \`version\`,
				\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${propertyId}, ${bookingId}, ${folioId},
				${DEFAULT_FOLIO_KIND}, ${DEFAULT_FOLIO_STATUS}, ${currency}, ${0n}, ${1},
				${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT}, ${NULL_TEXT},
				${nowTs}, ${nowTs}, ${FOLIO_CREATOR_ACTOR_ID}, ${FOLIO_CREATOR_ACTOR_ID}
			)
		`
		log.info(
			{ tenantId, bookingId, folioId, currency },
			'folio_creator: auto-created guest folio for booking',
		)
	}
}
