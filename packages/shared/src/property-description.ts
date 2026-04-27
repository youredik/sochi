/**
 * Property descriptions — i18n marketing/SEO content per property.
 *
 * Per plan v2 §7.1 #3 + research/hotel-content-amenities-media.md §6.
 *
 * Schema:
 *   - **One row per (tenantId, propertyId, locale)**. Locale enum: ru | en
 *     for now (РФ-mandatory + Sochi inbound: Iran/Turkey/India/China).
 *     Extend later when channels demand more locales.
 *   - **Markdown for body**; plain text for short SEO/SERP fields.
 *   - **Sections** (8 canonical) live in a JSON column rather than 8
 *     nullable text columns. The JSON object is validated against
 *     `propertyDescriptionSectionsSchema` at the service boundary.
 *   - **Schema.org JSON-LD** generated at request-time by
 *     `buildHotelJsonLd` — pure function over property + description +
 *     amenities + media (caller passes already-loaded data).
 */

import { z } from 'zod'

/**
 * Supported locales. Hard-enumerated rather than free-form ISO-639 — every
 * new locale needs translator review + axe-core accessibility check, so
 * we gate at the schema. Storage is per-row.
 */
export const propertyDescriptionLocaleValues = ['ru', 'en'] as const
export const propertyDescriptionLocaleSchema = z.enum(propertyDescriptionLocaleValues)
export type PropertyDescriptionLocale = z.infer<typeof propertyDescriptionLocaleSchema>

/**
 * Canonical section keys (research §6 + amenityFeature alignment).
 * Each section is Markdown text (multi-paragraph allowed).
 */
export const propertyDescriptionSectionKeys = [
	'location',
	'services',
	'rooms',
	'dining',
	'activities',
	'family',
	'accessibility',
	'pets',
] as const
export type PropertyDescriptionSectionKey = (typeof propertyDescriptionSectionKeys)[number]

/**
 * Sections payload — every key optional. Empty object valid (operator may
 * publish only summary + sections come later).
 */
export const propertyDescriptionSectionsSchema = z
	.object({
		location: z.string().min(1).max(8000).optional(),
		services: z.string().min(1).max(8000).optional(),
		rooms: z.string().min(1).max(8000).optional(),
		dining: z.string().min(1).max(8000).optional(),
		activities: z.string().min(1).max(8000).optional(),
		family: z.string().min(1).max(8000).optional(),
		accessibility: z.string().min(1).max(8000).optional(),
		pets: z.string().min(1).max(8000).optional(),
	})
	.strict()
export type PropertyDescriptionSections = z.infer<typeof propertyDescriptionSectionsSchema>

/**
 * Full row shape. `title` is the locale-specific display name (may differ
 * from `organization.name` which is operator-internal). `summaryMd` is the
 * widget hero subtitle / OTA short description.
 *
 * Limits derived from SEO best practice 2026:
 *   - `seoMetaTitle ≤ 70 chars` — Google SERP truncation point
 *   - `seoMetaDescription ≤ 160 chars` — SERP description display
 *   - `tagline ≤ 100 chars` — widget hero hook
 *   - `summaryMd ≤ 800 chars` — short paragraph above gallery
 *   - `longDescriptionMd ≤ 16k chars` — full body Markdown
 */
export const propertyDescriptionSchema = z.object({
	tenantId: z.string(),
	propertyId: z.string(),
	locale: propertyDescriptionLocaleSchema,
	title: z.string().min(1).max(200),
	tagline: z.string().min(1).max(100).nullable(),
	summaryMd: z.string().min(1).max(800),
	longDescriptionMd: z.string().min(1).max(16_000).nullable(),
	sections: propertyDescriptionSectionsSchema,
	seoMetaTitle: z.string().min(1).max(70).nullable(),
	seoMetaDescription: z.string().min(1).max(160).nullable(),
	seoH1: z.string().min(1).max(200).nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
})
export type PropertyDescription = z.infer<typeof propertyDescriptionSchema>

/**
 * Input shape for upsert. Excludes immutable/audit fields. `sections`
 * defaults to empty object so operator can submit a minimal payload.
 */
export const propertyDescriptionInputSchema = z.object({
	title: z.string().min(1).max(200),
	tagline: z.string().min(1).max(100).nullable(),
	summaryMd: z.string().min(1).max(800),
	longDescriptionMd: z.string().min(1).max(16_000).nullable(),
	sections: propertyDescriptionSectionsSchema.default({}),
	seoMetaTitle: z.string().min(1).max(70).nullable(),
	seoMetaDescription: z.string().min(1).max(160).nullable(),
	seoH1: z.string().min(1).max(200).nullable(),
})
export type PropertyDescriptionInput = z.infer<typeof propertyDescriptionInputSchema>

// ----------------------------------------------------------------------------
// Schema.org JSON-LD builder
// ----------------------------------------------------------------------------

/**
 * Subset of Property fields the JSON-LD builder needs. Decoupled from
 * domain Property type so tests don't need full DB rows; production code
 * calls `buildHotelJsonLd(propertyToJsonLdInput(property, ...))`.
 */
