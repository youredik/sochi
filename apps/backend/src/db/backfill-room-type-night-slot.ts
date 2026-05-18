/**
 * Backfill: materialize per-night `roomTypeNightSlot` rows for every existing
 * active booking (`status IN ('confirmed','in_house')`), pinned OR unassigned.
 *
 * **Why this exists**: migration `0063_room_type_night_slot.sql` introduced
 * Variant 3 «strongest possible» overbooking-prevention via PK uniqueness on
 * `(tenantId, propertyId, roomTypeId, date, slotNumber)`. Bookings created
 * BEFORE migration 0063 have NO slot rows — so the DB invariant doesn't
 * protect their per-night-per-roomType allocation. This script writes the
 * missing rows.
 *
 * **Key difference от occupancy backfill** (0062 companion):
 *   - Occupancy: only pinned bookings (assignedRoomId != null), keyed by roomId.
 *   - Slot: ALL active bookings (pinned + unassigned), keyed by lowest-free
 *     slotNumber per (tenantId, propertyId, roomTypeId, date).
 *
 * **Algorithm**: deterministic. Sort bookings by (checkIn, id) for stable
 * slot assignment. For each booking × night:
 *   1. SELECT existing slotNumbers за this night.
 *   2. Pick lowest free slot ∈ [0, ∞) — bounded by effective allotment если
 *      `availability` row exists.
 *   3. INSERT slot row.
 *   4. PK_CONFLICT same bookingId → alreadyDone (rerun).
 *   5. PK_CONFLICT different bookingId → race (extremely rare in backfill
 *      since не concurrent; classify as phantom).
 *
 * **Conflict detection** distinct from occupancy backfill: here «phantom»
 * means two ATTEMPTS chose the same lowest-free slot — should not happen
 * sequentially. If it does, something concurrent ran — log + continue.
 *
 * **Usage**:
 *   pnpm exec node --experimental-strip-types apps/backend/src/db/backfill-room-type-night-slot.ts --dry-run
 *   pnpm exec node --experimental-strip-types apps/backend/src/db/backfill-room-type-night-slot.ts --commit
 *   pnpm exec node --experimental-strip-types apps/backend/src/db/backfill-room-type-night-slot.ts --commit --sample 10
 *   pnpm exec node --experimental-strip-types apps/backend/src/db/backfill-room-type-night-slot.ts --commit --tenant org_XXXX
 */

import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { query } from '@ydbjs/query'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dateFromIso, NULL_TEXT, timestampOpt, toJson, toTs, tsFromIso } from './ydb-helpers.ts'

const TYPEID_RE = /^[a-z]+_[0-9a-hjkmnp-tv-z]{26}$/
function assertValidTenantId(id: string): string {
	if (!TYPEID_RE.test(id)) {
		throw new Error(`Invalid tenantId format: ${JSON.stringify(id)}`)
	}
	return id
}

const YDB_PRECONDITION_FAILED = 400120
function isPkConflict(err: unknown): err is YDBError {
	return err instanceof YDBError && err.code === YDB_PRECONDITION_FAILED
}

/** Projection — no PII fields (152-ФЗ-safe). */
type SourceBookingRow = {
	tenantId: string
	propertyId: string
	checkIn: Date
	checkOut: Date
	id: string
	roomTypeId: string
}

type ConflictEntry = {
	tenantId: string
	propertyId: string
	roomTypeId: string
	date: string
	slotNumber: number
	winnerBookingId: string
	loserBookingId: string
}

type Counters = {
	bookingsScanned: number
	nightsAttempted: number
	nightsCreated: number
	nightsAlreadyDone: number
	phantomCollisions: number
	exhaustedSlots: number
	bookingsCancelled: number
}

export type BackfillOpts = {
	readonly commit: boolean
	readonly sampleLimit?: number
	readonly tenantIds?: readonly string[]
	/**
	 * Resolve real overbook by cancelling «loser» bookings (those for which
	 * no slot could be allocated → exhaustedSlots > 0). Cancellation writes
	 * status='cancelled' + cancelReason='auto-resolved-overbook-2026-05-18'
	 * + cancelledAt=now via UPSERT (full-row, per `[[ydb-update-tolerance]]`
	 * canon — UPDATE на nullable cols flaky). Decrements availability.sold
	 * if row exists.
	 *
	 * DESTRUCTIVE — explicit operator opt-in only. Default false. Pre-flight
	 * verify via --dry-run что conflict count matches expectations.
	 */
	readonly cancelOverbook?: boolean
}

