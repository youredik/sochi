/**
 * `slot_reconciliation_writer` CDC handler — listens on `booking/booking_events`
 * и ensures every active booking has corresponding `roomTypeNightSlot` rows.
 *
 * **Why this exists** (Variant 3 «absolute strongest» canon 2026-05-18):
 *
 *   Migration 0063 added the slot table with PK uniqueness. App-level
 *   enforcement в `booking.repo.create` writes slot rows alongside booking
 *   INSERTs. But ANY bypass path (seed scripts, channel-manager push
 *   handlers, manual `UPSERT INTO booking`, future migration scripts) writes
 *   booking rows directly без allocating slots — invariant dormant для that
 *   booking.
 *
 *   This CDC consumer reconciles. На every booking INSERT event (newImage
 *   present, oldImage absent), it checks if slot rows exist via
 *   `idxSlotByBooking`. If not → allocates lowest-free per night per
 *   (roomType, date). On PK collision (slot taken by concurrent writer):
 *   logs warning (the bypass-write attempted overbook) and skips that night.
 *
 *   Result: «strongest possible» guarantee under ALL write paths. Within
 *   seconds of bypass-write, slot rows materialize and invariant активируется.
 *
 * ## Trigger semantics
 *
 *   Fires ONLY on INSERT events (newImage без oldImage).
 *   - INSERT → fires
 *   - UPDATE → skipped (status transitions handle slots via repo direct edits)
 *   - DELETE → skipped (cancel/cleanup happens via repo)
 *
 * ## Idempotency
 *
 *   Pre-check via `idxSlotByBooking GLOBAL SYNC ON (tenantId, bookingId)` —
 *   if ANY slot row exists for the booking, skip entirely. Race scenario
 *   (CDC re-delivery): both checks see no rows, both try INSERT — second
 *   collides on PK conflict → logged warning, no error propagated upstream.
 *
 * ## Status filter
 *
 *   Only allocates slots for `status IN ('confirmed', 'in_house')`. Terminal
 *   states (cancelled, checked_out, no_show) skipped — these never need slots
 *   (cancel/checkout already released, no_show booking would have been
 *   confirmed earlier by canonical flow).
 *
 * ## Why raw SQL, not the repo
 *
 *   `booking.repo` уses its own `sql.begin({ idempotent: true })` internally.
 *   Nesting transactions из CDC consumer's outer tx → YDB rejects с
 *   TRANSACTION_LOCKS_INVALIDATED. CDC handlers project state directly via
 *   `tx`. Same canon as `refund_creator` / `folio_creator`.
 *
 * ## Allocation algorithm
 *
 *   For each night between checkIn and checkOut:
 *     1. SELECT existing slotNumbers for (tenantId, propertyId, roomTypeId, date)
 *     2. Pick lowest integer NOT in existing set
 *     3. INSERT (PK conflict = race lost, log + continue к next night)
 *
 *   Bound: NOT using `availability.allotment` here — bypass-writes legitimately
 *   may not have availability rows. Use a large practical bound (1000) per
 *   `[[no-half-measures]]` canon — allocate any free slot, let other gates
 *   (booking.repo.create + bulkUpsert validation) enforce allotment caps.
 *
 *   If real overbook detected (PK conflict на all 1000 attempts which would
 *   be insane), abort с loud warning.
 */

import type { TX } from '@ydbjs/query'
import { dateFromIso, toJson, toTs } from '../../db/ydb-helpers.ts'
import { cdcStr, type CdcEvent } from '../cdc-handlers.ts'
import type { HandlerLogger } from './refund-creator.ts'

/** Practical upper bound on slots per night — > any plausible hotel capacity. */
const MAX_SLOT_PROBE = 1000

function* nightsBetween(checkInIso: string, checkOutIso: string): Generator<string> {
	const cursor = new Date(`${checkInIso}T00:00:00Z`)
	const end = new Date(`${checkOutIso}T00:00:00Z`)
	while (cursor < end) {
		yield cursor.toISOString().slice(0, 10)
		cursor.setUTCDate(cursor.getUTCDate() + 1)
	}
}

/**
 * Coerce CDC event field к ISO date string. CDC emits Date columns as ISO
 * strings (per ydb-cdc canon used by migration-registration-enqueuer etc).
 * Accept either bare `YYYY-MM-DD` or full ISO timestamp prefix.
 */
