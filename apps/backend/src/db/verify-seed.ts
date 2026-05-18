/**
 * Post-seed invariants verifier — assert canonical reachability after a
 * tenant-scoped seed run. Per `[[project-north-star-canonical]]` /
 * `[[seed-canonical-no-bypass-2026-05-18]]`: demo IS production surface, so
 * seed must produce state that a real API call sequence could have reached.
 *
 * **Invariants** (each a separate check, all run; report all violations):
 *
 *   I1 — `availability.sold <= allotment + COALESCE(oversellDelta, 0)` for
 *        every availability row. Single-row guard against silent overbook
 *        каждого counter drift. (Variant 3 backing the slot-table PK.)
 *
 *   I2 — Every `confirmed`/`in_house` booking has EXACTLY `nightsCount`
 *        slot rows. Missing slot rows = bypass-write (or repo bug); excess
 *        = drift (stale cancel/checkout).
 *
 *   I3 — Every `cancelled` / `checked_out` booking has ZERO slot rows
 *        (lifecycle DELETE-on-terminal-transition).
 *
 *   I4 — `no_show` keeps slot rows (sold-retain canon); we don't fail на
 *        non-zero count — only а если count != nightsCount which would
 *        indicate drift. Folded into I2-style equality для these statuses.
 *
 *   I5 — Every booking (any status) has at least one folio row. CDC
 *        folio_creator_writer is responsible — empty folio = consumer
 *        broken or unfinished propagation.
 *
 *   I6 — No orphan slot rows: every `roomTypeNightSlot.bookingId` exists
 *        в `booking` table. Catches stale slots от deleted bookings.
 *
 *   I7 — No orphan occupancy rows: every `roomNightOccupancy.bookingId`
 *        exists в `booking` table. Same as I6 for pinned-room rows.
 *
 *   I8 — `availability.sold` matches COUNT(non-cancelled bookings overlapping
 *        that date). The counter is the «accounting» state: sold++ on create,
 *        sold-- ONLY on cancel; checkIn/checkOut/noShow leave it untouched
 *        (revenue retain canon). Comparing sold к slot rows would false-
 *        positive after checkOut (slots delete, sold retains by design).
 *
 * **Why this matters**: empirical proof commit 2026-05-18 caught 29
 * exhausted-slot artifacts because pre-refactor seed UPSERTed booking rows
 * directly без going через service path. Post-refactor proves 0 phantom
 * collisions, but absence-of-evidence is not evidence-of-absence. This
 * verifier IS the evidence: fail-fast при любом violation.
 *
 * **Usage**:
 *   - Called via `runSeedDemoTenant()` → `assertSeedState(TENANT_ID)` after seed
 *   - CI guard: pre-deploy check ensures golden state is canonically valid
 *   - Manual: `pnpm seed:demo:verify <tenantId>` (CLI entry)
 */

import { sql } from './index.ts'

export interface SeedInvariantViolation {
	readonly invariant: string
	readonly summary: string
	readonly count: number
	readonly sampleRows: ReadonlyArray<Record<string, unknown>>
}

/** Compute invariant violations for a tenant. Pure read-only — never mutates. */
export async function verifySeedState(tenantId: string): Promise<SeedInvariantViolation[]> {
	const violations: SeedInvariantViolation[] = []
	// Run all checks in parallel — each is read-only + snapshot-isolated,
	// no inter-dependencies. Cuts wall-time roughly 8×.
	const [I1, I2thru4, I5, I6, I7, I8] = await Promise.all([
		checkI1AvailabilityOverbook(tenantId),
		checkI2to4BookingSlotCounts(tenantId),
		checkI5BookingHasFolio(tenantId),
		checkI6OrphanSlots(tenantId),
		checkI7OrphanOccupancy(tenantId),
		checkI8SoldMatchesSlots(tenantId),
	])
	if (I1) violations.push(I1)
	violations.push(...I2thru4)
	if (I5) violations.push(I5)
	if (I6) violations.push(I6)
	if (I7) violations.push(I7)
	if (I8) violations.push(I8)
	return violations
}

/**
 * Assert all invariants pass. Throws с violation summary if any fail.
 * Logs ✅ + per-check counts on success (operator-friendly diagnostics).
 */
