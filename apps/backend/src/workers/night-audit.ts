/**
 * Night-audit runner — посты per-night accommodation lines для каждого
 * `in_house` booking, по одной за каждую business date в окне stay.
 *
 * Cron: 03:00 Europe/Moscow daily. На boot — catch-up pass (handle restart-during-window).
 *
 * **Idempotency canon (M7.A.2 round-1)**: deterministic folioLine.id —
 *   `audit_<folioId>_<YYYYMMDD>`. PK collision = no-op. Pre-check select
 *   short-circuits before any UPSERT/UPDATE → balance math idempotent across
 *   any number of replays (cron retry, server restart, manual catch-up).
 *
 * **Why standalone, не CDC handler**: time-driven (not event-driven). Booking
 * INSERT не triggers post — accumulation happens день за днём по календарю.
 * Mirroring Apaleo's `night-audit` job pattern.
 *
 * **Concurrency**: single-instance assumption (one Node process за tenant).
 * If we ever scale to N replicas, добавить `night_audit_run` row keyed by
 * `(propertyId, businessDate)` с `INSERT IF NOT EXISTS` для elect-leader. Сейчас
 * deterministic line ID + idempotent SELECT-pre-check уже даёт exactly-once.
 */

import type { sql as SQL } from '../db/index.ts'
import { NULL_TEXT, NULL_TIMESTAMP, toTs } from '../db/ydb-helpers.ts'
import {
	addDays,
	businessDate,
	nightAuditLineId,
	nightsToAudit,
	priceMinorForDate,
} from './lib/night-audit.ts'

type SqlInstance = typeof SQL

/**
 * Minimal logger interface — mirrors `HandlerLogger` in `handlers/refund-creator.ts`
 * + adds `error` for run-level failures. Inlined per CDC handler convention so
 * tests don't pull in `log.ts → env.ts → process.exit` chain.
 */
export interface AuditLogger {
	debug: (obj: object, msg?: string) => void
	info: (obj: object, msg?: string) => void
	warn: (obj: object, msg?: string) => void
	error: (obj: object, msg?: string) => void
}

const NIGHT_AUDIT_ACTOR_ID = 'system:night_audit'

type BookingRow = {
	tenantId: string
	propertyId: string
	id: string
	checkIn: Date
	checkOut: Date
	status: string
	currency: string
	// @ydbjs/query deserialises Json columns into JS values directly — array,
	// not stringified JSON. grossMicros is stored as Int64 string per `toJson`
	// bigint serialiser convention.
	timeSlices: Array<{ date: string; grossMicros: string | number | bigint }>
}

type FolioRow = {
	id: string
	version: number | bigint
	balanceMinor: number | bigint
	status: string
	currency: string
}

type ParsedTimeSlice = { date: string; grossMicros: bigint }

/**
 * Run the night-audit pass for **all** in-house bookings up to the given
 * business date.
 *
 * Returns counts: how many bookings inspected, how many lines posted (skipped
 * idempotently when line already exists). Use these for observability.
 *
 * Errors per-booking are logged but do NOT abort the whole pass. One bad
 * booking shouldn't stop the rest of the property's audit.
 */
export async function runNightAudit(
	sql: SqlInstance,
	log: AuditLogger,
	opts: { now?: Date; cutoffHourMsk?: number } = {},
): Promise<{ bookingsScanned: number; linesPosted: number; linesSkipped: number; errors: number }> {
	const now = opts.now ?? new Date()
	const today = businessDate(now, opts.cutoffHourMsk ?? 3)
	// At a 03:00 audit on business day D, the latest **fully-elapsed** night is
	// D-1 (the night just ended; D's night is still in progress). Pass that to
	// the pure-lib `nightsToAudit` window-builder.
	const lastEndedNight = addDays(today, -1)
	log.info({ businessDate: today, lastEndedNight, now: now.toISOString() }, 'night-audit: start')

	const bookings = await loadInHouseBookings(sql)
	let linesPosted = 0
	let linesSkipped = 0
	let errors = 0

	for (const booking of bookings) {
		try {
			const result = await auditBooking(sql, log, booking, lastEndedNight)
			linesPosted += result.posted
			linesSkipped += result.skipped
		} catch (err) {
			errors += 1
			log.error(
				{ tenantId: booking.tenantId, bookingId: booking.id, err },
				'night-audit: booking failed — continuing with next',
			)
		}
	}

	log.info(
		{
			businessDate: today,
			lastEndedNight,
			bookingsScanned: bookings.length,
			linesPosted,
			linesSkipped,
			errors,
		},
		'night-audit: done',
	)
	return { bookingsScanned: bookings.length, linesPosted, linesSkipped, errors }
}