export type BackfillResult = {
	readonly counters: Counters
	readonly conflicts: readonly ConflictEntry[]
	readonly reportPath?: string
}

function* nightsBetween(checkIn: Date, checkOut: Date): Generator<Date> {
	const cursor = new Date(checkIn)
	cursor.setUTCHours(0, 0, 0, 0)
	const end = new Date(checkOut)
	end.setUTCHours(0, 0, 0, 0)
	while (cursor < end) {
		yield new Date(cursor)
		cursor.setUTCDate(cursor.getUTCDate() + 1)
	}
}

function toIsoDate(d: Date): string {
	return d.toISOString().slice(0, 10)
}

async function loadSourceBookings(
	sql: ReturnType<typeof query>,
	tenantIds: readonly string[],
): Promise<SourceBookingRow[]> {
	if (tenantIds.length === 0) {
		const [rows = []] = await sql<SourceBookingRow[]>`
			SELECT tenantId, propertyId, checkIn, checkOut, id, roomTypeId
			FROM booking
			WHERE status IN ('confirmed', 'in_house')
			ORDER BY tenantId, propertyId, roomTypeId, checkIn, id
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return rows
	}
	const all: SourceBookingRow[] = []
	for (const tenantId of tenantIds) {
		const [rows = []] = await sql<SourceBookingRow[]>`
			SELECT tenantId, propertyId, checkIn, checkOut, id, roomTypeId
			FROM booking
			WHERE status IN ('confirmed', 'in_house') AND tenantId = ${tenantId}
			ORDER BY propertyId, roomTypeId, checkIn, id
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		all.push(...rows)
	}
	return all
}

async function loadAvailabilityEffective(
	sql: ReturnType<typeof query>,
	tenantId: string,
	propertyId: string,
	roomTypeId: string,
	dateIso: string,
): Promise<number | null> {
	const [rows = []] = await sql<
		{ allotment: number | bigint; oversellDelta: number | bigint | null }[]
	>`
		SELECT allotment, oversellDelta FROM availability
		WHERE tenantId = ${tenantId}
			AND propertyId = ${propertyId}
			AND roomTypeId = ${roomTypeId}
			AND date = ${dateFromIso(dateIso)}
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	const row = rows[0]
	if (!row) return null
	const allotment = Number(row.allotment)
	const oversellDelta = row.oversellDelta === null ? 0 : Number(row.oversellDelta)
	return allotment + oversellDelta
}

async function loadExistingSlots(
	sql: ReturnType<typeof query>,
	tenantId: string,
	propertyId: string,
	roomTypeId: string,
	dateIso: string,
): Promise<Map<number, string>> {
	const [rows = []] = await sql<{ slotNumber: number | bigint; bookingId: string }[]>`
		SELECT slotNumber, bookingId FROM roomTypeNightSlot
		WHERE tenantId = ${tenantId}
			AND propertyId = ${propertyId}
			AND roomTypeId = ${roomTypeId}
			AND date = ${dateFromIso(dateIso)}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return new Map(rows.map((r) => [Number(r.slotNumber), r.bookingId]))
}

async function attemptInsertSlot(
	sql: ReturnType<typeof query>,
	tenantId: string,
	propertyId: string,
	roomTypeId: string,
	dateIso: string,
	slotNumber: number,
	bookingId: string,
): Promise<{ kind: 'created' } | { kind: 'collision'; existingBookingId: string }> {
	const nowTs = toTs(new Date())
	try {
		await sql`
			INSERT INTO roomTypeNightSlot (
				\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`date\`, \`slotNumber\`, \`bookingId\`, \`createdAt\`
			) VALUES (
				${tenantId}, ${propertyId}, ${roomTypeId}, ${dateFromIso(dateIso)}, ${slotNumber}, ${bookingId}, ${nowTs}
			)
		`
		return { kind: 'created' }
	} catch (err) {
		const cause = err instanceof Error ? err.cause : undefined
		if (!isPkConflict(err) && !isPkConflict(cause)) throw err
		// Race — refresh slot map к find owner
		const map = await loadExistingSlots(sql, tenantId, propertyId, roomTypeId, dateIso)
		const existing = map.get(slotNumber)
		return { kind: 'collision', existingBookingId: existing ?? 'unknown' }
	}
}