export async function assertSeedState(tenantId: string): Promise<void> {
	console.log(`🔍 Verifying seed invariants для tenant=${tenantId}`)
	const violations = await verifySeedState(tenantId)
	if (violations.length === 0) {
		console.log(
			'  ✅ All 8 invariants passed (I1 sold≤allotment, I2-I4 slot counts, I5 folios, I6+I7 no orphans, I8 sold==overlap).',
		)
		return
	}
	console.error(
		`  ❌ ${violations.length} invariant${violations.length === 1 ? '' : 's'} violated:`,
	)
	for (const v of violations) {
		console.error(`     [${v.invariant}] ${v.summary} (count=${v.count})`)
		for (const r of v.sampleRows.slice(0, 5)) {
			console.error('       sample:', JSON.stringify(r))
		}
	}
	throw new Error(
		`Seed invariants violated: ${violations.length} (${violations.map((v) => v.invariant).join(', ')}). ` +
			`See logs above. Canon: [[seed-canonical-no-bypass-2026-05-18]] + [[project-north-star-canonical]].`,
	)
}

// ---------------------------------------------------------------------------
// Individual invariant checks
// ---------------------------------------------------------------------------

/**
 * I1: availability.sold MUST be ≤ allotment + COALESCE(oversellDelta, 0).
 * Single-table aggregate; if violated, repo bypass-write or counter drift.
 */
