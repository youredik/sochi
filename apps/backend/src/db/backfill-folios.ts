/**
 * Backfill: ensure every existing booking row has a primary `folioId` link.
 *
 * Migration 0007 added `booking.folioId Utf8` (Nullable) but did NOT populate
 * it for pre-existing rows — DDL migrations can't run DML loops in our runner
 * (no auth/tenant context, single-pass). This script handles backfill at app
 * startup + as a pre-push gate, so the demo never sees a booking missing a folio.
 *
 * Idempotency contract:
 *   - Running multiple times must converge to the same state.
 *   - First run: creates a guest folio per booking that has none + sets folioId.
 *   - Drift recovery: if a folio already exists for a booking but folioId is
 *     NULL on the booking row (manual delete, partial migration), we relink
 *     to the existing folio rather than creating a duplicate.
 *   - Subsequent runs: 0 work (all bookings have folioId set).
 *
 * Tenant isolation:
 *   - Folios are created per-tenant matching the booking's tenantId. We never
 *     bridge across tenants. The script reads bookings with no tenant filter
 *     (system-level) but every write carries the booking's own tenantId.
 *
 * Limitations (V1 acceptable):
 *   - Sequential per row; for ~10K bookings this is ~30s. Optimize when we
 *     have real volume. Future: bulk UPSERT in batches of 100.
 *   - Currency hardcoded to 'RUB'; will need to read from `booking.currency`
 *     when V2 multi-currency lands.
 *
 * Usage:
 *   pnpm backfill             — runs against YDB_CONNECTION_STRING (default
 *                                grpc://localhost:2236/local).
 *   Hooked into `pnpm migrate` so `pnpm infra:reset` always backfills.
 */

import { newId } from '@horeca/shared'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Date as YdbDate } from '@ydbjs/value/primitive'
import { createFolioRepo } from '../domains/folio/folio.repo.ts'
import { NULL_TEXT, textOpt, timestampOpt, toJson, toTs } from './ydb-helpers.ts'

/** Wrap a JS Date as YDB `Date` column value (calendar day). gotcha #10. */
function ydbDate(d: Date): YdbDate {
	return new YdbDate(d)
}

/**
 * Strict typeid format guard. Regex matches the same pattern as
 * `idSchema('organization')` in shared so an invalid string can never reach
 * the SQL builder. Defends against future callers passing user input.
 */
const TYPEID_RE = /^[a-z]+_[0-9a-hjkmnp-tv-z]{26}$/
function assertValidTenantId(id: string): string {
	if (!TYPEID_RE.test(id)) {
		throw new Error(`Invalid tenantId format: ${JSON.stringify(id)}`)
	}
	return id
}

/**
 * The full booking row shape we read for backfill. Backfill uses full-row
 * UPSERT (not single-col UPDATE) because YDB's UPDATE plan-builder rejects
 * mixed-type SET clauses against tables with many nullable columns
 * (`Expected optional, but got: Utf8`). Verified empirically vs an isolated
 * 2-col table where single-col UPDATE works fine — the failure is specific
 * to booking's 39-col mix. Full-row UPSERT bypasses the plan edge.
 *
 * See `project_ydb_specifics.md` #14.
 */
type BookingFullRow = {
	tenantId: string
	propertyId: string
	checkIn: Date
	id: string
	checkOut: Date
	roomTypeId: string
	ratePlanId: string
	assignedRoomId: string | null
	guestsCount: number | bigint
	nightsCount: number | bigint
	primaryGuestId: string
	guestSnapshot: unknown
	status: string
	confirmedAt: Date
	checkedInAt: Date | null
	checkedOutAt: Date | null
	cancelledAt: Date | null
	noShowAt: Date | null
	cancelReason: string | null
	channelCode: string
	externalId: string | null
	externalReferences: unknown
	totalMicros: number | bigint
	paidMicros: number | bigint
	currency: string
	timeSlices: unknown
	cancellationFee: unknown
	noShowFee: unknown
	registrationStatus: string
	registrationMvdId: string | null
	registrationSubmittedAt: Date | null
	rklCheckResult: string
	rklCheckedAt: Date | null
	tourismTaxBaseMicros: number | bigint
	tourismTaxMicros: number | bigint
	notes: string | null
	createdAt: Date
	updatedAt: Date
	createdBy: string
	updatedBy: string
	folioId: string | null
}

