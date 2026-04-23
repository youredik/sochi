import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Availability — per-date inventory and restrictions for a (propertyId,
 * roomTypeId, date) tuple. Like `rate` but at the roomType level (one
 * entry per roomType per date, NOT per ratePlan).
 *
 * Pooled inventory model (Cloudbeds/Beds24 convention, see memory
 * `project_horeca_domain_model.md`): all channels share one `allotment`
 * total. `sold` advances per confirmed booking. `allotment - sold` =
 * currently sellable count. Overbooking is possible by setting
 * `allotment > roomType.inventoryCount` explicitly, but not the default.
 *
 * Inline date restrictions:
 *   - `minStay` / `maxStay` — length-of-stay override for this specific
 *     date. Null means "inherit from ratePlan defaults".
 *   - `closedToArrival` (CTA) — bookings may include this date but not
 *     START on it. Typical weekend-hold for small hotels.
 *   - `closedToDeparture` (CTD) — opposite.
 *   - `stopSell` — no bookings at all for this date, regardless of
 *     remaining allotment. Emergency switch.
 *
 * `sold` is adjusted by the booking service, NEVER directly via the
 * availability API — there'd be no atomicity with the booking row.
 */

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const allotmentSchema = z.coerce.number().int().min(0).max(10_000)
const losSchema = z.coerce.number().int().min(1).max(365)

const singleAvailabilitySchema = z.object({
	date: dateSchema,
	allotment: allotmentSchema,
	minStay: losSchema.nullable().optional(),
	maxStay: losSchema.nullable().optional(),
	// Booleans are `.optional()` not `.default(false)` so `z.infer<>` output
	// matches the input shape — callers may omit them. The repo fills `false`
	// when absent (see `availability.repo.ts` bulkUpsert).
	closedToArrival: z.boolean().optional(),
	closedToDeparture: z.boolean().optional(),
	stopSell: z.boolean().optional(),
})

export const availabilityBulkUpsertInput = z
	.object({
		rates: z.array(singleAvailabilitySchema).min(1).max(365),
	})
	.refine(
		(v) => new Set(v.rates.map((r) => r.date)).size === v.rates.length,
		'Duplicate dates in payload',
	)
export type AvailabilityBulkUpsertInput = z.infer<typeof availabilityBulkUpsertInput>

export const availabilityRoomTypeParam = z.object({ roomTypeId: idSchema('roomType') })
export const availabilityDateParam = z.object({
	roomTypeId: idSchema('roomType'),
	date: dateSchema,
})
export const availabilityRangeParams = z
	.object({
		from: dateSchema,
		to: dateSchema,
	})
	.refine((v) => v.from <= v.to, { message: 'from must be <= to' })

export type Availability = {
	tenantId: string
	propertyId: string
	roomTypeId: string
	date: string
	allotment: number
	/** Booked count — adjusted only by the booking service, read-only from availability API. */
	sold: number
	minStay: number | null
	maxStay: number | null
	closedToArrival: boolean
	closedToDeparture: boolean
	stopSell: boolean
	createdAt: string
	updatedAt: string
}
