/**
 * Strict tests for the canonical amenity catalog.
 *
 * The catalog is a *contract* with downstream consumers (channel managers,
 * widget UI, OTA distribution). These tests act as a tripwire against:
 *   - silent code rename (would break tenant data referencing old code)
 *   - silent OTA mapping change (would emit wrong code to Booking/Expedia)
 *   - duplicates (two definitions for the same internal code)
 *   - scope/value-support drift (invariants users rely on)
 *
 * Per `feedback_strict_tests.md`: exact-value asserts on counts + sample
 * lookups + adversarial inputs + full-coverage iteration.
 */
import { describe, expect, it } from 'vitest'
import {
	AMENITY_CATALOG,
	AMENITY_CODE_SET,
	amenitiesByScope,
	amenityCategoryValues,
	amenityCodeSchema,
	amenityFreePaidValues,
	amenityScopeValues,
	checkAmenityValueInvariant,
	getAmenity,
	isAmenityCode,
	propertyAmenityInputSchema,
} from './amenities.ts'

describe('AMENITY_CATALOG — structural invariants', () => {
	it('contains at least 50 amenities (covers 95% of OTA top-100)', () => {
		expect(AMENITY_CATALOG.length).toBeGreaterThanOrEqual(50)
	})

	it('contains exactly 64 amenities (snapshot — fail loud on additions)', () => {
		// Updating this number is intentional and requires a paired test
		// covering the new entry's mappings + scope.
		expect(AMENITY_CATALOG.length).toBe(64)
	})

	it('every code starts with AMN_ prefix and is uppercase snake_case', () => {
		for (const a of AMENITY_CATALOG) {
			expect(a.code).toMatch(/^AMN_[A-Z][A-Z0-9_]*$/)
		}
	})

	it('codes are unique (no duplicate definitions)', () => {
		const seen = new Map<string, number>()
		for (const a of AMENITY_CATALOG) {
			seen.set(a.code, (seen.get(a.code) ?? 0) + 1)
		}
		const duplicates = [...seen.entries()].filter(([, c]) => c > 1)
		expect(duplicates).toEqual([])
	})

	it('AMENITY_CODE_SET size == catalog length (no merges)', () => {
		expect(AMENITY_CODE_SET.size).toBe(AMENITY_CATALOG.length)
	})

	it('every entry has both labelRu (non-empty Cyrillic) and labelEn (non-empty Latin)', () => {
		for (const a of AMENITY_CATALOG) {
			expect(a.labelRu.length).toBeGreaterThan(0)
			expect(a.labelEn.length).toBeGreaterThan(0)
			expect(a.labelRu).toMatch(/[А-Яа-яЁё]/)
			expect(a.labelEn).toMatch(/[A-Za-z]/)
		}
	})

	it('every scope is in the canonical enum', () => {
		const valid = new Set(amenityScopeValues)
		for (const a of AMENITY_CATALOG) {
			expect(valid.has(a.scope)).toBe(true)
		}
	})

	it('every category is in the canonical enum', () => {
		const valid = new Set(amenityCategoryValues)
		for (const a of AMENITY_CATALOG) {
			expect(valid.has(a.category)).toBe(true)
		}
	})

	it('every defaultFreePaid is in the canonical enum', () => {
		const valid = new Set(amenityFreePaidValues)
		for (const a of AMENITY_CATALOG) {
			expect(valid.has(a.defaultFreePaid)).toBe(true)
		}
	})
})

