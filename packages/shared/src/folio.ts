import { z } from 'zod'
import { idSchema } from './schemas.ts'

/**
 * Folio domain — accounting container per booking.
 *
 * Per the canonical decisions in memory `project_payment_domain_canonical.md`:
 *   - Apaleo / Mews / Opera Cloud "folio is a first-class entity, NOT nested
 *     inside booking" pattern. One booking has 1+ folios; V1 ships single
 *     guest folio per booking.
 *   - 5-state Folio SM: open → closed → settled (terminal). The reverse
 *     transition closed→open is the SOLE non-monotonic edge in the entire
 *     payment domain — guarded by RBAC `folio.reopen` + within 24h of close
 *     + emits an audit row.
 *   - FolioLine sub-state: draft → posted → void.
 *   - Money = Int64 минор копейки (NOT amountMicros). Booking domain uses
 *     micros because of the YDB Decimal workaround; payments domain uses
 *     копейки because every Russian provider API works in копейки natively.
 *     Conversion at post boundary: `amountMinor = round(totalMicros / 10000)`.
 *   - `isAccommodationBase` flags lines that participate in the tourism-tax
 *     base per НК РФ ch.33.1 (Сочи 2026 = 2%, room-only revenue).
 *   - `routingRuleId` snapshot at post — editing the rule does NOT retroactively
 *     re-route past lines (54-ФЗ + Apaleo snapshot principle).
 */

/** 3-state folio SM. `settled` is terminal. closed→open allowed only via supervisor RBAC. */
const folioStatusValues = ['open', 'closed', 'settled'] as const
export const folioStatusSchema = z.enum(folioStatusValues)
export type FolioStatus = z.infer<typeof folioStatusSchema>

/**
 * Folio kind — who is the bill-to of this folio.
 *
 *   - guest          — primary guest folio (V1 default; always created on booking)
 *   - company        — corporate billing (юр.лицо pays via invoice + акт + с/ф)
 *   - group_master   — shared expenses for group bookings (banquet, hall rental)
 *   - ota_receivable — OTA prepaid amount (cleared when OTA settles to hotel)
 *   - ota_payable    — hotel's commission liability to OTA (Yandex.Travel 17% etc.)
 *   - transitory     — third-party pass-through (tips, deposits to be returned)
 *
 * V1 demo uses only `guest`. Other kinds are reserved for Phase 3 integrations.
 */
const folioKindValues = [
	'guest',
	'company',
	'group_master',
	'ota_receivable',
	'ota_payable',
	'transitory',
] as const
export const folioKindSchema = z.enum(folioKindValues)
export type FolioKind = z.infer<typeof folioKindSchema>

/** FolioLine sub-state. `void` is reversal-of-posted; cross-day uses compensating posting. */
const folioLineStatusValues = ['draft', 'posted', 'void'] as const
export const folioLineStatusSchema = z.enum(folioLineStatusValues)
export type FolioLineStatus = z.infer<typeof folioLineStatusSchema>

/**
 * Charge category — closed enum so reporting + routing rules can reason about it.
 * `accommodation` + `tourismTax` are the only ones with `isAccommodationBase` set
 * to anything meaningful (true for accommodation, false for tourismTax — tax
 * does NOT recurse into its own base).
 */
