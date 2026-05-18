/**
 * Backfill: materialize per-night `roomNightOccupancy` rows for every existing
 * pinned booking (`assignedRoomId IS NOT NULL AND status IN ('confirmed','in_house')`).
 *
 * **Why this exists**: migration `0062_room_night_occupancy.sql` introduced
 * the DB-level overbooking invariant via PK uniqueness on
 * `(tenantId, propertyId, roomId, date)`. Bookings that were pinned BEFORE
 * the migration ran have NO occupancy rows — so layer-2 DB invariant doesn't
 * protect them yet. This script writes the missing rows. Idempotent: re-runs
 * converge.
 *
 * **Canon refs**:
 *   - `[[overbooking-prevention-canon-2026-05-18]]` — companion to migration 0062
 *   - Agent research 2026-05-18 «Idempotent Backfill Canon for YDB 25.3» —
 *     PK-as-invariant + classify-on-conflict (NOT SELECT-then-INSERT race)
 *   - `[[project-ydb-specifics]]` #11 — sql.begin wraps errors in cause-chain;
 *     unwrap with `err.cause instanceof X`
 *   - `[[no-half-measures]]` — --dry-run default; --commit explicit; fail-non-zero
 *     on conflicts unless --accept-conflicts
 *   - `[[pii-guard-free-text-canon]]` — source SELECT projects ID-only columns,
 *     no guestSnapshot/notes/cancelReason. 152-ФЗ-safe by construction.
 *
 * **Three-class state machine** per (booking × night):
 *   - INSERT SUCCESS                    → counters.nightsCreated++
 *   - PK_CONFLICT same bookingId        → counters.nightsAlreadyDone++ (rerun)
 *   - PK_CONFLICT different bookingId   → counters.phantomOverbookings++,
 *                                         add к conflict report, continue
 *
 * **Usage**:
 *   pnpm exec node --experimental-strip-types apps/backend/src/db/backfill-room-night-occupancy.ts --dry-run
 *   pnpm exec node --experimental-strip-types apps/backend/src/db/backfill-room-night-occupancy.ts --commit
 *   pnpm exec node --experimental-strip-types apps/backend/src/db/backfill-room-night-occupancy.ts --commit --sample 10
 *   pnpm exec node --experimental-strip-types apps/backend/src/db/backfill-room-night-occupancy.ts --commit --accept-conflicts
 *   pnpm exec node --experimental-strip-types apps/backend/src/db/backfill-room-night-occupancy.ts --commit --tenant org_XXXX
 *
 * **Exit codes**:
 *   0  — success, no conflicts (or --accept-conflicts на conflicts)
 *   1  — phantom overbookings found, report written; re-run after resolving
 *   2  — usage error (neither --dry-run nor --commit specified)
 */

import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { query } from '@ydbjs/query'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dateFromIso, toTs } from './ydb-helpers.ts'

/** Strict typeid guard — defends against SQL injection if CLI args ever surface from user input. */
const TYPEID_RE = /^[a-z]+_[0-9a-hjkmnp-tv-z]{26}$/
function assertValidTenantId(id: string): string {
	if (!TYPEID_RE.test(id)) {
		throw new Error(`Invalid tenantId format: ${JSON.stringify(id)}`)
	}
	return id
}

/**
 * YDB PRECONDITION_FAILED status (issueCode 2012 «Conflict with existing key»).
 * Identical к the constant в `booking.repo.ts` — kept inline here к avoid
 * a cross-domain import that would trip `no-cross-domain` depcruise rule.
 */
const YDB_PRECONDITION_FAILED = 400120
function isPkConflict(err: unknown): err is YDBError {
	return err instanceof YDBError && err.code === YDB_PRECONDITION_FAILED
}

/** Projection used to scan source bookings. NO PII fields (152-ФЗ-safe). */
type SourceBookingRow = {
	tenantId: string
	propertyId: string
	checkIn: Date
	checkOut: Date
	id: string
	assignedRoomId: string
}

