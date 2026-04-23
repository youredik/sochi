import type { Rate, RateBulkUpsertInput } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import {
	dateFromIso,
	decimalToMicros,
	microsToDecimal,
	toTs,
	tsFromIso,
} from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

/**
 * Rate repository. The table PK is compound
 * `(tenantId, propertyId, roomTypeId, ratePlanId, date)` — no surrogate `id`,
 * each row IS the (plan × date) cell in the pricing calendar.
 *
 * Money is stored as `Int64 amountMicros` in YDB (@ydbjs/value 6.x has no
 * Decimal wrapper — see `project_ydb_specifics.md` #13). Helpers
 * `decimalToMicros` / `microsToDecimal` translate at the boundary.
 *
 * Dates (`Date` column) require `new YdbDate(d)` wrap — the default JS Date
 * inference is Datetime, which YDB rejects for Date columns with
 * `ERROR(1030)`. Helper `dateFromIso` in ydb-helpers.
 */
type RateRow = {
	tenantId: string
	propertyId: string
	roomTypeId: string
	ratePlanId: string
	date: Date
	amountMicros: number | bigint
	currency: string
	createdAt: Date
	updatedAt: Date
}

function rowToRate(r: RateRow): Rate {
	const micros = typeof r.amountMicros === 'bigint' ? r.amountMicros : BigInt(r.amountMicros)
	// YDB Date comes back as JS Date at 00:00:00Z; format to YYYY-MM-DD.
	const iso = r.date.toISOString()
	const ymd = iso.slice(0, 10)
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		roomTypeId: r.roomTypeId,
		ratePlanId: r.ratePlanId,
		date: ymd,
		amount: microsToDecimal(micros),
		currency: r.currency,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

export function createRateRepo(sql: SqlInstance) {
	return {
		async listRange(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			ratePlanId: string,
			range: { from: string; to: string },
		): Promise<Rate[]> {
			const fromDate = dateFromIso(range.from)
			const toDate = dateFromIso(range.to)
			const [rows = []] = await sql<RateRow[]>`
				SELECT * FROM rate
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND roomTypeId = ${roomTypeId}
					AND ratePlanId = ${ratePlanId}
					AND date >= ${fromDate}
					AND date <= ${toDate}
				ORDER BY date ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToRate)
		},

		async getOne(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			ratePlanId: string,
			date: string,
		): Promise<Rate | null> {
			const [rows = []] = await sql<RateRow[]>`
				SELECT * FROM rate
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND roomTypeId = ${roomTypeId}
					AND ratePlanId = ${ratePlanId}
					AND date = ${dateFromIso(date)}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToRate(row) : null
		},

		/**
		 * Upsert one date at a time inside a single transaction so the whole
		 * batch succeeds or nothing does. A bulk single-statement UPSERT of
		 * many VALUES tuples is possible but tricky to build via template
		 * interpolation — per-row UPSERT inside `sql.begin` is clearer and
		 * still atomic.
		 *
		 * Returns the full upserted set, reshaped through `getOne` so callers
		 * see exactly what's persisted (incl. Timestamp truncation visibility
		 * and existing createdAt preservation).
		 */
		async bulkUpsert(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			ratePlanId: string,
			input: RateBulkUpsertInput,
		): Promise<Rate[]> {
			const now = new Date()
			const nowTs = toTs(now)

			await sql.begin(async (tx) => {
				for (const r of input.rates) {
					const micros = decimalToMicros(r.amount)
					// Preserve createdAt on overwrite so audit trail doesn't lie;
					// SELECT existing first, fall back to `now` for new rows.
					const [existingRows = []] = await tx<{ createdAt: Date }[]>`
						SELECT createdAt FROM rate
						WHERE tenantId = ${tenantId}
							AND propertyId = ${propertyId}
							AND roomTypeId = ${roomTypeId}
							AND ratePlanId = ${ratePlanId}
							AND date = ${dateFromIso(r.date)}
						LIMIT 1
					`
					const createdAtTs = existingRows[0]
						? tsFromIso(existingRows[0].createdAt.toISOString())
						: nowTs
					await tx`
						UPSERT INTO rate (
							\`tenantId\`, \`propertyId\`, \`roomTypeId\`, \`ratePlanId\`, \`date\`,
							\`amountMicros\`, \`currency\`, \`createdAt\`, \`updatedAt\`
						) VALUES (
							${tenantId}, ${propertyId}, ${roomTypeId}, ${ratePlanId}, ${dateFromIso(r.date)},
							${micros}, ${r.currency}, ${createdAtTs}, ${nowTs}
						)
					`
				}
			})

			// Compute min/max explicitly — input may be unsorted; Zod guarantees
			// `rates.length >= 1` but `noUncheckedIndexedAccess` still types [0]
			// as possibly-undefined, so we reduce instead of asserting non-null.
			const sortedDates = input.rates.map((r) => r.date).sort()
			const from = sortedDates[0] ?? input.rates[0]?.date ?? ''
			const to = sortedDates[sortedDates.length - 1] ?? from
			return this.listRange(tenantId, propertyId, roomTypeId, ratePlanId, { from, to })
		},

		async deleteOne(
			tenantId: string,
			propertyId: string,
			roomTypeId: string,
			ratePlanId: string,
			date: string,
		): Promise<boolean> {
			const existing = await this.getOne(tenantId, propertyId, roomTypeId, ratePlanId, date)
			if (!existing) return false
			await sql`
				DELETE FROM rate
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND roomTypeId = ${roomTypeId}
					AND ratePlanId = ${ratePlanId}
					AND date = ${dateFromIso(date)}
			`
			return true
		},
	}
}

export type RateRepo = ReturnType<typeof createRateRepo>