/* ---------------------------------------------------------------- internals */

async function loadInHouseBookings(sql: SqlInstance): Promise<BookingRow[]> {
	const [rows = []] = await sql<BookingRow[]>`
		SELECT tenantId, propertyId, id, checkIn, checkOut, status, currency, timeSlices
		FROM booking
		WHERE status = 'in_house'
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows
}

async function auditBooking(
	sql: SqlInstance,
	log: AuditLogger,
	booking: BookingRow,
	upToBusinessDate: string,
): Promise<{ posted: number; skipped: number }> {
	const checkInIso = toIsoDate(booking.checkIn)
	const checkOutIso = toIsoDate(booking.checkOut)
	const nights = nightsToAudit(
		{ status: booking.status, checkIn: checkInIso, checkOut: checkOutIso },
		upToBusinessDate,
	)
	if (nights.length === 0) return { posted: 0, skipped: 0 }

	const slices = parseTimeSlices(booking.timeSlices, log, booking)
	if (!slices) return { posted: 0, skipped: 0 }

	// Resolve primary guest folio (kind='guest', status='open'). If no open
	// folio, audit skips this booking — folio_creator should have made one,
	// missing = manual close без re-open.
	const folio = await loadGuestFolio(sql, booking.tenantId, booking.id)
	if (!folio) {
		log.warn(
			{ tenantId: booking.tenantId, bookingId: booking.id },
			'night-audit: no open guest folio for in_house booking — skipping',
		)
		return { posted: 0, skipped: 0 }
	}

	let posted = 0
	let skipped = 0

	for (const night of nights) {
		const lineId = nightAuditLineId(folio.id, night)
		const amountMinor = priceMinorForDate(slices, night)
		if (amountMinor === null) {
			log.warn(
				{ tenantId: booking.tenantId, bookingId: booking.id, night },
				'night-audit: no time-slice for date — skipping (corrupted snapshot?)',
			)
			continue
		}
		if (amountMinor === 0n) {
			// Free night (complimentary, comp upgrade, loyalty perk) — no charge to post.
			skipped += 1
			continue
		}

		try {
			const result = await postNightLine(sql, {
				tenantId: booking.tenantId,
				folioId: folio.id,
				lineId,
				night,
				amountMinor,
			})
			if (result === 'posted') posted += 1
			else skipped += 1
		} catch (err) {
			log.error(
				{ tenantId: booking.tenantId, bookingId: booking.id, night, err },
				'night-audit: postNightLine failed — continuing',
			)
		}
	}

	return { posted, skipped }
}

async function loadGuestFolio(
	sql: SqlInstance,
	tenantId: string,
	bookingId: string,
): Promise<FolioRow | null> {
	const [rows = []] = await sql<FolioRow[]>`
		SELECT id, version, balanceMinor, status, currency
		FROM folio VIEW ixFolioBooking
		WHERE tenantId = ${tenantId} AND bookingId = ${bookingId} AND kind = 'guest' AND status = 'open'
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows[0] ?? null
}

/**
 * Append one accommodation line to a folio inside a serializable tx.
 *
 * Concurrency model: read-modify-write inside `sql.begin` — YDB's serializable
 * isolation detects conflicts with concurrent payment/refund posts and the
 * driver retries the closure (`idempotent: true`). No client-side CAS needed.
 *
 * Idempotency: deterministic PK pre-check; if a line with the same id already
 * exists, no-op (covers cron retries, restart catch-up, manual replays).
 */