export interface JsonLdHotelInput {
	readonly propertyName: string
	readonly description: string
	readonly imageUrls: readonly string[]
	readonly address: {
		readonly streetAddress: string
		readonly addressLocality: string
		readonly addressRegion: string
		readonly postalCode?: string
		readonly addressCountry: string
	}
	readonly geo?: {
		readonly latitude: number
		readonly longitude: number
	}
	readonly starRating?: 1 | 2 | 3 | 4 | 5
	/** ISO 8601 time-only, e.g. '15:00:00' or 'PT15H'. Spec accepts both. */
	readonly checkinTime?: string
	readonly checkoutTime?: string
	readonly telephone?: string
	readonly email?: string
	readonly sameAs?: readonly string[]
	/**
	 * Each amenity becomes a `LocationFeatureSpecification`. Pass the human
	 * label for the locale being rendered (RU label for ru-locale page).
	 */
	readonly amenities?: ReadonlyArray<{ readonly name: string; readonly value: boolean | string }>
}

/**
 * Build a Schema.org `Hotel` JSON-LD object. AI assistants (Claude, ChatGPT,
 * Yandex Алиса via OpenSearch) read this for property visibility 2026.
 *
 * Returns a plain JS object — caller serializes via `JSON.stringify` and
 * embeds in `<script type="application/ld+json">…</script>`.
 *
 * Pure function — fully covered by `property-description.test.ts`.
 */
export function buildHotelJsonLd(input: JsonLdHotelInput): Record<string, unknown> {
	const ld: Record<string, unknown> = {
		'@context': 'https://schema.org',
		'@type': 'Hotel',
		name: input.propertyName,
		description: input.description,
	}
	if (input.imageUrls.length > 0) {
		ld.image = [...input.imageUrls]
	}
	const address: Record<string, unknown> = {
		'@type': 'PostalAddress',
		streetAddress: input.address.streetAddress,
		addressLocality: input.address.addressLocality,
		addressRegion: input.address.addressRegion,
		addressCountry: input.address.addressCountry,
	}
	if (input.address.postalCode !== undefined) {
		address.postalCode = input.address.postalCode
	}
	ld.address = address
	if (input.geo) {
		ld.geo = {
			'@type': 'GeoCoordinates',
			latitude: input.geo.latitude,
			longitude: input.geo.longitude,
		}
	}
	if (input.starRating !== undefined) {
		ld.starRating = {
			'@type': 'Rating',
			ratingValue: String(input.starRating),
		}
	}
	if (input.checkinTime !== undefined) {
		ld.checkinTime = input.checkinTime
	}
	if (input.checkoutTime !== undefined) {
		ld.checkoutTime = input.checkoutTime
	}
	if (input.telephone !== undefined) {
		ld.telephone = input.telephone
	}
	if (input.email !== undefined) {
		ld.email = input.email
	}
	if (input.sameAs && input.sameAs.length > 0) {
		ld.sameAs = [...input.sameAs]
	}
	if (input.amenities && input.amenities.length > 0) {
		ld.amenityFeature = input.amenities.map((a) => ({
			'@type': 'LocationFeatureSpecification',
			name: a.name,
			value: a.value,
		}))
	}
	return ld
}

// ----------------------------------------------------------------------------
// Render helpers
// ----------------------------------------------------------------------------

/**
 * Pick the best available locale from a candidate list, falling back to a
 * default. Used by widget when the user's preferred locale doesn't have a
 * description published yet.
 *
 * @returns the chosen locale, or null if none are present
 */
export function pickLocale(
	available: readonly PropertyDescriptionLocale[],
	preferred: PropertyDescriptionLocale,
	fallback: PropertyDescriptionLocale = 'ru',
): PropertyDescriptionLocale | null {
	if (available.includes(preferred)) return preferred
	if (available.includes(fallback)) return fallback
	return available[0] ?? null
}

/**
 * Cross-field invariant: whenever `sections.accessibility` is empty AND
 * the property has accessibility amenities (AMN_ACCESSIBLE_ROOMS,
 * AMN_ELEVATOR, AMN_WHEELCHAIR_RAMP), warn the operator. Returns null
 * when the description is consistent with amenities, or a warning string.
 *
 * Advisory only — does NOT block save (operator may want a separate
 * accessibility statement page).
 */
export function checkAccessibilityCoverage(input: {
	readonly sections: PropertyDescriptionSections
	readonly amenityCodes: readonly string[]
}): string | null {
	const accessibilityCodes = ['AMN_ACCESSIBLE_ROOMS', 'AMN_ELEVATOR', 'AMN_WHEELCHAIR_RAMP']
	const hasAccessibilityAmenity = accessibilityCodes.some((c) => input.amenityCodes.includes(c))
	const hasAccessibilitySection =
		typeof input.sections.accessibility === 'string' &&
		input.sections.accessibility.trim().length > 0
	if (hasAccessibilityAmenity && !hasAccessibilitySection) {
		return 'Property declares accessibility amenities but description has no accessibility section'
	}
	return null
}
