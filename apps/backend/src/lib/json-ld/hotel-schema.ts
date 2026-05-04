/**
 * Schema.org Hotel JSON-LD renderer — M9.widget.8 / A6.1 / D1-D8.
 *
 * Per `plans/m9_widget_8_canonical.md` §2:
 *   - D1: @type='Hotel' (NOT LodgingBusiness/Resort/BedAndBreakfast — 41% misuse loses rich-results)
 *   - D2: RU compliance — addressCountry='RU' ISO-2, postalCode 6-digit string, telephone E.164
 *   - D3: ONE Hotel + `containsPlace: [HotelRoom]` array (NOT N sibling Hotel blocks → entity dilution)
 *   - D4: Flat nested object (NOT @graph for single-topic widget)
 *   - D5: OMIT aggregateRating until 3rd-party Yandex.Карты feed wired (M11+) — self-sourced triggers Google suppression
 *   - D6: priceRange symbolic string, NOT inline Offer[] array
 *   - D7: **CRITICAL XSS ESCAPE** — post-stringify replace `<` / `>` / `&` / U+2028 / U+2029
 *         (canonical defense vs `</script>` injection)
 *   - D8: `<script type="application/ld+json">` bypasses CSP `script-src` (data block per HTML spec) — no nonce needed
 */

import type { RoomTypeForJsonLd } from './hotel-schema-types.ts'

export interface HotelSchemaInput {
	readonly tenantSlug: string
	readonly name: string
	readonly description: string
	readonly address: {
		readonly streetAddress: string
		readonly addressLocality: string
		readonly addressRegion: string
		readonly postalCode: string
		readonly addressCountry: string
	}
	readonly geo: {
		readonly latitude: number
		readonly longitude: number
	}
	readonly telephone: string
	readonly starRating: 1 | 2 | 3 | 4 | 5
	readonly priceRange: string
	readonly numberOfRooms: number
	readonly images: ReadonlyArray<string>
	readonly checkinTime: string
	readonly checkoutTime: string
	readonly roomTypes: ReadonlyArray<RoomTypeForJsonLd>
	readonly canonicalUrl?: string
}

/**
 * Escape JSON-LD payload for safe HTML embedding (D7 CRITICAL).
 *
 * Tenant-controlled fields flow through `JSON.stringify()` into a `<script>`
 * tag. `JSON.stringify("</script>")` produces literal `</script>` which the
 * HTML parser closes the script tag on. Defense: post-stringify escape `<`,
 * `>`, `&`, U+2028, U+2029.
 *
 * **Implementation note:** U+2028/U+2029 regex literals написаны через
 * `RegExp(String.fromCharCode(...))` constructor — typing the literal codepoints
 * directly inside `/.../ g` regex literals trips biome formatter (interprets
 * line separators as statement terminators) AND oxc parser ("unterminated
 * regex"). Constructor pattern bypasses both.
 */
function escapeForHtmlScript(json: string): string {
	const u2028 = new RegExp(String.fromCharCode(0x2028), 'g')
	const u2029 = new RegExp(String.fromCharCode(0x2029), 'g')
	return json
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(u2028, '\\u2028')
		.replace(u2029, '\\u2029')
}

/**
 * Build the inner JSON-LD object (without `<script>` wrapper).
 * Exported for tests + use cases that need the JSON directly (e.g. SPA route head).
 */
export function buildHotelJsonLd(input: HotelSchemaInput): Record<string, unknown> {
	const url =
		input.canonicalUrl ?? `https://${input.tenantSlug}.sochi.app/widget/${input.tenantSlug}`
	const obj: Record<string, unknown> = {
		'@context': 'https://schema.org',
		'@type': 'Hotel',
		'@id': `${url}#hotel`,
		name: input.name,
		url,
		description: input.description,
		telephone: input.telephone,
		priceRange: input.priceRange,
		starRating: { '@type': 'Rating', ratingValue: String(input.starRating) },
		numberOfRooms: input.numberOfRooms,
		checkinTime: input.checkinTime,
		checkoutTime: input.checkoutTime,
		address: {
			'@type': 'PostalAddress',
			streetAddress: input.address.streetAddress,
			addressLocality: input.address.addressLocality,
			addressRegion: input.address.addressRegion,
			postalCode: input.address.postalCode,
			addressCountry: input.address.addressCountry,
		},
		geo: {
			'@type': 'GeoCoordinates',
			latitude: input.geo.latitude,
			longitude: input.geo.longitude,
		},
		availableLanguage: [
			{ '@type': 'Language', name: 'Russian', alternateName: 'ru' },
			{ '@type': 'Language', name: 'English', alternateName: 'en' },
		],
		potentialAction: {
			'@type': 'ReserveAction',
			target: {
				'@type': 'EntryPoint',
				urlTemplate: url,
				actionPlatform: [
					'http://schema.org/DesktopWebPlatform',
					'http://schema.org/MobileWebPlatform',
				],
			},
			result: { '@type': 'LodgingReservation', name: 'Бронирование номера' },
		},
	}
	if (input.images.length > 0) obj['image'] = [...input.images]
	if (input.roomTypes.length > 0) {
		obj['containsPlace'] = input.roomTypes.map((rt) => {
			const room: Record<string, unknown> = {
				'@type': 'HotelRoom',
				name: rt.name,
				description: rt.description,
				occupancy: {
					'@type': 'QuantitativeValue',
					maxValue: rt.maxOccupancy,
					unitCode: 'C62',
				},
			}
			if (rt.areaSqm !== undefined) {
				room['floorSize'] = {
					'@type': 'QuantitativeValue',
					value: rt.areaSqm,
					unitCode: 'MTK',
				}
			}
			if (rt.baseBeds + rt.extraBeds > 0) {
				room['bed'] = { '@type': 'BedDetails', numberOfBeds: rt.baseBeds + rt.extraBeds }
			}
			return room
		})
	}
	return obj
}

/**
 * Render complete `<script type="application/ld+json">...</script>` block.
 * Output ready to interpolate в HTML template.
 */
export function renderHotelJsonLdScript(input: HotelSchemaInput): string {
	const obj = buildHotelJsonLd(input)
	const json = JSON.stringify(obj)
	const escaped = escapeForHtmlScript(json)
	return `<script type="application/ld+json">${escaped}</script>`
}
