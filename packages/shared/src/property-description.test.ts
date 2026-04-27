/**
 * Strict tests for property descriptions Zod schemas + JSON-LD builder.
 *
 * Per `feedback_strict_tests.md`:
 *   - exact-value asserts on character-limit boundaries (off-by-one is a
 *     real risk for SERP truncation: 70 vs 71 chars matters)
 *   - exact JSON-LD shape with `@context`, `@type`, every conditional field
 *   - adversarial: extra keys in `sections` are rejected (.strict)
 *   - locale fallback exhaustive covered
 */
import { describe, expect, it } from 'vitest'
import {
	buildHotelJsonLd,
	checkAccessibilityCoverage,
	pickLocale,
	propertyDescriptionInputSchema,
	propertyDescriptionLocaleValues,
	propertyDescriptionSchema,
	propertyDescriptionSectionKeys,
	propertyDescriptionSectionsSchema,
} from './property-description.ts'

const validSection = 'Some markdown text describing this section.'

const fullValidInput = {
	title: 'Гранд Отель Сочи',
	tagline: 'Море, горы, комфорт',
	summaryMd: 'Гранд Отель Сочи в самом сердце курорта.',
	longDescriptionMd: '# Welcome\n\nFull markdown body here.',
	sections: {
		location: validSection,
		services: validSection,
		rooms: validSection,
		dining: validSection,
		activities: validSection,
		family: validSection,
		accessibility: validSection,
		pets: validSection,
	},
	seoMetaTitle: 'Гранд Отель Сочи — отдых у моря и в горах',
	seoMetaDescription:
		'4-звёздочный отель в Сочи с видом на море и горы, спа, рестораном и трансфером из аэропорта.',
	seoH1: 'Гранд Отель Сочи',
}

describe('propertyDescriptionLocaleValues', () => {
	it('exposes 2 locales: ru, en', () => {
		expect(propertyDescriptionLocaleValues).toEqual(['ru', 'en'])
	})
})

describe('propertyDescriptionSectionKeys', () => {
	it('exposes 8 canonical section keys (research §6)', () => {
		expect(propertyDescriptionSectionKeys).toEqual([
			'location',
			'services',
			'rooms',
			'dining',
			'activities',
			'family',
			'accessibility',
			'pets',
		])
	})
})

describe('propertyDescriptionSectionsSchema', () => {
	it('parses empty object', () => {
		expect(propertyDescriptionSectionsSchema.parse({})).toEqual({})
	})

	it('parses partial sections', () => {
		const out = propertyDescriptionSectionsSchema.parse({ location: 'X', dining: 'Y' })
		expect(out.location).toBe('X')
		expect(out.dining).toBe('Y')
		expect(out.activities).toBeUndefined()
	})

	it('parses all 8 sections present', () => {
		const all = Object.fromEntries(propertyDescriptionSectionKeys.map((k) => [k, validSection]))
		const out = propertyDescriptionSectionsSchema.parse(all)
		for (const k of propertyDescriptionSectionKeys) {
			expect(out[k]).toBe(validSection)
		}
	})

	it('rejects unknown section key (.strict)', () => {
		expect(() =>
			propertyDescriptionSectionsSchema.parse({
				location: 'X',
				bogusSection: 'evil',
			}),
		).toThrow()
	})

	it('rejects empty section string (min 1)', () => {
		expect(() => propertyDescriptionSectionsSchema.parse({ location: '' })).toThrow()
	})

	it('rejects section >8000 chars', () => {
		expect(() => propertyDescriptionSectionsSchema.parse({ location: 'X'.repeat(8001) })).toThrow()
	})

	it('accepts section at exactly 8000 chars (boundary)', () => {
		expect(() =>
			propertyDescriptionSectionsSchema.parse({ location: 'X'.repeat(8000) }),
		).not.toThrow()
	})
})