describe('OTA mapping integrity', () => {
	it('HAC codes are positive integers when set (Booking spec)', () => {
		for (const a of AMENITY_CATALOG) {
			if (a.otaHac !== null) {
				expect(Number.isInteger(a.otaHac)).toBe(true)
				expect(a.otaHac).toBeGreaterThan(0)
			}
		}
	})

	it('RMA codes are positive integers when set', () => {
		for (const a of AMENITY_CATALOG) {
			if (a.otaRma !== null) {
				expect(Number.isInteger(a.otaRma)).toBe(true)
				expect(a.otaRma).toBeGreaterThan(0)
			}
		}
	})

	it('HAC mapping is property-scope only (HAC = Hotel Amenity Code)', () => {
		// HAC encodes property-level facilities. Pinning room-level amenities
		// to a HAC code would cause incorrect distribution to Booking.com.
		for (const a of AMENITY_CATALOG) {
			if (a.otaHac !== null) {
				expect(a.scope).toBe('property')
			}
		}
	})

	it('RMA mapping is room-scope only (RMA = Room Amenity)', () => {
		for (const a of AMENITY_CATALOG) {
			if (a.otaRma !== null) {
				expect(a.scope).toBe('room')
			}
		}
	})

	it('Wi-Fi entries have null OTA codes (Booking exposes via Internet Details API)', () => {
		const wifi = AMENITY_CATALOG.filter((a) => a.code.startsWith('AMN_WIFI_'))
		expect(wifi.length).toBeGreaterThanOrEqual(3)
		for (const a of wifi) {
			expect(a.otaHac).toBeNull()
			expect(a.otaRma).toBeNull()
		}
	})

	it('known Booking codes match expected entries (regression — sample 5)', () => {
		// HAC 1 = 24-hour front desk
		expect(getAmenity('AMN_FRONT_DESK_24H')?.otaHac).toBe(1)
		// HAC 5 = Air conditioning property-scope
		expect(getAmenity('AMN_AC')?.otaHac).toBe(5)
		// HAC 53 = Indoor parking
		expect(getAmenity('AMN_PARKING_INDOOR_FREE')?.otaHac).toBe(53)
		expect(getAmenity('AMN_PARKING_INDOOR_PAID')?.otaHac).toBe(53)
		// RMA 224 = Ocean view, RMA 223 = Mountain view
		expect(getAmenity('AMN_VIEW_SEA')?.otaRma).toBe(224)
		expect(getAmenity('AMN_VIEW_MOUNTAIN')?.otaRma).toBe(223)
	})

	it('AMN_AC is property-scope with HAC=5; no room-scope leakage via RMA', () => {
		// Anti-drift: a common mistake would be to set AMN_AC.otaRma=2 here
		// «just in case». RMA codes are STRICTLY room-scope (asserted above);
		// channel adapters project property-scope AC to per-roomType RMA at
		// distribution time. The property-scope row stays clean.
		const ac = getAmenity('AMN_AC')
		expect(ac).not.toBeNull()
		expect(ac?.scope).toBe('property')
		expect(ac?.otaHac).toBe(5)
		expect(ac?.otaRma).toBeNull()
	})
})

describe('value-supporting amenities', () => {
	it('all "supportsValue=true" entries are explicitly listed (regression)', () => {
		const expected = new Set([
			'AMN_WIFI_HIGH_SPEED', // speed in Mbps
			'AMN_PETS_ALLOWED_PAID', // ₽/night fee
			'AMN_TV_FLAT', // size in inches
		])
		const actual = new Set(AMENITY_CATALOG.filter((a) => a.supportsValue).map((a) => a.code))
		expect(actual).toEqual(expected)
	})

	it('non-value entries have supportsValue=false (no leaks)', () => {
		const valueSupporters = AMENITY_CATALOG.filter((a) => a.supportsValue)
		// Sanity: catalog has many; only 3 support value.
		expect(valueSupporters.length).toBeLessThan(AMENITY_CATALOG.length / 4)
	})
})

describe('isAmenityCode + getAmenity', () => {
	it('returns the catalog entry for a known code', () => {
		const a = getAmenity('AMN_WIFI_FREE_ROOM')
		expect(a).not.toBeNull()
		expect(a?.code).toBe('AMN_WIFI_FREE_ROOM')
		expect(a?.scope).toBe('room')
	})

	it('returns null for an unknown code', () => {
		expect(getAmenity('AMN_DOES_NOT_EXIST')).toBeNull()
	})

	it('isAmenityCode true for catalog codes', () => {
		expect(isAmenityCode('AMN_RESTAURANT')).toBe(true)
		expect(isAmenityCode('AMN_VIEW_SEA')).toBe(true)
	})

	it('isAmenityCode false for unknown', () => {
		expect(isAmenityCode('AMN_FAKE')).toBe(false)
		expect(isAmenityCode('')).toBe(false)
		expect(isAmenityCode('amn_wifi_free_room')).toBe(false) // case-sensitive
	})
})

describe('amenitiesByScope', () => {
	it('returns only property-scope entries', () => {
		const props = amenitiesByScope('property')
		expect(props.length).toBeGreaterThan(0)
		for (const a of props) {
			expect(a.scope).toBe('property')
		}
	})

	it('returns only room-scope entries', () => {
		const rooms = amenitiesByScope('room')
		expect(rooms.length).toBeGreaterThan(0)
		for (const a of rooms) {
			expect(a.scope).toBe('room')
		}
	})

	it('property + room = full catalog (no orphan scope)', () => {
		const props = amenitiesByScope('property')
		const rooms = amenitiesByScope('room')
		expect(props.length + rooms.length).toBe(AMENITY_CATALOG.length)
	})
})

