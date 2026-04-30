/**
 * Public booking widget — wire-format contract shared между backend route
 * (`apps/backend/src/domains/widget/booking-create.routes.ts`) и frontend
 * client (`apps/frontend/src/features/public-widget/lib/widget-booking-api.ts`).
 *
 * Per `plans/m9_widget_4_canonical.md` §M9.widget.4 + canonical guard
 * `feedback_behaviour_faithful_mock_canon.md`: same shape works для Stub demo
 * provider AND live ЮKassa. Live-flip = backend factory binding swap, ZERO
 * client changes.
 *
 * Server-side fields (`tenantId`, `ipAddress`, `userAgent`, `idempotencyKey`)
 * НЕ part of wire input — backend route extracts из middleware-resolved
 * context (slug→tenant, headers). Domain service input is broader; this is
 * the public-network contract only.
 */

import { z } from 'zod'
import { paymentStatusSchema } from './payment.ts'

/** ISO 8601 date string YYYY-MM-DD. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Restricted к canonical PaymentMethod enum subset for public widget. Live
 * ЮKassa supports more methods (yoo_money, mir_pay, sber_pay, t_pay) — Track
 * C2 will extend this enum after empirical verification of provider contract.
 */
export const widgetPaymentMethodSchema = z.enum(['card', 'sbp'])
export type WidgetPaymentMethod = z.infer<typeof widgetPaymentMethodSchema>

/** Selected addon cart entry from Screen 2. */
export const widgetAddonSelectionSchema = z.object({
	addonId: z.string().min(1).max(128),
	quantity: z.number().int().min(1).max(50),
})
export type WidgetAddonSelection = z.infer<typeof widgetAddonSelectionSchema>

/** Guest contact info collected on Screen 3 form. */
export const widgetGuestInputSchema = z.object({
	firstName: z.string().min(1).max(100),
	lastName: z.string().min(1).max(100),
	middleName: z.string().max(100).nullable().optional(),
	email: z.string().email().max(254),
	/** E.164 or RU 11-digit (+7 followed by 10 digits). Backend re-validates. */
	phone: z.string().min(5).max(30),
	/** ISO-3166 alpha-2 uppercase. */
	citizenship: z
		.string()
		.length(2)
		.regex(/^[A-Z]{2}$/, 'ISO-3166 alpha-2, uppercase'),
	countryOfResidence: z.string().max(100).nullable().optional(),
	specialRequests: z.string().max(2000).nullable().optional(),
})
export type WidgetGuestInput = z.infer<typeof widgetGuestInputSchema>

/** Consent flags from Screen 3 consent block. */
export const widgetConsentFlagsSchema = z.object({
	acceptedDpa: z.boolean(),
	acceptedMarketing: z.boolean(),
})
export type WidgetConsentFlags = z.infer<typeof widgetConsentFlagsSchema>

/**
 * Static consent text + version captured at booking commit time. Stored
 * verbatim в `consentLog` table per 152-ФЗ ст. 22.1 traceability.
 */
export const widgetConsentSnapshotSchema = z.object({
	dpaText: z.string().min(1).max(10_000),
	marketingText: z.string().min(1).max(10_000),
	version: z
		.string()
		.min(1)
		.max(20)
		.regex(/^v\d+\.\d+$/, 'Format: v<major>.<minor> (e.g. v1.0)'),
})
export type WidgetConsentSnapshot = z.infer<typeof widgetConsentSnapshotSchema>

/**
 * Public widget booking commit — wire input.
 *
 * POST `/api/public/widget/{tenantSlug}/booking` body schema. Used by both:
 *   - `@hono/zod-validator` on route handler
 *   - Frontend type-check perfect mirror через `z.infer<>`
 */
export const widgetBookingCommitWireInputSchema = z.object({
	propertyId: z.string().min(1).max(128),
	checkIn: z.string().regex(ISO_DATE, 'checkIn must be YYYY-MM-DD'),
	checkOut: z.string().regex(ISO_DATE, 'checkOut must be YYYY-MM-DD'),
	adults: z.number().int().min(1).max(10),
	children: z.number().int().min(0).max(6),
	roomTypeId: z.string().min(1).max(128),
	ratePlanId: z.string().min(1).max(128),
	expectedTotalKopecks: z.number().int().min(0),
	addons: z.array(widgetAddonSelectionSchema).default([]),
	guest: widgetGuestInputSchema,
	consents: widgetConsentFlagsSchema,
	consentSnapshot: widgetConsentSnapshotSchema,
	paymentMethod: widgetPaymentMethodSchema,
})
export type WidgetBookingCommitWireInput = z.infer<typeof widgetBookingCommitWireInputSchema>

/** Successful commit response. */
export const widgetBookingCommitResultSchema = z.object({
	bookingId: z.string(),
	guestId: z.string(),
	paymentId: z.string(),
	paymentStatus: paymentStatusSchema,
	/** Provider-issued confirmation token (Stub: null/pseudo; Live: real ЮKassa). */
	confirmationToken: z.string().nullable(),
	totalKopecks: z.number().int().min(0),
})
export type WidgetBookingCommitResult = z.infer<typeof widgetBookingCommitResultSchema>

/** Error reason taxonomy — frontend maps to user-facing copy. */
export const widgetBookingCommitErrorReasonValues = [
	'validation', // 400/422 schema or field-level
	'consent_missing', // 422 152-ФЗ DPA not accepted
	'stale_availability', // 409 price/inventory changed since quote
	'not_found', // 404 tenant/property/room/rate gone
	'rate_limited', // 429 too many requests
	'server', // 5xx
	'network', // fetch threw before reaching server
] as const
export type WidgetBookingCommitErrorReason = (typeof widgetBookingCommitErrorReasonValues)[number]