describe('propertyDescriptionInputSchema — boundaries', () => {
	it('parses minimal valid input', () => {
		const out = propertyDescriptionInputSchema.parse({
			title: 'Hotel',
			tagline: null,
			summaryMd: 'Short summary.',
			longDescriptionMd: null,
			sections: {},
			seoMetaTitle: null,
			seoMetaDescription: null,
			seoH1: null,
		})
		expect(out.title).toBe('Hotel')
		expect(out.sections).toEqual({})
	})

	it('parses fully populated input', () => {
		const out = propertyDescriptionInputSchema.parse(fullValidInput)
		expect(out.title).toBe(fullValidInput.title)
		expect(out.sections.location).toBe(validSection)
	})

	it('sections defaults to empty object when omitted', () => {
		const out = propertyDescriptionInputSchema.parse({
			title: fullValidInput.title,
			tagline: fullValidInput.tagline,
			summaryMd: fullValidInput.summaryMd,
			longDescriptionMd: fullValidInput.longDescriptionMd,
			seoMetaTitle: fullValidInput.seoMetaTitle,
			seoMetaDescription: fullValidInput.seoMetaDescription,
			seoH1: fullValidInput.seoH1,
		})
		expect(out.sections).toEqual({})
	})

	it('seoMetaTitle exactly 70 chars accepted (SERP boundary)', () => {
		const out = propertyDescriptionInputSchema.parse({
			...fullValidInput,
			seoMetaTitle: 'X'.repeat(70),
		})
		expect(out.seoMetaTitle).toHaveLength(70)
	})

	it('seoMetaTitle 71 chars rejected (off-by-one regression)', () => {
		expect(() =>
			propertyDescriptionInputSchema.parse({
				...fullValidInput,
				seoMetaTitle: 'X'.repeat(71),
			}),
		).toThrow()
	})

	it('seoMetaDescription exactly 160 chars accepted', () => {
		const out = propertyDescriptionInputSchema.parse({
			...fullValidInput,
			seoMetaDescription: 'X'.repeat(160),
		})
		expect(out.seoMetaDescription).toHaveLength(160)
	})

	it('seoMetaDescription 161 chars rejected', () => {
		expect(() =>
			propertyDescriptionInputSchema.parse({
				...fullValidInput,
				seoMetaDescription: 'X'.repeat(161),
			}),
		).toThrow()
	})

	it('tagline at exactly 100 chars accepted, 101 rejected', () => {
		propertyDescriptionInputSchema.parse({ ...fullValidInput, tagline: 'X'.repeat(100) })
		expect(() =>
			propertyDescriptionInputSchema.parse({ ...fullValidInput, tagline: 'X'.repeat(101) }),
		).toThrow()
	})

	it('summaryMd at exactly 800 chars accepted, 801 rejected', () => {
		propertyDescriptionInputSchema.parse({ ...fullValidInput, summaryMd: 'X'.repeat(800) })
		expect(() =>
			propertyDescriptionInputSchema.parse({ ...fullValidInput, summaryMd: 'X'.repeat(801) }),
		).toThrow()
	})

	it('longDescriptionMd at exactly 16000 chars accepted, 16001 rejected', () => {
		propertyDescriptionInputSchema.parse({
			...fullValidInput,
			longDescriptionMd: 'X'.repeat(16_000),
		})
		expect(() =>
			propertyDescriptionInputSchema.parse({
				...fullValidInput,
				longDescriptionMd: 'X'.repeat(16_001),
			}),
		).toThrow()
	})

	it('rejects missing required title', () => {
		expect(() =>
			propertyDescriptionInputSchema.parse({
				tagline: fullValidInput.tagline,
				summaryMd: fullValidInput.summaryMd,
				longDescriptionMd: fullValidInput.longDescriptionMd,
				sections: fullValidInput.sections,
				seoMetaTitle: fullValidInput.seoMetaTitle,
				seoMetaDescription: fullValidInput.seoMetaDescription,
				seoH1: fullValidInput.seoH1,
			}),
		).toThrow()
	})

	it('rejects empty title', () => {
		expect(() => propertyDescriptionInputSchema.parse({ ...fullValidInput, title: '' })).toThrow()
	})
})