type ExistingFolioForBooking = {
	tenantId: string
	propertyId: string
	bookingId: string
	folioId: string
}

/**
 * Stable typeid for the backfill actor. Generated once per process so:
 *   - Format is valid (`idSchema('user')` regex passes — defends against
 *     future code that adds runtime validation on `createdBy/updatedBy`).
 *   - Audit log can group "all writes from this backfill run" via the same id.
 *   - Never collides with a real user (typeid randomness, 122-bit space).
 */
const SYSTEM_USER_ID = newId('user')

async function runBackfill(
	connStr: string,
	opts: { tenantIds?: string[] } = {},
): Promise<{
	bookingsScanned: number
	foliosCreated: number
	bookingsRelinked: number
}> {
	const driver = new Driver(connStr, {
		credentialsProvider: new AnonymousCredentialsProvider(),
	})
	await driver.ready(AbortSignal.timeout(10_000))
	const sql = query(driver)
	const folioRepo = createFolioRepo(sql)

	try {
		// 1. Find bookings without folioId. SELECT the full row so we can do
		//    full-row UPSERT for the link (gotcha #14 — UPDATE on mixed-type
		//    SET clause vs booking's many nullable columns is unreliable).
		//
		//    `opts.tenantIds` scopes the scan to specific tenants. Parallel test
		//    runs use this to avoid contending with other domain test fixtures
		//    that create bookings with folioId=NULL transiently. Production
		//    use-case: per-tenant recovery after a partial migration.
		//
		//    Strict input validation: every tenantId must match the typeid regex
		//    BEFORE reaching SQL — defends against injection even though current
		//    callers all use newId() output. Defensive depth.
		const validatedTenantIds = (opts.tenantIds ?? []).map(assertValidTenantId)
		const tenantScope = validatedTenantIds.length > 0
		const pending = await loadPending(sql, validatedTenantIds, tenantScope)

		if (pending.length === 0) {
			return { bookingsScanned: 0, foliosCreated: 0, bookingsRelinked: 0 }
		}

		// 2. Drift detection: load existing folios for the same set of bookings.
		//    Map keyed by `tenantId|bookingId` → folioId.
		const existingFolios = new Map<string, string>()
		for (const b of pending) {
			const [rows = []] = await sql<ExistingFolioForBooking[]>`
				SELECT tenantId, propertyId, bookingId, id AS folioId
				FROM folio VIEW ixFolioBooking
				WHERE tenantId = ${b.tenantId} AND bookingId = ${b.id}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (row) {
				existingFolios.set(`${b.tenantId}|${b.id}`, row.folioId)
			}
		}

		let foliosCreated = 0
		let bookingsRelinked = 0

		// 3. Per-booking backfill.
		for (const b of pending) {
			const cacheKey = `${b.tenantId}|${b.id}`
			const existingFolioId = existingFolios.get(cacheKey)

			if (existingFolioId) {
				// Drift: folio exists, link is missing on booking. Relink only.
				await relinkBooking(sql, b, existingFolioId)
				bookingsRelinked += 1
				continue
			}

			// Fresh: create guest folio via repo + link booking via full-row UPSERT.
			// Two-step (not single tx) is acceptable: re-runs are idempotent
			// thanks to the drift-recovery branch above.
			const folio = await folioRepo.createForBooking(b.tenantId, b.propertyId, b.id, 'guest', {
				actorUserId: SYSTEM_USER_ID,
				currency: b.currency,
				companyId: null,
			})
			await relinkBooking(sql, b, folio.id)
			foliosCreated += 1
		}

		// 4. Re-scan to confirm convergence within scope. If tenantIds provided,
		//    only check those — global scope can fluctuate under parallel writes.
		const remaining = await countPending(sql, validatedTenantIds, tenantScope)
		if (remaining > 0) {
			throw new Error(
				`Backfill did not converge: ${remaining} booking row(s) still have folioId=NULL after run`,
			)
		}

		return {
			bookingsScanned: pending.length,
			foliosCreated,
			bookingsRelinked,
		}
	} finally {
		await driver.close()
	}
}

/**
 * Relink path: folio already exists (drift recovery OR fresh-after-create),
 * only update the booking row.
 */
/**
 * Load pending bookings, scoped to tenants when provided.
 *
 * Implementation note: YDB `IN (...)` with N items would normally take a List
 * binding. Our scope is small (tests pass 1-2 tenants), so we run a query per
 * tenant and merge — avoids both the unbound `IN (?)` complexity AND the SQL
 * injection vector that `sql.unsafe(...)` would open.
 */
async function loadPending(
	sql: ReturnType<typeof query>,
	validatedTenantIds: string[],
	tenantScope: boolean,
): Promise<BookingFullRow[]> {
	if (!tenantScope) {
		const [rows = []] = await sql<BookingFullRow[]>`
			SELECT * FROM booking WHERE folioId IS NULL
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return rows
	}
	const all: BookingFullRow[] = []
	for (const tenantId of validatedTenantIds) {
		const [rows = []] = await sql<BookingFullRow[]>`
			SELECT * FROM booking WHERE folioId IS NULL AND tenantId = ${tenantId}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		all.push(...rows)
	}
	return all
}

async function countPending(
	sql: ReturnType<typeof query>,
	validatedTenantIds: string[],
	tenantScope: boolean,
): Promise<number> {
	if (!tenantScope) {
		const [rows = []] = await sql<{ count: bigint }[]>`
			SELECT COUNT(*) AS count FROM booking WHERE folioId IS NULL
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return Number(rows[0]?.count ?? 0n)
	}
	let total = 0
	for (const tenantId of validatedTenantIds) {
		const [rows = []] = await sql<{ count: bigint }[]>`
			SELECT COUNT(*) AS count FROM booking
			WHERE folioId IS NULL AND tenantId = ${tenantId}
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		total += Number(rows[0]?.count ?? 0n)
	}
	return total
}

async function relinkBooking(
	sql: ReturnType<typeof query>,
	b: BookingFullRow,
	folioId: string,
): Promise<void> {
	// Full-row UPSERT (gotcha #14). Even with `textOpt` for folioId and a
	// single-column SET clause, YDB's UPDATE plan-builder rejected the bind
	// against booking's many nullable columns. UPSERT bypasses the plan edge.
	const nowTs = toTs(new Date())
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
			\`notes\`, \`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`,
			\`folioId\`
		) VALUES (
			${b.tenantId}, ${b.propertyId}, ${ydbDate(b.checkIn)}, ${b.id},
			${ydbDate(b.checkOut)}, ${b.roomTypeId}, ${b.ratePlanId}, ${b.assignedRoomId ?? NULL_TEXT},
			${b.guestsCount}, ${b.nightsCount},
			${b.primaryGuestId}, ${toJson(b.guestSnapshot)},
			${b.status}, ${toTs(b.confirmedAt)},
			${timestampOpt(b.checkedInAt)},
			${timestampOpt(b.checkedOutAt)},
			${timestampOpt(b.cancelledAt)},
			${timestampOpt(b.noShowAt)},
			${b.cancelReason ?? NULL_TEXT},
			${b.channelCode}, ${b.externalId ?? NULL_TEXT}, ${toJson(b.externalReferences)},
			${BigInt(b.totalMicros)}, ${BigInt(b.paidMicros)},
			${b.currency}, ${toJson(b.timeSlices)},
			${toJson(b.cancellationFee)}, ${toJson(b.noShowFee)},
			${b.registrationStatus}, ${b.registrationMvdId ?? NULL_TEXT},
			${timestampOpt(b.registrationSubmittedAt)},
			${b.rklCheckResult},
			${timestampOpt(b.rklCheckedAt)},
			${BigInt(b.tourismTaxBaseMicros)}, ${BigInt(b.tourismTaxMicros)},
			${b.notes ?? NULL_TEXT},
			${toTs(b.createdAt)}, ${nowTs}, ${b.createdBy}, ${SYSTEM_USER_ID},
			${textOpt(folioId)}
		)
	`
}

// CLI entry point — guard so this file is also importable from tests
// without triggering a script run.
const isCliEntry = typeof process !== 'undefined' && process.argv[1]?.includes('backfill-folios')

if (isCliEntry) {
	const connStr = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'
	console.log(`Backfilling folios against ${connStr}…`)
	const stats = await runBackfill(connStr)
	console.log(
		`Backfill complete: scanned ${stats.bookingsScanned} pending booking(s), ` +
			`created ${stats.foliosCreated} folio(s), relinked ${stats.bookingsRelinked}.`,
	)
}

export { runBackfill }