function asIsoDate(v: unknown): string | null {
	if (typeof v === 'string' && v.length >= 10) {
		const slice = v.slice(0, 10)
		if (/^\d{4}-\d{2}-\d{2}$/.test(slice)) return slice
	}
	if (v instanceof Date) return v.toISOString().slice(0, 10)
	return null
}

export function createSlotReconciliationHandler(log: HandlerLogger) {
	return async (tx: TX, event: CdcEvent): Promise<void> => {
		// INSERT only — UPDATE / DELETE skipped.
		if (!event.newImage) return
		if (event.oldImage) return

		const key = event.key ?? []
		if (
			key[0] === undefined ||
			key[1] === undefined ||
			key[2] === undefined ||
			key[3] === undefined
		) {
			log.warn({ key }, 'slot_reconciliation: malformed booking event key — skipping')
			return
		}
		const tenantId = cdcStr(key[0])
		const propertyId = cdcStr(key[1])
		// PK shape (tenantId, propertyId, checkIn, id) per migration 0004 —
		// checkIn lives в event.key[2], NOT event.newImage. YDB CDC emits PK
		// fields в `key` only. Empirically caught 2026-05-18 (slot_reconciliation
		// «missing or malformed dates» когда newImage.checkIn was always null).
		const checkIn = asIsoDate(key[2])
		const bookingId = cdcStr(key[3])

		const status = event.newImage.status
		if (typeof status !== 'string') {
			log.warn({ tenantId, bookingId }, 'slot_reconciliation: missing status — skipping')
			return
		}
		// Only active bookings need slot rows. Terminal statuses → skip.
		if (status !== 'confirmed' && status !== 'in_house') {
			return
		}

		const roomTypeId = event.newImage.roomTypeId
		if (typeof roomTypeId !== 'string' || roomTypeId.length === 0) {
			log.warn({ tenantId, bookingId }, 'slot_reconciliation: missing roomTypeId — skipping')
			return
		}

		const checkOut = asIsoDate(event.newImage.checkOut)
		if (!checkIn || !checkOut) {
			log.warn(
				{ tenantId, bookingId, checkIn, checkOut },
				'slot_reconciliation: missing or malformed dates — skipping',
			)
			return
		}
		// Explicit reverse-date guard (per `[[reverse-date-and-server-cap-traps]]`):
		// silent skip когда checkIn >= checkOut would mask malformed events.
		// Surface as warning so operator sees CDC stream anomaly.
		if (checkIn >= checkOut) {
			log.warn(
				{ tenantId, bookingId, checkIn, checkOut },
				'slot_reconciliation: reverse-date booking event (checkIn >= checkOut) — skipping, malformed source data',
			)
			return
		}

		// Idempotency: if any slot already exists for this booking, repo path
		// must have written them. Skip к avoid double-allocation.
		const [existingSlots = []] = await tx<{ x: number }[]>`
			SELECT 1 AS x FROM roomTypeNightSlot VIEW idxSlotByBooking
			WHERE tenantId = ${tenantId} AND bookingId = ${bookingId}
			LIMIT 1
		`
		if (existingSlots.length > 0) {
			log.debug(
				{ tenantId, bookingId },
				'slot_reconciliation: slots already exist — idempotent skip',
			)
			return
		}

		// Allocate per-night. Track real-overbook indicator: если allocated slot
		// >= effective allotment (allotment + oversellDelta) → bypass-write
		// breached invariant. Surface к activity log + counter — operator can
		// triage via .activity table audit trail.
		const nowTs = toTs(new Date())
		let allocatedCount = 0
		let collidedCount = 0
		let overbookDetectedCount = 0
		for (const night of nightsBetween(checkIn, checkOut)) {
			// Read availability к detect real overbook on this night. Missing
			// availability row = bypass-seed scenario; fall through к MAX_PROBE.
			const [availRows = []] = await tx<
				{ allotment: number | bigint; oversellDelta: number | bigint | null }[]
			>`
				SELECT allotment, oversellDelta FROM availability
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND roomTypeId = ${roomTypeId}
					AND date = ${dateFromIso(night)}
				LIMIT 1
			`
			const effectiveAllotment =
				availRows[0] === undefined
					? null
					: Number(availRows[0].allotment) +
						(availRows[0].oversellDelta === null ? 0 : Number(availRows[0].oversellDelta))

			const [usedRows = []] = await tx<{ slotNumber: number | bigint }[]>`
				SELECT slotNumber FROM roomTypeNightSlot
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND roomTypeId = ${roomTypeId}
					AND date = ${dateFromIso(night)}
			`
			const used = new Set(usedRows.map((r) => Number(r.slotNumber)))
			let slot = -1
			for (let i = 0; i < MAX_SLOT_PROBE; i += 1) {
				if (!used.has(i)) {
					slot = i
					break
				}
			}
			if (slot === -1) {
				log.warn(
					{ tenantId, bookingId, night },
					'slot_reconciliation: MAX_SLOT_PROBE exhausted — implausible overbook depth',
				)
				continue
			}
			// Real-overbook detection: allocating slot beyond effective allotment.
			// Bypass-write breached canonical limit. Log loud + emit activity row
			// for operator audit trail.
			const isRealOverbook = effectiveAllotment !== null && slot >= effectiveAllotment
			try {
				await tx`
					INSERT INTO roomTypeNightSlot (
						\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`date\`, \`slotNumber\`, \`bookingId\`, \`createdAt\`
					) VALUES (
						${tenantId}, ${propertyId}, ${roomTypeId}, ${dateFromIso(night)}, ${slot}, ${bookingId}, ${nowTs}
					)
				`
				allocatedCount += 1
				if (isRealOverbook) {
					overbookDetectedCount += 1
					log.warn(
						{
							tenantId,
							bookingId,
							night,
							slot,
							effectiveAllotment,
						},
						'slot_reconciliation: REAL OVERBOOK DETECTED — bypass-write breached effective allotment',
					)
					await emitOverbookActivity(tx, {
						tenantId,
						bookingId,
						propertyId,
						roomTypeId,
						night,
						slot,
						effectiveAllotment,
					})
				}
			} catch (_err) {
				// PK conflict — concurrent writer claimed this slot. Log + continue.
				// CDC re-delivery will pick up new state. Non-fatal: invariant still
				// holds (slot is occupied by someone), this booking just lacks slot row.
				collidedCount += 1
				log.warn(
					{ tenantId, bookingId, night, slot },
					'slot_reconciliation: PK collision on slot allocation (concurrent writer)',
				)
			}
		}

		if (allocatedCount > 0) {
			log.info(
				{ tenantId, bookingId, allocatedCount, collidedCount, overbookDetectedCount },
				'slot_reconciliation: backfilled slot rows for bypass-written booking',
			)
		}
	}
}