describe('propertyDescriptionSchema (full row)', () => {
	it('parses a full row', () => {
		const row = {
			tenantId: 'org_abc',
			propertyId: 'prop_xyz',
			locale: 'ru' as const,
			...fullValidInput,
			createdAt: '2026-04-27T10:00:00.000Z',
			updatedAt: '2026-04-27T10:30:00.000Z',
		}
		const out = propertyDescriptionSchema.parse(row)
		expect(out.locale).toBe('ru')
	})

	it('rejects unknown locale', () => {
		expect(() =>
			propertyDescriptionSchema.parse({
				tenantId: 'org_abc',
				propertyId: 'prop_xyz',
				locale: 'fr', // not in enum
				...fullValidInput,
				createdAt: '2026-04-27T10:00:00.000Z',
				updatedAt: '2026-04-27T10:30:00.000Z',
			}),
		).toThrow()
	})
})

describe('buildHotelJsonLd', () => {
	const minimalInput = {
		propertyName: 'Гранд Отель Сочи',
		description: 'Marketing description.',
		imageUrls: [],
		address: {
			streetAddress: 'ул. Орджоникидзе, 11',
			addressLocality: 'Сочи',
			addressRegion: 'Краснодарский край',
			addressCountry: 'RU',
		},
	}

	it('builds minimal Hotel JSON-LD with required fields', () => {
		const ld = buildHotelJsonLd(minimalInput)
		expect(ld['@context']).toBe('https://schema.org')
		expect(ld['@type']).toBe('Hotel')
		expect(ld.name).toBe('Гранд Отель Сочи')
		expect(ld.description).toBe('Marketing description.')
		expect(ld.address).toEqual({
			'@type': 'PostalAddress',
			streetAddress: 'ул. Орджоникидзе, 11',
			addressLocality: 'Сочи',
			addressRegion: 'Краснодарский край',
			addressCountry: 'RU',
		})
	})

	it('omits image when no imageUrls', () => {
		const ld = buildHotelJsonLd(minimalInput)
		expect(ld).not.toHaveProperty('image')
	})

	it('emits image array when imageUrls provided', () => {
		const ld = buildHotelJsonLd({
			...minimalInput,
			imageUrls: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
		})
		expect(ld.image).toEqual(['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'])
	})

	it('includes postalCode when set', () => {
		const ld = buildHotelJsonLd({
			...minimalInput,
			address: { ...minimalInput.address, postalCode: '354340' },
		})
		expect(ld.address).toMatchObject({ postalCode: '354340' })
	})

	it('omits postalCode when undefined', () => {
		const ld = buildHotelJsonLd(minimalInput)
		expect((ld.address as Record<string, unknown>).postalCode).toBeUndefined()
	})

	it('emits geo when set with exact lat/lng', () => {
		const ld = buildHotelJsonLd({
			...minimalInput,
			geo: { latitude: 43.5855, longitude: 39.7231 },
		})
		expect(ld.geo).toEqual({
			'@type': 'GeoCoordinates',
			latitude: 43.5855,
			longitude: 39.7231,
		})
	})

	it('emits starRating with @type Rating + string ratingValue', () => {
		const ld = buildHotelJsonLd({ ...minimalInput, starRating: 4 })
		expect(ld.starRating).toEqual({
			'@type': 'Rating',
			ratingValue: '4', // string per Schema.org spec
		})
	})

	it('emits checkin/checkout times verbatim', () => {
		const ld = buildHotelJsonLd({
			...minimalInput,
			checkinTime: '15:00:00',
			checkoutTime: '12:00:00',
		})
		expect(ld.checkinTime).toBe('15:00:00')
		expect(ld.checkoutTime).toBe('12:00:00')
	})

	it('emits telephone + email when set', () => {
		const ld = buildHotelJsonLd({
			...minimalInput,
			telephone: '+7 862 123 45 67',
			email: 'info@grand-sochi.ru',
		})
		expect(ld.telephone).toBe('+7 862 123 45 67')
		expect(ld.email).toBe('info@grand-sochi.ru')
	})

	it('emits sameAs only when array non-empty', () => {
		expect(buildHotelJsonLd({ ...minimalInput, sameAs: [] })).not.toHaveProperty('sameAs')
		const ld = buildHotelJsonLd({
			...minimalInput,
			sameAs: ['https://booking.com/hotel/grand-sochi.html'],
		})
		expect(ld.sameAs).toEqual(['https://booking.com/hotel/grand-sochi.html'])
	})

	it('emits amenityFeature as LocationFeatureSpecification[] with bool/string values', () => {
		const ld = buildHotelJsonLd({
			...minimalInput,
			amenities: [
				{ name: 'Бесплатный Wi-Fi', value: true },
				{ name: 'Скорость Wi-Fi (Мбит/с)', value: '500' },
				{ name: 'Парковка', value: false },
			],
		})
		expect(ld.amenityFeature).toEqual([
			{ '@type': 'LocationFeatureSpecification', name: 'Бесплатный Wi-Fi', value: true },
			{ '@type': 'LocationFeatureSpecification', name: 'Скорость Wi-Fi (Мбит/с)', value: '500' },
			{ '@type': 'LocationFeatureSpecification', name: 'Парковка', value: false },
		])
	})

	it('JSON.stringify roundtrips with stable @context first (output ready for <script>)', () => {
		const ld = buildHotelJsonLd(minimalInput)
		const json = JSON.stringify(ld)
		expect(json.startsWith('{"@context":"https://schema.org"')).toBe(true)
	})

	it('does not mutate input arrays (defensive copy of imageUrls)', () => {
		const originalImages = ['https://a/1.jpg']
		const ld = buildHotelJsonLd({ ...minimalInput, imageUrls: originalImages })
		;(ld.image as string[]).push('mutated')
		expect(originalImages).toEqual(['https://a/1.jpg'])
	})
})