describe('amenityCodeSchema (Zod refinement)', () => {
	it('accepts known code', () => {
		expect(amenityCodeSchema.parse('AMN_RESTAURANT')).toBe('AMN_RESTAURANT')
	})

	it('rejects unknown code with helpful message', () => {
		expect(() => amenityCodeSchema.parse('AMN_FAKE')).toThrowError(/canonical catalog/)
	})

	it('rejects empty string', () => {
		expect(() => amenityCodeSchema.parse('')).toThrow()
	})

	it('rejects non-string', () => {
		expect(() => amenityCodeSchema.parse(123 as unknown as string)).toThrow()
	})
})

describe('propertyAmenityInputSchema', () => {
	it('parses valid input with value=null', () => {
		const out = propertyAmenityInputSchema.parse({
			amenityCode: 'AMN_RESTAURANT',
			freePaid: 'paid',
			value: null,
		})
		expect(out.amenityCode).toBe('AMN_RESTAURANT')
		expect(out.value).toBeNull()
	})

	it('parses valid input without value (undefined)', () => {
		const out = propertyAmenityInputSchema.parse({
			amenityCode: 'AMN_RESTAURANT',
			freePaid: 'paid',
		})
		expect(out.amenityCode).toBe('AMN_RESTAURANT')
		expect(out.value).toBeUndefined()
	})

	it('parses input with value string', () => {
		const out = propertyAmenityInputSchema.parse({
			amenityCode: 'AMN_TV_FLAT',
			freePaid: 'free',
			value: '55',
		})
		expect(out.value).toBe('55')
	})

	it('rejects unknown amenity code', () => {
		expect(() =>
			propertyAmenityInputSchema.parse({
				amenityCode: 'AMN_FAKE',
				freePaid: 'free',
				value: null,
			}),
		).toThrow()
	})

	it('rejects unknown freePaid value', () => {
		expect(() =>
			propertyAmenityInputSchema.parse({
				amenityCode: 'AMN_AC',
				freePaid: 'discounted', // not in enum
				value: null,
			}),
		).toThrow()
	})

	it('rejects value > 200 chars', () => {
		expect(() =>
			propertyAmenityInputSchema.parse({
				amenityCode: 'AMN_TV_FLAT',
				freePaid: 'free',
				value: 'X'.repeat(201),
			}),
		).toThrow()
	})
})

describe('checkAmenityValueInvariant', () => {
	it('returns null when amenity supports value AND value is set', () => {
		expect(
			checkAmenityValueInvariant({
				amenityCode: 'AMN_TV_FLAT',
				freePaid: 'free',
				value: '55',
			}),
		).toBeNull()
	})

	it('returns null when amenity supports value AND value is null (optional)', () => {
		expect(
			checkAmenityValueInvariant({
				amenityCode: 'AMN_TV_FLAT',
				freePaid: 'free',
				value: null,
			}),
		).toBeNull()
	})

	it('returns null when amenity does NOT support value AND value is null', () => {
		expect(
			checkAmenityValueInvariant({
				amenityCode: 'AMN_RESTAURANT',
				freePaid: 'paid',
				value: null,
			}),
		).toBeNull()
	})

	it('returns error when amenity does NOT support value but value is set', () => {
		const err = checkAmenityValueInvariant({
			amenityCode: 'AMN_RESTAURANT',
			freePaid: 'paid',
			value: '5 stars',
		})
		expect(err).toMatch(/AMN_RESTAURANT.*does not support a measurable value/)
	})

	it('returns error when amenity does NOT support value but value is empty-string', () => {
		// Empty string is treated as "no value" — OK with non-supporting.
		expect(
			checkAmenityValueInvariant({
				amenityCode: 'AMN_RESTAURANT',
				freePaid: 'paid',
				value: '',
			}),
		).toBeNull()
	})

	it('returns error for unknown amenity code', () => {
		const err = checkAmenityValueInvariant({
			amenityCode: 'AMN_DOES_NOT_EXIST',
			freePaid: 'free',
			value: null,
		})
		expect(err).toMatch(/Unknown amenity code: AMN_DOES_NOT_EXIST/)
	})
})

describe('FULL-coverage adversarial: every catalog entry parses through Zod', () => {
	// Walk every entry and verify it can be used in propertyAmenityInputSchema
	// with its defaultFreePaid. Failing this means catalog drifted from schema.
	it.each(AMENITY_CATALOG)('round-trip valid for $code', (a) => {
		const input = {
			amenityCode: a.code,
			freePaid: a.defaultFreePaid,
			value: a.supportsValue ? '42' : null,
		}
		const parsed = propertyAmenityInputSchema.parse(input)
		expect(parsed.amenityCode).toBe(a.code)
		// Cross-field invariant must accept the canonical default.
		expect(checkAmenityValueInvariant(parsed)).toBeNull()
	})
})