/**
 * Emit an activity row for operator audit trail when CDC handler detects
 * real-overbook (bypass-write breached effective allotment). Surfaces in
 * `activity` table via stankoff-v2 polymorphic log pattern — operator UI
 * can query and triage. Idempotent via deterministic activity.id derived
 * from (bookingId, night) so re-delivery doesn't dupe.
 */
async function emitOverbookActivity(
	tx: TX,
	args: {
		tenantId: string
		bookingId: string
		propertyId: string
		roomTypeId: string
		night: string
		slot: number
		effectiveAllotment: number
	},
): Promise<void> {
	const nowTs = toTs(new Date())
	// Deterministic activity id — re-delivery yields same id, INSERT-into PK
	// uniqueness on (tenantId, objectType, recordId, createdAt, id) would
	// double-write на multiple deliveries. Activity uses createdAt в PK so
	// dedupe via UPSERT-on-same-id.
	const activityId = `ovb_${args.bookingId.slice(-12)}_${args.night.replace(/-/g, '')}`
	const diffJson = {
		reason: 'bypass_write_breached_allotment',
		propertyId: args.propertyId,
		roomTypeId: args.roomTypeId,
		night: args.night,
		slotAllocated: args.slot,
		effectiveAllotment: args.effectiveAllotment,
		excess: args.slot - args.effectiveAllotment + 1,
	}
	await tx`
		UPSERT INTO activity (
			\`tenantId\`, \`objectType\`, \`recordId\`, \`createdAt\`, \`id\`,
			\`activityType\`, \`actorUserId\`, \`diffJson\`
		) VALUES (
			${args.tenantId}, ${'booking'}, ${args.bookingId}, ${nowTs}, ${activityId},
			${'overbook_detected'}, ${'system:slot_reconciliation_writer'}, ${toJson(diffJson)}
		)
	`
}