type ConflictEntry = {
	tenantId: string
	propertyId: string
	roomId: string
	date: string
	winnerBookingId: string
	loserBookingId: string
}

type Counters = {
	bookingsScanned: number
	nightsAttempted: number
	nightsCreated: number
	nightsAlreadyDone: number
	phantomOverbookings: number
}

export type BackfillOpts = {
	readonly commit: boolean
	readonly sampleLimit?: number
	readonly acceptConflicts: boolean
	readonly tenantIds?: readonly string[]
}

export type BackfillResult = {
	readonly counters: Counters
	readonly conflicts: readonly ConflictEntry[]
	readonly reportPath?: string
}

/** Compute the inclusive list of night dates [checkIn, checkOut). */
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
			SELECT tenantId, propertyId, checkIn, checkOut, id, assignedRoomId
			FROM booking
			WHERE assignedRoomId IS NOT NULL
				AND status IN ('confirmed', 'in_house')
			ORDER BY tenantId, propertyId, checkIn, id
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return rows
	}
	// Per-tenant query: YDB `IN (...)` binding ergonomics + small scope.
	const all: SourceBookingRow[] = []
	for (const tenantId of tenantIds) {
		const [rows = []] = await sql<SourceBookingRow[]>`
			SELECT tenantId, propertyId, checkIn, checkOut, id, assignedRoomId
			FROM booking
			WHERE assignedRoomId IS NOT NULL
				AND status IN ('confirmed', 'in_house')
				AND tenantId = ${tenantId}
			ORDER BY tenantId, propertyId, checkIn, id
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		all.push(...rows)
	}
	return all
}

async function lookupOccupancyOwner(
	sql: ReturnType<typeof query>,
	tenantId: string,
	propertyId: string,
	roomId: string,
	dateIso: string,
): Promise<string | null> {
	const [rows = []] = await sql<{ bookingId: string }[]>`
		SELECT bookingId FROM roomNightOccupancy
		WHERE tenantId = ${tenantId}
			AND propertyId = ${propertyId}
			AND roomId = ${roomId}
			AND date = ${dateFromIso(dateIso)}
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows[0]?.bookingId ?? null
}

async function attemptInsertNight(
	sql: ReturnType<typeof query>,
	tenantId: string,
	propertyId: string,
	roomId: string,
	dateIso: string,
	bookingId: string,
): Promise<
	{ kind: 'created' } | { kind: 'alreadyDone' } | { kind: 'conflict'; winnerBookingId: string }
