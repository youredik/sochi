import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * RatePlan — one sellable price-and-policy template for a specific roomType
 * within a property. The industry-standard base for Sochi launch is two plans
 * per roomType: BAR-flexible (`BAR`) and BAR-non-refundable (`BAR-NR`).
 *
 * Per ARI model (see memory `project_horeca_domain_model.md`):
 *   - `code` is the OTA-facing short id ("BAR", "BAR-NR", "CORP", "FLEX").
 *     Must be unique within a property; enforced by UNIQUE index in migration 0003.
 *   - `isDefault` marks the default plan that'll be picked when the OTA doesn't
 *     specify one. Application-level invariant: at most one per roomType.
 *   - `mealsIncluded` follows Mews/Cloudbeds enum convention.
 *   - `cancellationHours` is the free-cancellation window: null = non-refundable,
 *     0 = until check-in minute, 24/48/72 = typical flex/moderate.
 *   - Prices themselves live in the `rate` table (per-date amounts), not here.
 *     This table only defines the contract / policy.
 */

const codeSchema = z
	.string()
	.min(1)
	.max(50)
	.regex(
		/^[A-Z][A-Z0-9_-]*$/,
		'Rate plan code must start with a letter and use uppercase letters, digits, dash, underscore',
	)

const mealsValues = ['none', 'breakfast', 'halfBoard', 'fullBoard', 'allInclusive'] as const
export const mealsIncludedSchema = z.enum(mealsValues)
export type MealsIncluded = z.infer<typeof mealsIncludedSchema>

/** ISO 4217 currency code — 3 uppercase letters. */
const currencySchema = z
	.string()
	.length(3)
	.regex(/^[A-Z]{3}$/, 'Expected ISO 4217 currency code (e.g. RUB, USD, EUR)')

/** Free-cancellation window in hours before check-in. 0 = until check-in, null = non-refundable. */
const cancellationHoursSchema = z.coerce
	.number()
	.int()
	.min(0)
	.max(30 * 24)

/** Length-of-stay restrictions. */
const minStaySchema = z.coerce.number().int().min(1).max(30)
const maxStaySchema = z.coerce.number().int().min(1).max(365)

export const ratePlanCreateInput = z
	.object({
		roomTypeId: idSchema('roomType'),
		name: z.string().min(1).max(200),
		code: codeSchema,
		isDefault: z.boolean().default(false),
		isRefundable: z.boolean().default(true),
		cancellationHours: cancellationHoursSchema.optional(),
		mealsIncluded: mealsIncludedSchema.default('none'),
		minStay: minStaySchema.default(1),
		maxStay: maxStaySchema.optional(),
		currency: currencySchema.default('RUB'),
	})
	.refine(
		(v) => !v.isRefundable || v.cancellationHours !== undefined,
		'Refundable rate plan must specify cancellationHours',
	)
	.refine((v) => v.maxStay === undefined || v.maxStay >= v.minStay, 'maxStay must be >= minStay')
export type RatePlanCreateInput = z.infer<typeof ratePlanCreateInput>

/**
 * Patch-style update. Nullable fields (`cancellationHours`, `maxStay`) accept
 * `null` for "explicit clear" — non-refundable rate has no cancellation
 * window, unrestricted rate has no max LOS.
 */
export const ratePlanUpdateInput = z
	.object({
		name: z.string().min(1).max(200).optional(),
		code: codeSchema.optional(),
		isDefault: z.boolean().optional(),
		isRefundable: z.boolean().optional(),
		cancellationHours: cancellationHoursSchema.nullable().optional(),
		mealsIncluded: mealsIncludedSchema.optional(),
		minStay: minStaySchema.optional(),
		maxStay: maxStaySchema.nullable().optional(),
		currency: currencySchema.optional(),
		isActive: z.boolean().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, 'At least one field must be provided')
export type RatePlanUpdateInput = z.infer<typeof ratePlanUpdateInput>

export const ratePlanIdParam = z.object({ id: idSchema('ratePlan') })
export const ratePlanPropertyParam = z.object({ propertyId: idSchema('property') })
export const ratePlanListParams = z.object({
	includeInactive: z.coerce.boolean().optional().default(false),
	roomTypeId: idSchema('roomType').optional(),
})

export type RatePlan = {
	id: string
	tenantId: string
	propertyId: string
	roomTypeId: string
	name: string
	code: string
	isDefault: boolean
	isRefundable: boolean
	cancellationHours: number | null
	mealsIncluded: MealsIncluded
	minStay: number
	maxStay: number | null
	currency: string
	isActive: boolean
	createdAt: string
	updatedAt: string
}