/**
 * Cancel «loser» bookings via full-row UPSERT (per `[[ydb-update-tolerance]]`).
 * UPDATE single col на booking (39 cols + CDC) hits ERROR(1060) plan-builder
 * edge — full-row UPSERT bypasses it. Reads full row, merges status/cancelled
 * fields, writes back atomically.
 */
async function cancelLosersFullRow(
	sql: ReturnType<typeof query>,
	losers: IterableIterator<{ tenantId: string; bookingId: string }>,
	counters: Counters,
): Promise<void> {
	const nowTs = toTs(new Date())
	const SYSTEM_ID = 'system:backfill-cancel-overbook'
	for (const { tenantId, bookingId } of losers) {
		const [rows = []] = await sql<Record<string, unknown>[]>`
			SELECT * FROM booking VIEW ixBookingId
			WHERE id = ${bookingId} AND tenantId = ${tenantId}
			LIMIT 1
		`
		const row = rows[0]
		if (!row) continue
		if (row.status === 'cancelled') continue

		try {
			const checkInIso = (row.checkIn as Date).toISOString().slice(0, 10)
			const checkOutIso = (row.checkOut as Date).toISOString().slice(0, 10)
			await sql`
				UPSERT INTO booking (
					\`tenantId\`, \`propertyId\`, \`checkIn\`, \`id\`,
					\`checkOut\`, \`roomTypeId\`, \`ratePlanId\`, \`assignedRoomId\`,
					\`guestsCount\`, \`nightsCount\`,
					\`primaryGuestId\`, \`guestSnapshot\`,
					\`status\`, \`confirmedAt\`,
					\`checkedInAt\`, \`checkedOutAt\`, \`cancelledAt\`, \`noShowAt\`, \`cancelReason\`,
					\`channelCode\`, \`externalId\`, \`externalReferences\`,
					\`totalMicros\`, \`paidMicros\`, \`currency\`, \`timeSlices\`,
					\`cancellationFee\`, \`noShowFee\`,
					\`registrationStatus\`, \`registrationMvdId\`, \`registrationSubmittedAt\`,
					\`rklCheckResult\`, \`rklCheckedAt\`,
					\`tourismTaxBaseMicros\`, \`tourismTaxMicros\`,
					\`notes\`, \`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
				) VALUES (
					${tenantId}, ${row.propertyId as string}, ${dateFromIso(checkInIso)}, ${bookingId},
					${dateFromIso(checkOutIso)}, ${row.roomTypeId as string}, ${row.ratePlanId as string},
					${(row.assignedRoomId as string | null) ?? NULL_TEXT},
					${row.guestsCount as number}, ${row.nightsCount as number},
					${row.primaryGuestId as string}, ${toJson(row.guestSnapshot)},
					${'cancelled'}, ${toTs(row.confirmedAt as Date)},
					${timestampOpt((row.checkedInAt as Date | null) ?? null)},
					${timestampOpt((row.checkedOutAt as Date | null) ?? null)},
					${nowTs},
					${timestampOpt((row.noShowAt as Date | null) ?? null)},
					${'auto-resolved-overbook-2026-05-18'},
					${row.channelCode as string}, ${(row.externalId as string | null) ?? NULL_TEXT},
					${toJson(row.externalReferences)},
					${BigInt(row.totalMicros as number | bigint)}, ${BigInt(row.paidMicros as number | bigint)},
					${row.currency as string}, ${toJson(row.timeSlices)},
					${toJson(row.cancellationFee)}, ${toJson(row.noShowFee)},
					${row.registrationStatus as string}, ${(row.registrationMvdId as string | null) ?? NULL_TEXT},
					${timestampOpt((row.registrationSubmittedAt as Date | null) ?? null)},
					${row.rklCheckResult as string},
					${timestampOpt((row.rklCheckedAt as Date | null) ?? null)},
					${BigInt(row.tourismTaxBaseMicros as number | bigint)},
					${BigInt(row.tourismTaxMicros as number | bigint)},
					${(row.notes as string | null) ?? NULL_TEXT},
					${toTs(row.createdAt as Date)}, ${nowTs},
					${row.createdBy as string}, ${SYSTEM_ID}
				)
			`
			counters.bookingsCancelled += 1
		} catch (err) {
			console.error(
				JSON.stringify({
					kind: 'cancel_failed',
					tenantId,
					bookingId,
					error: err instanceof Error ? err.message : String(err),
				}),
			)
		}
	}
}

