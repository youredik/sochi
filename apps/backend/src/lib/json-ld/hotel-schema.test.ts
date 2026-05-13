/**
 * Schema.org Hotel JSON-LD — strict tests JL1-JL8 (M9.widget.8 / A6.1).
 *
 * Per plan §5: «8 JL tests (structure / RU specifics / containsPlace / XSS adversarial /
 * encoding / valid JSON)».
 *
 * **Strict-test canon (R2 #6 critical):** XSS adversarial payloads MUST round-trip
 * through `</script>`/`<!--`/`U+2028 ` so that the rendered <script> tag stays
 * uncorrupted. Bug regression here is a real RCE class.
 *
 * Adversarial inputs:
 *   - `</script>` literal in tenant name (closes script tag)
 *   - `<!--` HTML comment (parser confusion)
 *   - U+2028 line separator (breaks JS parser pre-ES2019; some HTML parsers misroute)
 *   - `&lt;` already-escaped (must not double-escape)
 *   - Cyrillic + emoji (encoding round-trip)
 */

import { describe, expect, it } from 'bun:test'
import { buildHotelJsonLd, renderHotelJsonLdScript } from './hotel-schema.ts'
import type { RoomTypeForJsonLd } from './hotel-schema-types.ts'

const SIRIUS_BASE = {
	tenantSlug: 'demo-sirius',
	name: 'Гостиница Сириус',
	description:
		'Семейная гостиница на 24 номера в федеральной территории Сириус, Сочи. Море, набережная, Олимпийский парк — в шаговой доступности.',
	address: {
		streetAddress: 'Олимпийский проспект, 1',
		addressLocality: 'Сочи',
		addressRegion: 'Краснодарский край',
		postalCode: '354340',
		addressCountry: 'RU',
	},
	geo: { latitude: 43.4178, longitude: 39.9493 },
	telephone: '+78622000000',
	starRating: 4 as const,
	priceRange: '5000–15000 ₽',
	numberOfRooms: 24,
	images: [
		'https://picsum.photos/seed/sirius-1/1200/800',
		'https://picsum.photos/seed/sirius-2/1200/800',
		'https://picsum.photos/seed/sirius-3/1200/800',
	],
	checkinTime: '14:00',
	checkoutTime: '12:00',
	roomTypes: [
		{
			name: 'Deluxe Sea View',
			description: '25 м², 2 гостя, балкон с видом на море',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			areaSqm: 25,
		},
		{
			name: 'Standard Mountain View',
			description: '18 м², 2 гостя, вид на горы',
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 1,
			areaSqm: 18,
		},
	] satisfies ReadonlyArray<RoomTypeForJsonLd>,
} as const

describe('buildHotelJsonLd — structure (D1-D8)', () => {
	it('[JL1] @type is exactly "Hotel" (NOT LodgingBusiness/Resort) — D1', () => {
		const obj = buildHotelJsonLd(SIRIUS_BASE)
		expect(obj['@context']).toBe('https://schema.org')
		expect(obj['@type']).toBe('Hotel')
	})

	it('[JL2] RU compliance — addressCountry "RU" ISO-2 + 6-digit postal (D2)', () => {
		const obj = buildHotelJsonLd(SIRIUS_BASE)
		const addr = obj.address as Record<string, unknown>
		expect(addr['@type']).toBe('PostalAddress')
		expect(addr.addressCountry).toBe('RU') // ISO-2, NOT "Russia"/"Россия"
		expect(addr.postalCode).toBe('354340') // 6-digit string
		expect(typeof addr.postalCode).toBe('string') // never integer (loses leading zeros для других regions)
		expect(addr.addressLocality).toBe('Сочи')
	})

	it('[JL3] containsPlace HotelRoom array (NOT N sibling Hotel blocks) — D3', () => {
		const obj = buildHotelJsonLd(SIRIUS_BASE)
		const rooms = obj.containsPlace as Array<Record<string, unknown>>
		expect(Array.isArray(rooms)).toBe(true)
		expect(rooms).toHaveLength(2)
		for (const room of rooms) {
			expect(room['@type']).toBe('HotelRoom')
			const occ = room.occupancy as Record<string, unknown>
			expect(occ['@type']).toBe('QuantitativeValue')
			expect(occ.unitCode).toBe('C62') // dimensionless per UN/CEFACT
		}
	})

	it('[JL4] aggregateRating OMITTED entirely (D5 — Google suppression rule)', () => {
		const obj = buildHotelJsonLd(SIRIUS_BASE)
		expect(obj.aggregateRating).toBeUndefined()
		// starRating ≠ aggregateRating; starRating is canonical + safe.
		expect(obj.starRating).toEqual({ '@type': 'Rating', ratingValue: '4' })
	})

	it('[JL4.b] flat nested object (NOT @graph wrapper) — D4', () => {
		const obj = buildHotelJsonLd(SIRIUS_BASE)
		expect(obj['@graph']).toBeUndefined()
		// Hotel sits at top of object — direct @type, не вложенный.
		expect(obj['@type']).toBe('Hotel')
	})

	it('[JL4.c] priceRange symbolic string (D6 — NOT inline Offer[])', () => {
		const obj = buildHotelJsonLd(SIRIUS_BASE)
		expect(typeof obj.priceRange).toBe('string')
		expect(obj.priceRange).toBe('5000–15000 ₽')
		expect(obj.offers).toBeUndefined()
		expect(obj.makesOffer).toBeUndefined()
	})
})