describe('pickLocale', () => {
	it('returns preferred when available', () => {
		expect(pickLocale(['ru', 'en'], 'en')).toBe('en')
	})

	it('returns fallback when preferred missing', () => {
		expect(pickLocale(['ru'], 'en', 'ru')).toBe('ru')
	})

	it('returns first available when neither preferred nor fallback', () => {
		expect(pickLocale(['en'], 'en', 'ru')).toBe('en')
	})

	it('returns null when no locales available', () => {
		expect(pickLocale([], 'ru', 'en')).toBeNull()
	})

	it('default fallback is ru', () => {
		expect(pickLocale(['ru'], 'en')).toBe('ru')
	})

	it('preferred preferred over fallback even when fallback also present', () => {
		expect(pickLocale(['ru', 'en'], 'en', 'ru')).toBe('en')
	})
})

describe('checkAccessibilityCoverage', () => {
	it('returns null when no accessibility amenities and no section', () => {
		expect(
			checkAccessibilityCoverage({
				sections: {},
				amenityCodes: ['AMN_RESTAURANT', 'AMN_AC'],
			}),
		).toBeNull()
	})

	it('returns null when accessibility amenity AND section present', () => {
		expect(
			checkAccessibilityCoverage({
				sections: { accessibility: 'Лифт, пандус, доступные номера.' },
				amenityCodes: ['AMN_ELEVATOR'],
			}),
		).toBeNull()
	})

	it('warns when accessibility amenity present but section missing', () => {
		const w = checkAccessibilityCoverage({
			sections: {},
			amenityCodes: ['AMN_ACCESSIBLE_ROOMS'],
		})
		expect(w).toMatch(/accessibility amenities.*no accessibility section/)
	})

	it('warns when accessibility amenity present but section is whitespace-only', () => {
		const w = checkAccessibilityCoverage({
			sections: { accessibility: '   ' },
			amenityCodes: ['AMN_WHEELCHAIR_RAMP'],
		})
		expect(w).toMatch(/accessibility amenities/)
	})

	it('returns null when section present but no accessibility amenities (operator override)', () => {
		// Operator may publish an accessibility section even without
		// formally claiming amenities — that's fine, no warning.
		expect(
			checkAccessibilityCoverage({
				sections: { accessibility: 'Доступная среда обеспечивается.' },
				amenityCodes: [],
			}),
		).toBeNull()
	})
})