> {
	const nowTs = toTs(new Date())
	try {
		await sql`
			INSERT INTO roomNightOccupancy (
				\`tenantId\`, \`propertyId\`, \`roomId\`, \`date\`, \`bookingId\`, \`createdAt\`
			) VALUES (
				${tenantId}, ${propertyId}, ${roomId}, ${dateFromIso(dateIso)}, ${bookingId}, ${nowTs}
			)
		`
		return { kind: 'created' }
	} catch (err) {
		const cause = err instanceof Error ? err.cause : undefined
		if (!isPkConflict(err) && !isPkConflict(cause)) throw err
		// PK collision → distinguish same-booking (rerun) vs phantom.
		const existingOwner = await lookupOccupancyOwner(sql, tenantId, propertyId, roomId, dateIso)
		if (!existingOwner) {
			throw new Error(
				`PRECONDITION_FAILED but no winner row found at (${tenantId},${propertyId},${roomId},${dateIso}) — invariant broken`,
			)
		}
		if (existingOwner === bookingId) return { kind: 'alreadyDone' }
		return { kind: 'conflict', winnerBookingId: existingOwner }
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
		phantomOverbookings: 0,
	}
	const conflicts: ConflictEntry[] = []

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

				if (!opts.commit) {
					// Dry-run: simulate via SELECT instead of INSERT. Classify same shape.
					const existing = await lookupOccupancyOwner(
						sql,
						b.tenantId,
						b.propertyId,
						b.assignedRoomId,
						dateIso,
					)
					if (existing === null) counters.nightsCreated += 1
					else if (existing === b.id) counters.nightsAlreadyDone += 1
					else {
						counters.phantomOverbookings += 1
						conflicts.push({
							tenantId: b.tenantId,
							propertyId: b.propertyId,
							roomId: b.assignedRoomId,
							date: dateIso,
							winnerBookingId: existing,
							loserBookingId: b.id,
						})
					}
					continue
				}

				const result = await attemptInsertNight(
					sql,
					b.tenantId,
					b.propertyId,
					b.assignedRoomId,
					dateIso,
					b.id,
				)
				if (result.kind === 'created') counters.nightsCreated += 1
				else if (result.kind === 'alreadyDone') counters.nightsAlreadyDone += 1
				else {
					counters.phantomOverbookings += 1
					conflicts.push({
						tenantId: b.tenantId,
						propertyId: b.propertyId,
						roomId: b.assignedRoomId,
						date: dateIso,
						winnerBookingId: result.winnerBookingId,
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
						nightsConflict: counters.phantomOverbookings,
						lastBookingId: b.id,
					}),
				)
			}
		}

		let reportPath: string | undefined
		if (conflicts.length > 0) {
			await mkdir('.artifacts', { recursive: true })
			const stamp = new Date().toISOString().replace(/[:.]/g, '-')
			reportPath = join('.artifacts', `backfill-room-night-occupancy-conflicts-${stamp}.json`)
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

// CLI entrypoint guard — file remains importable for tests. Match the script
// path EXACTLY (ends-with .ts), NOT `.db.test.ts` which would trip when bun
// imports this module under test.
const isCliEntry =
	typeof process !== 'undefined' && /backfill-room-night-occupancy\.ts$/.test(process.argv[1] ?? '')

if (isCliEntry) {
	const args = process.argv.slice(2)
	const commit = args.includes('--commit')
	const dryRun = args.includes('--dry-run')
	const acceptConflicts = args.includes('--accept-conflicts')
	const sampleIdx = args.indexOf('--sample')
	const sampleArg = sampleIdx >= 0 ? args[sampleIdx + 1] : undefined
	const sampleLimit = sampleArg !== undefined ? Number(sampleArg) : undefined
	const tenantArgs: string[] = []
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === '--tenant' && args[i + 1]) tenantArgs.push(args[i + 1] as string)
	}

	if (!commit && !dryRun) {
		console.error(
			'Usage: backfill-room-night-occupancy --dry-run | --commit [--sample N] [--accept-conflicts] [--tenant <id>]...',
		)
		process.exit(2)
	}
	if (commit && dryRun) {
		console.error('--dry-run and --commit are mutually exclusive')
		process.exit(2)
	}

	const connStr = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'
	console.error(`backfill-room-night-occupancy: target=${connStr} commit=${commit}`)
	const baseOpts: BackfillOpts = { commit, acceptConflicts }
	const withSample =
		sampleLimit !== undefined && Number.isFinite(sampleLimit)
			? { ...baseOpts, sampleLimit }
			: baseOpts
	const finalOpts = tenantArgs.length > 0 ? { ...withSample, tenantIds: tenantArgs } : withSample
	const result = await runBackfill(connStr, finalOpts)

	if (result.conflicts.length > 0) {
		console.error(
			`backfill: ${result.conflicts.length} phantom overbooking(s) detected.${
				result.reportPath ? ` Report: ${result.reportPath}` : ''
			}`,
		)
		if (!acceptConflicts) {
			console.error(
				'Re-run with --accept-conflicts after manual resolution к continue. Exiting non-zero.',
			)
			process.exit(1)
		}
	}
	process.exit(0)
}