describe('renderHotelJsonLdScript — XSS escape adversarial (D7 CRITICAL)', () => {
	it('[JL5] `</script>` injection in tenant name → escaped to safe form', () => {
		const malicious = renderHotelJsonLdScript({
			...SIRIUS_BASE,
			name: 'Hotel</script><script>alert(1)</script>',
		})
		// Critical assertion: NO literal `</script>` substring inside the
		// rendered block (would close the outer <script> tag и execute payload).
		const inner = malicious.slice('<script type="application/ld+json">'.length, -'</script>'.length)
		expect(inner.includes('</script>')).toBe(false)
		expect(inner.includes('<script>')).toBe(false)
		// Escaped form is `</script>` etc.
		expect(inner.includes('\\u003c/script\\u003e')).toBe(true)
		// Outer wrapper is correctly closed.
		expect(malicious.startsWith('<script type="application/ld+json">')).toBe(true)
		expect(malicious.endsWith('</script>')).toBe(true)
	})

	it('[JL5.b] `<!--` HTML comment + `-->` injection escaped', () => {
		const block = renderHotelJsonLdScript({
			...SIRIUS_BASE,
			description: 'Test <!-- injection --> here',
		})
		const inner = block.slice('<script type="application/ld+json">'.length, -'</script>'.length)
		expect(inner.includes('<!--')).toBe(false)
		expect(inner.includes('-->')).toBe(false)
		expect(inner.includes('\\u003c!--')).toBe(true)
	})

	it('[JL5.c] U+2028 line separator escaped (breaks JSONP pre-ES2019)', () => {
		const block = renderHotelJsonLdScript({
			...SIRIUS_BASE,
			name: `Hotel${String.fromCharCode(0x2028)}name`,
		})
		const inner = block.slice('<script type="application/ld+json">'.length, -'</script>'.length)
		expect(inner.includes(String.fromCharCode(0x2028))).toBe(false)
		expect(inner.includes('\\u2028')).toBe(true)
	})

	it('[JL5.d] U+2029 paragraph separator escaped', () => {
		const block = renderHotelJsonLdScript({
			...SIRIUS_BASE,
			name: `Hotel${String.fromCharCode(0x2029)}name`,
		})
		const inner = block.slice('<script type="application/ld+json">'.length, -'</script>'.length)
		expect(inner.includes(String.fromCharCode(0x2029))).toBe(false)
		expect(inner.includes('\\u2029')).toBe(true)
	})

	it('[JL5.e] ampersand entity preservation', () => {
		const block = renderHotelJsonLdScript({
			...SIRIUS_BASE,
			description: 'A & B & C',
		})
		const inner = block.slice('<script type="application/ld+json">'.length, -'</script>'.length)
		expect(inner.includes('&')).toBe(false)
		expect(inner.includes('\\u0026')).toBe(true)
	})
})

describe('renderHotelJsonLdScript — encoding + valid JSON round-trip', () => {
	it('[JL6] Cyrillic + emoji round-trip via JSON.parse', () => {
		const block = renderHotelJsonLdScript({
			...SIRIUS_BASE,
			name: 'Гостиница Сириус 🏨',
			description: 'Тест Cyrillic ёжик ©',
		})
		const inner = block.slice('<script type="application/ld+json">'.length, -'</script>'.length)
		// JSON.parse must succeed (escaped form is valid JSON).
		const parsed = JSON.parse(inner) as Record<string, unknown>
		// And round-trip must restore original Cyrillic + emoji.
		expect(parsed.name).toBe('Гостиница Сириус 🏨')
		expect(parsed.description).toBe('Тест Cyrillic ёжик ©')
	})

	it('[JL7] images array with ≥3 entries preserved as-is', () => {
		const block = renderHotelJsonLdScript(SIRIUS_BASE)
		const inner = block.slice('<script type="application/ld+json">'.length, -'</script>'.length)
		const parsed = JSON.parse(inner) as { image?: ReadonlyArray<string> }
		expect(parsed.image).toHaveLength(3)
		expect(parsed.image?.[0]).toBe('https://picsum.photos/seed/sirius-1/1200/800')
	})

	it('[JL8] empty roomTypes → containsPlace omitted', () => {
		const block = renderHotelJsonLdScript({ ...SIRIUS_BASE, roomTypes: [] })
		const inner = block.slice('<script type="application/ld+json">'.length, -'</script>'.length)
		const parsed = JSON.parse(inner) as Record<string, unknown>
		expect(parsed.containsPlace).toBeUndefined()
	})

	it('[JL8.b] potentialAction ReserveAction with EntryPoint (booking flow)', () => {
		const block = renderHotelJsonLdScript(SIRIUS_BASE)
		const inner = block.slice('<script type="application/ld+json">'.length, -'</script>'.length)
		const parsed = JSON.parse(inner) as Record<string, unknown>
		const action = parsed.potentialAction as Record<string, unknown>
		expect(action['@type']).toBe('ReserveAction')
		const target = action.target as Record<string, unknown>
		expect(target['@type']).toBe('EntryPoint')
		expect(target.urlTemplate).toBe('https://demo-sirius.sochi.app/widget/demo-sirius')
		expect((target.actionPlatform as Array<string>).length).toBe(2)
	})
})
