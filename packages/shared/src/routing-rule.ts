import { z } from 'zod'
import { folioKindSchema } from './folio.ts'
import { idSchema } from './schemas.ts'

/**
 * Folio routing rule — declarative folio-routing per Apaleo + Mews canon.
 *
 * Per canonical decisions (memory `project_payment_domain_canonical.md`
 * "Folio routing"):
 *
 *   candidates = rules
 *     .filter(enabled = TRUE)
 *     .filter(matchScope ∈ {'property', 'company'} AND matches(booking))
 *     .filter(matchChargeCategoriesJson includes charge.category)
 *     .filter(validFrom <= today AND (validTo IS NULL OR today <= validTo))
 *     .sortBy(priority asc)  // lower number = higher precedence
 *   target = candidates[0]?.targetFolioKind ?? 'guest' (safe default)
 *
 * Snapshot-on-post: when a folioLine is posted, we write `routingRuleId` +
 * resolved `targetFolioId` ON the folioLine row (migration 0007). Editing
 * a rule LATER does NOT retroactively re-route past charges (Apaleo
 * snapshot principle + 54-ФЗ ledger immutability).
 *
 * NO CHANGEFEED — config table, not event source.
 */

/* --------------------------------------------------------------- enums */

const matchScopeValues = ['property', 'company', 'ratePlan'] as const
export const routingRuleMatchScopeSchema = z.enum(matchScopeValues)
export type RoutingRuleMatchScope = z.infer<typeof routingRuleMatchScopeSchema>

/**
 * folioLine charge categories — closed enum aligned with `folioLine.category`
 * in migration 0007 (canon).
 */
const folioLineCategoryValues = [
	'accommodation',
	'tourismTax',
	'fnb',
	'minibar',
	'spa',
	'parking',
	'laundry',
	'phone',
	'misc',
	'cancellationFee',
	'noShowFee',
] as const
export const folioLineCategorySchema = z.enum(folioLineCategoryValues)
export type FolioLineCategory = z.infer<typeof folioLineCategorySchema>

/* --------------------------------------------------------------- domain rows */

/** Routing rule row shape (read model). */
export type RoutingRule = {
	tenantId: string
	propertyId: string
	priority: number
	id: string
	name: string
	matchScope: RoutingRuleMatchScope
	matchCompanyId: string | null
	matchRatePlanId: string | null
	matchChannelCode: string | null
	matchChargeCategoriesJson: FolioLineCategory[]
	targetFolioKind: string
	targetCompanyId: string | null
	validFrom: string
	validTo: string | null
	amountLimitMinor: string | null
	enabled: boolean
	version: number
	createdAt: string
	updatedAt: string
	createdBy: string
	updatedBy: string
}

/* ----------------------------------------------------------------- API inputs */

const priorityRange = z
	.number()
	.int()
	.min(0, 'priority must be >= 0')
	.max(1000, 'priority must be <= 1000')

const amountLimitSchema = z.coerce
	.bigint()
	.refine((n) => n > 0n, 'amountLimitMinor must be > 0 if set')
	.refine((n) => n <= 9_223_372_036_854_775_807n, 'Overflow: must fit Int64')

/** POST /properties/:id/routing-rules — create a new rule. */
export const routingRuleCreateInput = z
	.object({
		name: z.string().min(1).max(120),
		priority: priorityRange,
		matchScope: routingRuleMatchScopeSchema,
		matchCompanyId: z.string().min(1).nullable().optional(),
		matchRatePlanId: idSchema('ratePlan').nullable().optional(),
		matchChannelCode: z.string().min(1).max(50).nullable().optional(),
		matchChargeCategories: z.array(folioLineCategorySchema).min(1),
		targetFolioKind: folioKindSchema,
		targetCompanyId: z.string().min(1).nullable().optional(),
		validFrom: z.iso.date(),
		validTo: z.iso.date().nullable().optional(),
		amountLimitMinor: amountLimitSchema.nullable().optional(),
		enabled: z.boolean().default(true),
	})
	.refine(
		(rule) =>
			rule.matchScope !== 'company' ||
			(rule.matchCompanyId !== null && rule.matchCompanyId !== undefined),
		{
			message: "matchCompanyId is required when matchScope = 'company'",
			path: ['matchCompanyId'],
		},
	)
	.refine(
		(rule) =>
			rule.matchScope !== 'ratePlan' ||
			(rule.matchRatePlanId !== null && rule.matchRatePlanId !== undefined),
		{
			message: "matchRatePlanId is required when matchScope = 'ratePlan'",
			path: ['matchRatePlanId'],
		},
	)
	.refine(
		(rule) =>
			rule.targetFolioKind !== 'company' ||
			(rule.targetCompanyId !== null && rule.targetCompanyId !== undefined),
		{
			message: "targetCompanyId is required when targetFolioKind = 'company'",
			path: ['targetCompanyId'],
		},
	)
	.refine(
		(rule) => rule.validTo === null || rule.validTo === undefined || rule.validTo >= rule.validFrom,
		{
			message: 'validTo must be on or after validFrom',
			path: ['validTo'],
		},
	)
export type RoutingRuleCreateInput = z.infer<typeof routingRuleCreateInput>

/** PATCH /routing-rules/:id — partial update. Same refinements re-applied. */
export const routingRuleUpdateInput = z.object({
	name: z.string().min(1).max(120).optional(),
	priority: priorityRange.optional(),
	matchChargeCategories: z.array(folioLineCategorySchema).min(1).optional(),
	enabled: z.boolean().optional(),
	validTo: z.iso.date().nullable().optional(),
	amountLimitMinor: amountLimitSchema.nullable().optional(),
})
export type RoutingRuleUpdateInput = z.infer<typeof routingRuleUpdateInput>

export const routingRuleIdParam = z.object({ id: idSchema('routingRule') })

export const routingRuleListParams = z.object({
	propertyId: idSchema('property').optional(),
	enabled: z.coerce.boolean().optional(),
})
export type RoutingRuleListParams = z.infer<typeof routingRuleListParams>

/** Resolution input — what gets passed to the routing resolver at post time. */
export type RoutingResolveContext = {
	tenantId: string
	propertyId: string
	bookingCompanyId: string | null
	bookingRatePlanId: string | null
	bookingChannelCode: string | null
	chargeCategory: FolioLineCategory
	chargeAmountMinor: bigint
	postedAt: string
}

/** Default folio kind when no rule matches (canon: "guest"). */
export const ROUTING_DEFAULT_FOLIO_KIND = 'guest' as const