async function postNightLine(
	sql: SqlInstance,
	args: {
		tenantId: string
		folioId: string
		lineId: string
		night: string
		amountMinor: bigint
	},
): Promise<'posted' | 'skipped'> {
	return await sql.begin({ idempotent: true }, async (tx) => {
		// Idempotency pre-check — exact PK match.
		const [existing = []] = await tx<{ x: number }[]>`
			SELECT 1 AS x FROM folioLine
			WHERE tenantId = ${args.tenantId} AND folioId = ${args.folioId} AND id = ${args.lineId}
			LIMIT 1
		`
		if (existing.length > 0) return 'skipped'

		// Re-read folio inside tx — serializable isolation makes this the
		// authoritative state for the upcoming write. No expected-version CAS:
		// any concurrent writer is serialized behind us by YDB.
		const [folioRows = []] = await tx<
			{
				version: number | bigint
				balanceMinor: number | bigint
				propertyId: string
				bookingId: string
				kind: string
				status: string
				currency: string
				createdAt: Date
				createdBy: string
				closedAt: Date | null
				settledAt: Date | null
				closedBy: string | null
				companyId: string | null
			}[]
		>`
			SELECT propertyId, bookingId, kind, status, currency, balanceMinor, version,
			       createdAt, createdBy, closedAt, settledAt, closedBy, companyId
			FROM folio VIEW ixFolioBooking
			WHERE tenantId = ${args.tenantId} AND id = ${args.folioId}
			LIMIT 1
		`
		const folio = folioRows[0]
		if (!folio) return 'skipped'
		if (folio.status !== 'open') return 'skipped'

		const now = new Date()
		const nowTs = toTs(now)
		const description = `Проживание ${args.night}`

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
				${args.tenantId}, ${args.folioId}, ${args.lineId},
				${'accommodation'}, ${description}, ${args.amountMinor},
				${true}, ${0},
				${'posted'}, ${NULL_TEXT},
				${nowTs}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
				${1},
				${nowTs}, ${nowTs}, ${NIGHT_AUDIT_ACTOR_ID}, ${NIGHT_AUDIT_ACTOR_ID}
			)
		`

		const newBalance = BigInt(folio.balanceMinor) + args.amountMinor
		const newVersion = Number(folio.version) + 1

		await tx`
			UPSERT INTO folio (
				\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
				\`kind\`, \`status\`, \`currency\`,
				\`balanceMinor\`, \`version\`,
				\`closedAt\`, \`settledAt\`, \`closedBy\`, \`companyId\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${args.tenantId}, ${folio.propertyId}, ${folio.bookingId}, ${args.folioId},
				${folio.kind}, ${folio.status}, ${folio.currency},
				${newBalance}, ${newVersion},
				${folio.closedAt ? toTs(folio.closedAt) : NULL_TIMESTAMP},
				${folio.settledAt ? toTs(folio.settledAt) : NULL_TIMESTAMP},
				${folio.closedBy ?? NULL_TEXT}, ${folio.companyId ?? NULL_TEXT},
				${toTs(folio.createdAt)}, ${nowTs}, ${folio.createdBy}, ${NIGHT_AUDIT_ACTOR_ID}
			)
		`
		return 'posted'
	})
}

/* ---------------------------------------------------------------- helpers */

function parseTimeSlices(
	raw: BookingRow['timeSlices'],
	log: AuditLogger,
	booking: { tenantId: string; id: string },
): ParsedTimeSlice[] | null {
	if (!Array.isArray(raw)) {
		log.warn(
			{ tenantId: booking.tenantId, bookingId: booking.id },
			'night-audit: timeSlices not an array — corrupted snapshot',
		)
		return null
	}
	try {
		return raw.map((s) => ({ date: s.date, grossMicros: BigInt(s.grossMicros) }))
	} catch (err) {
		log.warn(
			{ tenantId: booking.tenantId, bookingId: booking.id, err },
			'night-audit: failed to coerce grossMicros to BigInt',
		)
		return null
	}
}

function toIsoDate(d: Date): string {
	return d.toISOString().slice(0, 10)
}

// Re-exports for convenience (cron module + tests).
export { addDays, businessDate, nightAuditLineId, nightsToAudit, priceMinorForDate }