const chargeCategoryValues = [
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
export const chargeCategorySchema = z.enum(chargeCategoryValues)
export type ChargeCategory = z.infer<typeof chargeCategorySchema>

const currencySchema = z
	.string()
	.length(3)
	.regex(/^[A-Z]{3}$/, 'Expected ISO 4217 currency code')

/**
 * Money in минор копейки (Int64 на стороне БД). Negative values allowed at the
 * line level (reversals/discounts); folio.balanceMinor can be negative too
 * (overpayment / credit balance to refund).
 *
 * Coerced from string|number|bigint for ergonomic JSON in/out. Server side
 * always handles as BigInt. Range cap = Int64.MAX (9.2e18 копейки = 9.2e16 RUB,
 * which is more than the Russian GDP — comfortable forever).
 */
const bigIntMinorSchema = z.coerce
	.bigint()
	.refine(
		(n) => n >= -9_223_372_036_854_775_808n && n <= 9_223_372_036_854_775_807n,
		'Overflow: must fit Int64',
	)

/**
 * НДС rate in basis points. 0 = НДС 0% (hotel accommodation, продлено до 31.12.2030).
 * 2000 = 20% (legacy), 2200 = 22% (post-01.01.2026 base for non-exempt services).
 * V1 demo: accommodation lines use 0; F&B / spa / etc. use 2200.
 */
const taxRateBpsSchema = z.coerce
	.number()
	.int()
	.min(0, 'Tax rate cannot be negative')
	.max(10_000, 'Tax rate cannot exceed 100% (10000 bps)')

/* ---------------------------------------------------------------- domain rows */

/** Folio row shape (read model). Money fields are bigint string for JSON. */
export type Folio = {
	tenantId: string
	propertyId: string
	bookingId: string
	id: string
	kind: FolioKind
	status: FolioStatus
	currency: string
	/** Int64 копейки serialized as decimal string. */
	balanceMinor: string
	version: number
	closedAt: string | null
	settledAt: string | null
	closedBy: string | null
	companyId: string | null
	createdAt: string
	updatedAt: string
	createdBy: string
	updatedBy: string
}

/** FolioLine row shape (read model). */
export type FolioLine = {
	tenantId: string
	folioId: string
	id: string
	category: ChargeCategory
	description: string
	/** Int64 копейки serialized as decimal string. Can be negative (reversals). */
	amountMinor: string
	isAccommodationBase: boolean
	taxRateBps: number
	lineStatus: FolioLineStatus
	routingRuleId: string | null
	postedAt: string | null
	voidedAt: string | null
	voidReason: string | null
	version: number
	createdAt: string
	updatedAt: string
	createdBy: string
	updatedBy: string
}

/* ----------------------------------------------------------------- API inputs */

/** POST /properties/:propertyId/bookings/:bookingId/folios — open a new folio. */
export const folioCreateInput = z.object({
	kind: folioKindSchema,
	currency: currencySchema.default('RUB'),
	companyId: idSchema('organization').nullable().optional(),
})
export type FolioCreateInput = z.infer<typeof folioCreateInput>

/** PATCH /folios/:id/close — close a folio (no further postings allowed). */
export const folioCloseInput = z.object({
	reason: z.string().max(500).nullable().optional(),
})
export type FolioCloseInput = z.infer<typeof folioCloseInput>

/** PATCH /folios/:id/reopen — supervisor-only, within 24h of close. */
export const folioReopenInput = z.object({
	reason: z.string().min(1).max(500),
})
export type FolioReopenInput = z.infer<typeof folioReopenInput>

/** POST /folios/:id/lines — post a charge to the folio. */
export const folioLinePostInput = z.object({
	category: chargeCategorySchema,
	description: z.string().min(1).max(500),
	amountMinor: bigIntMinorSchema,
	isAccommodationBase: z.boolean(),
	taxRateBps: taxRateBpsSchema,
	/** Optional snapshot of a routing rule that decided this line's folio. */
	routingRuleId: idSchema('routingRule').nullable().optional(),
})
export type FolioLinePostInput = z.infer<typeof folioLinePostInput>

/** PATCH /folios/:folioId/lines/:lineId/void — void a posted line (same-day only). */
export const folioLineVoidInput = z.object({
	reason: z.string().min(1).max(500),
})
export type FolioLineVoidInput = z.infer<typeof folioLineVoidInput>

/* ------------------------------------------------------------------ id params */

export const folioIdParam = z.object({ id: idSchema('folio') })
export const folioLineIdParam = z.object({
	folioId: idSchema('folio'),
	lineId: idSchema('folioLine'),
})
export const folioBookingParam = z.object({
	propertyId: idSchema('property'),
	bookingId: idSchema('booking'),
})

/** GET /properties/:propertyId/folios/receivables — receivables dashboard. */
export const folioPropertyParam = z.object({
	propertyId: idSchema('property'),
})

/* --------------------------------------------------------------- list filters */

export const folioListParams = z.object({
	bookingId: idSchema('booking').optional(),
	kind: folioKindSchema.optional(),
	status: folioStatusSchema.optional(),
})
export type FolioListParams = z.infer<typeof folioListParams>