async function checkI1AvailabilityOverbook(
	tenantId: string,
): Promise<SeedInvariantViolation | null> {
	const [rows = []] = await sql<
		{
			propertyId: string
			roomTypeId: string
			date: Date
			allotment: number | bigint
			oversellDelta: number | bigint | null
			sold: number | bigint
		}[]
	>`
		SELECT propertyId, roomTypeId, date, allotment, oversellDelta, sold
		FROM availability
		WHERE tenantId = ${tenantId}
			AND sold > allotment + COALESCE(oversellDelta, 0)
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	if (rows.length === 0) return null
	return {
		invariant: 'I1-availability-overbook',
		summary: 'availability.sold > allotment + oversellDelta',
		count: rows.length,
		sampleRows: rows.map((r) => ({
			propertyId: r.propertyId,
			roomTypeId: r.roomTypeId,
			date: r.date.toISOString().slice(0, 10),
			allotment: Number(r.allotment),
			oversellDelta: r.oversellDelta === null ? null : Number(r.oversellDelta),
			sold: Number(r.sold),
		})),
	}
}

/**
 * I2-I4: per-booking slot count matches expectation by status:
 *   - confirmed / in_house: expected = nightsCount
 *   - cancelled / checked_out: expected = 0
 *   - no_show: expected = nightsCount (sold-retain canon per migration 0063)
 *
 * Returns one violation per status-class found.
 */
async function checkI2to4BookingSlotCounts(tenantId: string): Promise<SeedInvariantViolation[]> {
	const [bookings = []] = await sql<{ id: string; status: string; nightsCount: number | bigint }[]>`
		SELECT id, status, nightsCount
		FROM booking
		WHERE tenantId = ${tenantId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)

	const [slotCounts = []] = await sql<{ bookingId: string; cnt: number | bigint }[]>`
		SELECT bookingId, COUNT(*) AS cnt
		FROM roomTypeNightSlot
		WHERE tenantId = ${tenantId}
		GROUP BY bookingId
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)

	const slotMap = new Map<string, number>(slotCounts.map((r) => [r.bookingId, Number(r.cnt)]))

	const missingActive: Array<Record<string, unknown>> = []
	const extraTerminal: Array<Record<string, unknown>> = []
	for (const b of bookings) {
		const actual = slotMap.get(b.id) ?? 0
		const nights = Number(b.nightsCount)
		if (b.status === 'confirmed' || b.status === 'in_house' || b.status === 'no_show') {
			if (actual !== nights) {
				missingActive.push({
					bookingId: b.id,
					status: b.status,
					expectedSlots: nights,
					actualSlots: actual,
				})
			}
		} else if (b.status === 'cancelled' || b.status === 'checked_out') {
			if (actual !== 0) {
				extraTerminal.push({
					bookingId: b.id,
					status: b.status,
					expectedSlots: 0,
					actualSlots: actual,
				})
			}
		}
	}

	const out: SeedInvariantViolation[] = []
	if (missingActive.length > 0) {
		out.push({
			invariant: 'I2-active-booking-missing-slots',
			summary: 'active booking (confirmed/in_house/no_show) has != nightsCount slot rows',
			count: missingActive.length,
			sampleRows: missingActive,
		})
	}
	if (extraTerminal.length > 0) {
		out.push({
			invariant: 'I3-terminal-booking-extra-slots',
			summary: 'terminal booking (cancelled/checked_out) still has slot rows',
			count: extraTerminal.length,
			sampleRows: extraTerminal,
		})
	}
	return out
}

/**
 * I5: every booking has at least one folio row. CDC folio_creator_writer
 * is responsible; if booking exists but folio empty = consumer broken or
 * unfinished propagation (caller should retry after CDC drain window).
 */
async function checkI5BookingHasFolio(tenantId: string): Promise<SeedInvariantViolation | null> {
	const [bookings = []] = await sql<{ id: string; status: string }[]>`
		SELECT id, status FROM booking WHERE tenantId = ${tenantId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)

	const [folios = []] = await sql<{ bookingId: string }[]>`
		SELECT DISTINCT bookingId FROM folio WHERE tenantId = ${tenantId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)

	const folioBookingIds = new Set(folios.map((r) => r.bookingId))
	const missing = bookings.filter((b) => !folioBookingIds.has(b.id))
	if (missing.length === 0) return null
	return {
		invariant: 'I5-booking-missing-folio',
		summary: 'booking has no folio row (CDC folio_creator_writer drift)',
		count: missing.length,
		sampleRows: missing.slice(0, 10).map((b) => ({ bookingId: b.id, status: b.status })),
	}
}

/**
 * I6: orphan slot rows — slot.bookingId pointing к non-existent booking.
 * Indicates stale slot row from a deleted booking (cancel/cleanup race).
 */
async function checkI6OrphanSlots(tenantId: string): Promise<SeedInvariantViolation | null> {
	const [slots = []] = await sql<{ bookingId: string }[]>`
		SELECT DISTINCT bookingId FROM roomTypeNightSlot WHERE tenantId = ${tenantId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	if (slots.length === 0) return null

	const [bookings = []] = await sql<{ id: string }[]>`
		SELECT id FROM booking WHERE tenantId = ${tenantId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)

	const bookingIds = new Set(bookings.map((b) => b.id))
	const orphans = slots.filter((s) => !bookingIds.has(s.bookingId))
	if (orphans.length === 0) return null
	return {
		invariant: 'I6-orphan-slot-rows',
		summary: 'roomTypeNightSlot.bookingId points к non-existent booking',
		count: orphans.length,
		sampleRows: orphans.slice(0, 10).map((s) => ({ bookingId: s.bookingId })),
	}
}

/**
 * I7: orphan occupancy rows — occupancy.bookingId pointing к non-existent
 * booking. Same shape as I6 but для pinned-room rows.
 */
async function checkI7OrphanOccupancy(tenantId: string): Promise<SeedInvariantViolation | null> {
	const [occ = []] = await sql<{ bookingId: string }[]>`
		SELECT DISTINCT bookingId FROM roomNightOccupancy WHERE tenantId = ${tenantId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	if (occ.length === 0) return null

	const [bookings = []] = await sql<{ id: string }[]>`
		SELECT id FROM booking WHERE tenantId = ${tenantId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)

	const bookingIds = new Set(bookings.map((b) => b.id))
	const orphans = occ.filter((s) => !bookingIds.has(s.bookingId))
	if (orphans.length === 0) return null
	return {
		invariant: 'I7-orphan-occupancy-rows',
		summary: 'roomNightOccupancy.bookingId points к non-existent booking',
		count: orphans.length,
		sampleRows: orphans.slice(0, 10).map((s) => ({ bookingId: s.bookingId })),
	}
}

/**
 * I8: `availability.sold` MUST equal COUNT(non-cancelled bookings overlapping
 * that date). This is the TRUE semantics of the counter per booking.repo:
 *   - create: sold += 1 per night
 *   - cancel: sold -= 1 per night
 *   - checkIn / checkOut / markNoShow: sold UNCHANGED (revenue retain canon)
 *
 * Therefore sold drifts INTENTIONALLY from slot count (slot deletes on
 * checkOut/cancel; sold only decrements on cancel). Comparing sold к slot
 * count would false-positive after every checkOut. The canonical invariant
 * compares sold к booking-overlap count.
 *
 * Catches: bypass-write trap (UPSERT INTO booking без sold++), CDC drift
 * (sold update lost), counter-skew bugs (sold-- on noShow by mistake).
 */
async function checkI8SoldMatchesSlots(tenantId: string): Promise<SeedInvariantViolation | null> {
	const [avail = []] = await sql<
		{
			propertyId: string
			roomTypeId: string
			date: Date
			sold: number | bigint
		}[]
	>`
		SELECT propertyId, roomTypeId, date, sold
		FROM availability
		WHERE tenantId = ${tenantId}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)

	const [bookings = []] = await sql<
		{
			propertyId: string
			roomTypeId: string
			checkIn: Date
			checkOut: Date
			status: string
		}[]
	>`
		SELECT propertyId, roomTypeId, checkIn, checkOut, status
		FROM booking
		WHERE tenantId = ${tenantId} AND status != 'cancelled'
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)

	const dateKey = (p: string, rt: string, dateIso: string): string => `${p}|${rt}|${dateIso}`
	const expectedMap = new Map<string, number>()
	for (const b of bookings) {
		const checkIn = new Date(b.checkIn)
		checkIn.setUTCHours(0, 0, 0, 0)
		const checkOut = new Date(b.checkOut)
		checkOut.setUTCHours(0, 0, 0, 0)
		const cursor = new Date(checkIn)
		while (cursor < checkOut) {
			const dateIso = cursor.toISOString().slice(0, 10)
			const key = dateKey(b.propertyId, b.roomTypeId, dateIso)
			expectedMap.set(key, (expectedMap.get(key) ?? 0) + 1)
			cursor.setUTCDate(cursor.getUTCDate() + 1)
		}
	}

	const drifted: Array<Record<string, unknown>> = []
	for (const a of avail) {
		const dateIso = a.date.toISOString().slice(0, 10)
		const key = dateKey(a.propertyId, a.roomTypeId, dateIso)
		const expected = expectedMap.get(key) ?? 0
		const actual = Number(a.sold)
		if (actual !== expected) {
			drifted.push({
				propertyId: a.propertyId,
				roomTypeId: a.roomTypeId,
				date: dateIso,
				expectedSold: expected,
				actualSold: actual,
			})
		}
	}
	// Reverse: booking overlap exists but availability row missing — would
	// indicate seed-bypass на availability table (canonical create requires
	// availability row to exist per booking.repo NoInventoryError).
	for (const [key, expected] of expectedMap) {
		const [propertyId, roomTypeId, dateIso] = key.split('|') as [string, string, string]
		const found = avail.find(
			(a) =>
				a.propertyId === propertyId &&
				a.roomTypeId === roomTypeId &&
				a.date.toISOString().slice(0, 10) === dateIso,
		)
		if (!found) {
			drifted.push({
				propertyId,
				roomTypeId,
				date: dateIso,
				expectedSold: expected,
				actualSold: 'MISSING_AVAIL_ROW',
			})
		}
	}
	if (drifted.length === 0) return null
	return {
		invariant: 'I8-sold-counter-drift',
		summary:
			'availability.sold ≠ COUNT(non-cancelled bookings overlapping date) — counter has drifted off canonical semantics',
		count: drifted.length,
		sampleRows: drifted.slice(0, 10),
	}
}

// ---------------------------------------------------------------------------
// CLI entry — `pnpm exec node --experimental-strip-types verify-seed.ts <tenantId>`
// ---------------------------------------------------------------------------
const isCliEntry = typeof process !== 'undefined' && process.argv[1]?.includes('verify-seed')
if (isCliEntry) {
	const tenantId = process.argv[2]
	if (!tenantId) {
		console.error('Usage: verify-seed <tenantId>')
		process.exit(2)
	}
	assertSeedState(tenantId)
		.then(() => process.exit(0))
		.catch((err) => {
			console.error('❌ Verification failed:', err instanceof Error ? err.message : err)
			process.exit(1)
		})
}