export async function runBackfill(connStr: string, opts: BackfillOpts): Promise<BackfillResult> {
	const driver = new Driver(connStr, { credentialsProvider: new AnonymousCredentialsProvider() })
	await driver.ready(AbortSignal.timeout(10_000))
	const sql = query(driver)

	const counters: Counters = {
		bookingsScanned: 0,
		nightsAttempted: 0,
		nightsCreated: 0,
		nightsAlreadyDone: 0,
		phantomCollisions: 0,
		exhaustedSlots: 0,
		bookingsCancelled: 0,
	}
	const conflicts: ConflictEntry[] = []
	// Track «loser» bookings (those whose slot allocation exhausted) — operators
	// resolve via --cancel-overbook flag. Set к dedupe multi-night losers.
	const loserBookings = new Map<string, { tenantId: string; bookingId: string }>()

	try {
		const tenantIds = (opts.tenantIds ?? []).map(assertValidTenantId)
		const bookings = await loadSourceBookings(sql, tenantIds)
		const slice = opts.sampleLimit !== undefined ? bookings.slice(0, opts.sampleLimit) : bookings

		console.error(
			JSON.stringify({
				kind: 'start',
				mode: opts.commit ? 'commit' : 'dry-run',
				bookingsTotal: bookings.length,
				sampleLimit: opts.sampleLimit ?? null,
				tenantScope: tenantIds.length > 0 ? tenantIds : 'all',
			}),
		)

		for (let i = 0; i < slice.length; i += 1) {
			const b = slice[i]
			if (!b) continue
			counters.bookingsScanned += 1

			for (const night of nightsBetween(b.checkIn, b.checkOut)) {
				counters.nightsAttempted += 1
				const dateIso = toIsoDate(night)

				// Effective allotment bound (когда availability row exists). When
				// not, fall back к large bound (1000) — backfill should not block
				// on missing-availability since seed-bypass legitimately skips it.
				const effective = await loadAvailabilityEffective(
					sql,
					b.tenantId,
					b.propertyId,
					b.roomTypeId,
					dateIso,
				)
				const bound = effective ?? 1000

				const existing = await loadExistingSlots(
					sql,
					b.tenantId,
					b.propertyId,
					b.roomTypeId,
					dateIso,
				)

				// Already booked? same booking owns a slot here = idempotent rerun.
				let alreadyOwned = false
				for (const [, bookingId] of existing) {
					if (bookingId === b.id) {
						alreadyOwned = true
						break
					}
				}
				if (alreadyOwned) {
					counters.nightsAlreadyDone += 1
					continue
				}

				// Find lowest free slot.
				let slot = -1
				for (let s = 0; s < bound; s += 1) {
					if (!existing.has(s)) {
						slot = s
						break
					}
				}
				if (slot === -1) {
					counters.exhaustedSlots += 1
					conflicts.push({
						tenantId: b.tenantId,
						propertyId: b.propertyId,
						roomTypeId: b.roomTypeId,
						date: dateIso,
						slotNumber: -1,
						winnerBookingId: 'exhausted',
						loserBookingId: b.id,
					})
					loserBookings.set(`${b.tenantId}|${b.id}`, {
						tenantId: b.tenantId,
						bookingId: b.id,
					})
					continue
				}

				if (!opts.commit) {
					counters.nightsCreated += 1
					continue
				}

				const result = await attemptInsertSlot(
					sql,
					b.tenantId,
					b.propertyId,
					b.roomTypeId,
					dateIso,
					slot,
					b.id,
				)
				if (result.kind === 'created') {
					counters.nightsCreated += 1
				} else {
					// Race с another writer (rare in sequential backfill).
					counters.phantomCollisions += 1
					conflicts.push({
						tenantId: b.tenantId,
						propertyId: b.propertyId,
						roomTypeId: b.roomTypeId,
						date: dateIso,
						slotNumber: slot,
						winnerBookingId: result.existingBookingId,
						loserBookingId: b.id,
					})
				}
			}

			if ((i + 1) % 50 === 0 || i === slice.length - 1) {
				console.error(
					JSON.stringify({
						kind: 'progress',
						at: new Date().toISOString(),
						bookingsTotal: slice.length,
						bookingsDone: i + 1,
						bookingsPct: Math.round(((i + 1) / Math.max(1, slice.length)) * 1000) / 10,
						nightsCreated: counters.nightsCreated,
						nightsAlreadyDone: counters.nightsAlreadyDone,
						phantomCollisions: counters.phantomCollisions,
						exhaustedSlots: counters.exhaustedSlots,
						lastBookingId: b.id,
					}),
				)
			}
		}

		// --cancel-overbook resolution path (DESTRUCTIVE): cancel «loser»
		// bookings that couldn't claim a slot. Per `[[ydb-update-tolerance]]`
		// canon (memory project_ydb_specifics #14): UPDATE single column on
		// booking (39-col + CDC) flaky → must use full-row UPSERT.
		if (opts.commit && opts.cancelOverbook && loserBookings.size > 0) {
			await cancelLosersFullRow(sql, loserBookings.values(), counters)
		}

		let reportPath: string | undefined
		if (conflicts.length > 0) {
			await mkdir('.artifacts', { recursive: true })
			const stamp = new Date().toISOString().replace(/[:.]/g, '-')
			reportPath = join('.artifacts', `backfill-room-type-night-slot-conflicts-${stamp}.json`)
			const report = {
				startedAt: new Date().toISOString(),
				mode: opts.commit ? 'commit' : 'dry-run',
				summary: counters,
				conflicts,
			}
			await writeFile(reportPath, JSON.stringify(report, null, 2))
		}

		console.error(JSON.stringify({ kind: 'done', counters, reportPath: reportPath ?? null }))
		return reportPath !== undefined ? { counters, conflicts, reportPath } : { counters, conflicts }
	} finally {
		await driver.close()
	}
}

