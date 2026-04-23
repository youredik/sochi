import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Rate — per-date price amount for a (propertyId, roomTypeId, ratePlanId, date)
 * tuple. No `id` column: the tuple itself is the primary key. That's the ARI
 * convention — Google Hotel Content API, Booking.com, Expedia all shape rates
 * this way, as a nightly calendar. Operations are naturally bulk:
 *
 *   - Set a 30-day range to one amount (seasonal block)
 *   - Override one specific date (weekend bump)
 *   - Read a range for display on the booking widget
 *
 * Money: we store and transport as a decimal STRING in the public API
 * ("5000.50") and persist as `Int64 amountMicros` in YDB (see
 * `project_ydb_specifics.md` #13 — @ydbjs/value 6.x has no Decimal wrapper;
 * "micros" × 10^6 is the Google Ads / Stripe convention).
 */

/** YYYY-MM-DD ISO date string. */
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

/** Non-negative decimal amount, up to 6 fractional digits. "1234.56", "0.000001". */
const amountSchema = z
	.string()
	.regex(/^\d+(\.\d{1,6})?$/, 'Amount must be non-negative decimal with up to 6 fractional digits')

/** ISO 4217 currency code — 3 uppercase letters. */
const currencySchema = z
	.string()
	.length(3)
	.regex(/^[A-Z]{3}$/, 'Expected ISO 4217 currency code')

const singleRateSchema = z.object({
	date: dateSchema,
	amount: amountSchema,
	currency: currencySchema.default('RUB'),
})

/**
 * Bulk upsert: set/replace rates for multiple dates in one call. Idempotent
 * per-date (UPSERT by PK). Hard-capped at 365 to prevent accidental
 * gigantic payloads — OTAs that need more should chunk.
 */
export const rateBulkUpsertInput = z
	.object({
		rates: z.array(singleRateSchema).min(1).max(365),
	})
	.refine(
		(v) => new Set(v.rates.map((r) => r.date)).size === v.rates.length,
		'Duplicate dates in payload',
	)
export type RateBulkUpsertInput = z.infer<typeof rateBulkUpsertInput>

export const rateRatePlanParam = z.object({ ratePlanId: idSchema('ratePlan') })

export const rateDateParam = z.object({
	ratePlanId: idSchema('ratePlan'),
	date: dateSchema,
})

export const rateRangeParams = z
	.object({
		from: dateSchema,
		to: dateSchema,
	})
	.refine((v) => v.from <= v.to, { message: 'from must be <= to' })

export type Rate = {
	tenantId: string
	propertyId: string
	roomTypeId: string
	ratePlanId: string
	/** YYYY-MM-DD */
	date: string
	/** Decimal string, e.g. "5000.50" */
	amount: string
	/** ISO 4217 */
	currency: string
	/** ISO 8601 Timestamp string */
	createdAt: string
	/** ISO 8601 Timestamp string */
	updatedAt: string
}