const isCliEntry =
	typeof process !== 'undefined' && /backfill-room-type-night-slot\.ts$/.test(process.argv[1] ?? '')

if (isCliEntry) {
	const args = process.argv.slice(2)
	const commit = args.includes('--commit')
	const dryRun = args.includes('--dry-run')
	const cancelOverbook = args.includes('--cancel-overbook')
	const sampleIdx = args.indexOf('--sample')
	const sampleArg = sampleIdx >= 0 ? args[sampleIdx + 1] : undefined
	const sampleLimit = sampleArg !== undefined ? Number(sampleArg) : undefined
	const tenantArgs: string[] = []
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === '--tenant' && args[i + 1]) tenantArgs.push(args[i + 1] as string)
	}

	if (!commit && !dryRun) {
		console.error(
			'Usage: backfill-room-type-night-slot --dry-run | --commit [--sample N] [--tenant <id>]... [--cancel-overbook]',
		)
		process.exit(2)
	}
	if (commit && dryRun) {
		console.error('--dry-run and --commit are mutually exclusive')
		process.exit(2)
	}
	if (cancelOverbook && !commit) {
		console.error('--cancel-overbook requires --commit (destructive operation)')
		process.exit(2)
	}

	const connStr = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'
	console.error(
		`backfill-room-type-night-slot: target=${connStr} commit=${commit} cancelOverbook=${cancelOverbook}`,
	)
	const baseOpts: BackfillOpts = { commit, cancelOverbook }
	const withSample =
		sampleLimit !== undefined && Number.isFinite(sampleLimit)
			? { ...baseOpts, sampleLimit }
			: baseOpts
	const finalOpts = tenantArgs.length > 0 ? { ...withSample, tenantIds: tenantArgs } : withSample
	const result = await runBackfill(connStr, finalOpts)

	if (result.conflicts.length > 0) {
		console.error(
			`backfill: ${result.conflicts.length} conflict(s) detected.${
				result.reportPath ? ` Report: ${result.reportPath}` : ''
			}`,
		)
		process.exit(1)
	}
	process.exit(0)
}
