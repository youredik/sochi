/**
 * Round 8 P0-6 fix 2026-05-25 — strict unit tests на `checkBookingComplianceGate`
 * pure-function gate.
 *
 * **Background**: Round 6 introduced `assertKsrRegistryNumberPresent` which
 * unconditionally required ksrRegistryId — wrong для 2 of 3 РФ STR regulatory
 * paths. Per `project_rf_str_msp_horeca_landscape_2026_05_25.md`:
 *
 *   1. **Гостевой дом** (ksrCategory='guest_house') → 127-ФЗ от 07.06.2025
 *      registry (ОБЯЗАН с 01.01.2026 в 21 регионе + Сириус). NOT ПП-1951.
 *      Gate requires `guestHouseFz127Registered === true`.
 *   2. **Квартира посуточно НПД** (legalEntityType='npd') → NO registry.
 *      Outside both ПП-1951 и 127-ФЗ. Gate skipped entirely.
 *   3. **Гостиница / отель** (ksrCategory ∈ HOTEL_LIKE_KSR_CATEGORIES) →
 *      ПП-1951 от 27.12.2024 ред. 27.11.2025 effective 01.09.2025. Requires
 *      `ksrRegistryId` (формат `^С\d{12}$` — soft-validated at schema level).
 *
 * Pure function pattern (`feedback_round_7_v3_sws_canon_2026_05_25.md` canon:
 * pure-function module isolation для test imports). No SQL deps; full
 * branching coverage без DB.
 *
 * Test cases (exhaustive branch coverage):
 *   [G1] NPD legalEntityType → skip gate regardless of ksrRegistryId/Category
 *        (квартира посуточно вне обоих реестров)
 *   [G2] guest_house with guestHouseFz127Registered=true → pass
 *        (легализован в эксперименте 127-ФЗ)
 *   [G3] guest_house with guestHouseFz127Registered=false → GuestHouseFz127NotRegisteredError
 *        (НЕ KsrRegistryNumberMissingError — different code, different reason)
 *   [G4] guest_house with guestHouseFz127Registered=null → GuestHouseFz127NotRegisteredError
 *        (null = unknown = блок до явного подтверждения; защита от silent-allow)
 *   [G5] hotel-class category with valid ksrRegistryId → pass
 *   [G6] hotel-class category with null ksrRegistryId → KsrRegistryNumberMissingError
 *   [G7] hotel-class category with empty-string ksrRegistryId → KsrRegistryNumberMissingError
 *   [G8] hotel-class category with whitespace-only ksrRegistryId → KsrRegistryNumberMissingError
 *   [G9] aparthotel + valid ksrRegistryId → pass
 *   [G10] sanatorium + valid ksrRegistryId → pass
 *   [G11] hostel + valid ksrRegistryId → pass
 *   [G12] mini_hotel + null ksrRegistryId → KsrRegistryNumberMissingError (hotel-class)
 *   [G13] non-hotel-class category (camping, tourist_center, etc.) → pass
 *         с graceful degradation (warn-and-allow — unknown classification path)
 *   [G14] null ksrCategory + null legalEntityType → pass (incomplete profile
 *         BEFORE wizard completion; downstream service-boundary invariants
 *         catch this; gate доopen дозволяет initial demo bookings).
 *   [G15] hotel + ksrRegistryId present BUT legalEntityType='npd' → pass
 *         (NPD short-circuits; самозанятый с попыткой завести КСР record
 *         — edge-case, but skip-gate canon wins per task spec).
 */

import { describe, expect, test } from 'bun:test'
import {
	GuestHouseFz127NotRegisteredError,
	KsrRegistryNumberMissingError,
} from '../../errors/domain.ts'
import { checkBookingComplianceGate, HOTEL_LIKE_KSR_CATEGORIES } from './compliance-gate.ts'

const TENANT = 'org_t1'

describe('checkBookingComplianceGate — 3-path regulatory routing', () => {
	test('[G1] legalEntityType=npd short-circuits: skip gate regardless of fields', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: null,
			ksrCategory: null,
			legalEntityType: 'npd',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeNull()
	})

	test('[G2] guest_house + guestHouseFz127Registered=true → pass', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: null,
			ksrCategory: 'guest_house',
			legalEntityType: 'ip',
			guestHouseFz127Registered: true,
		})
		expect(out).toBeNull()
	})

	test('[G3] guest_house + guestHouseFz127Registered=false → GuestHouseFz127NotRegisteredError', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: null,
			ksrCategory: 'guest_house',
			legalEntityType: 'ip',
			guestHouseFz127Registered: false,
		})
		expect(out).toBeInstanceOf(GuestHouseFz127NotRegisteredError)
		expect(out?.code).toBe('GUEST_HOUSE_FZ127_NOT_REGISTERED')
		// Adversarial: must NOT be the wrong error class — different regulatory regime.
		expect(out).not.toBeInstanceOf(KsrRegistryNumberMissingError)
	})

	test('[G4] guest_house + guestHouseFz127Registered=null → GuestHouseFz127NotRegisteredError', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: null,
			ksrCategory: 'guest_house',
			legalEntityType: 'ip',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeInstanceOf(GuestHouseFz127NotRegisteredError)
		expect(out?.code).toBe('GUEST_HOUSE_FZ127_NOT_REGISTERED')
	})

	test('[G5] hotel + valid ksrRegistryId → pass', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: 'С782031059672',
			ksrCategory: 'hotel',
			legalEntityType: 'ooo',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeNull()
	})

	test('[G6] hotel + null ksrRegistryId → KsrRegistryNumberMissingError', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: null,
			ksrCategory: 'hotel',
			legalEntityType: 'ooo',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeInstanceOf(KsrRegistryNumberMissingError)
		expect(out?.code).toBe('KSR_REGISTRY_NUMBER_MISSING')
	})

	test('[G7] hotel + empty-string ksrRegistryId → KsrRegistryNumberMissingError', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: '',
			ksrCategory: 'hotel',
			legalEntityType: 'ooo',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeInstanceOf(KsrRegistryNumberMissingError)
	})

	test('[G8] hotel + whitespace-only ksrRegistryId → KsrRegistryNumberMissingError', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: '   \t  ',
			ksrCategory: 'hotel',
			legalEntityType: 'ooo',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeInstanceOf(KsrRegistryNumberMissingError)
	})

	test('[G9] aparthotel + valid ksrRegistryId → pass', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: 'С000000000002',
			ksrCategory: 'aparthotel',
			legalEntityType: 'ooo',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeNull()
	})

	test('[G10] sanatorium + valid ksrRegistryId → pass', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: 'С000000000003',
			ksrCategory: 'sanatorium',
			legalEntityType: 'ooo',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeNull()
	})

	test('[G11] hostel + valid ksrRegistryId → pass', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: 'С000000000004',
			ksrCategory: 'hostel',
			legalEntityType: 'ip',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeNull()
	})

	test('[G12] mini_hotel + null ksrRegistryId → KsrRegistryNumberMissingError (hotel-class)', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: null,
			ksrCategory: 'mini_hotel',
			legalEntityType: 'ip',
			guestHouseFz127Registered: null,
		})
		expect(out).toBeInstanceOf(KsrRegistryNumberMissingError)
	})

	test('[G13] non-hotel-class (camping/tourist_center/etc.) → pass с graceful degradation', () => {
		for (const cat of ['camping', 'tourist_center', 'recreation_complex', 'other'] as const) {
			const out = checkBookingComplianceGate(TENANT, {
				ksrRegistryId: null,
				ksrCategory: cat,
				legalEntityType: 'ip',
				guestHouseFz127Registered: null,
			})
			expect(out).toBeNull()
		}
	})

	test('[G14] null category + null legalEntityType → pass (incomplete profile, graceful)', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: null,
			ksrCategory: null,
			legalEntityType: null,
			guestHouseFz127Registered: null,
		})
		expect(out).toBeNull()
	})

	test('[G15] NPD short-circuit wins even with hotel category present', () => {
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: null,
			ksrCategory: 'hotel',
			legalEntityType: 'npd',
			guestHouseFz127Registered: null,
		})
		// NPD takes precedence per task spec (квартира посуточно вне ПП-1951).
		expect(out).toBeNull()
	})

	test('[G16] Round 10 P1-B5 — NPD + guest_house + Fz127Registered=false → null (NPD precedence)', () => {
		// Adversarial branch-order test: ensure NPD short-circuit fires BEFORE
		// guest_house 127-ФЗ check, even when both legalEntityType='npd' AND
		// ksrCategory='guest_house' AND Fz127Registered=false would individually
		// reject. Guards against future refactor that swaps branch order.
		const out = checkBookingComplianceGate(TENANT, {
			ksrRegistryId: null,
			ksrCategory: 'guest_house',
			legalEntityType: 'npd',
			guestHouseFz127Registered: false, // would normally reject under guest_house branch
		})
		expect(out).toBeNull()
	})
})

describe('HOTEL_LIKE_KSR_CATEGORIES set contents', () => {
	test('contains the canonical 5 hotel-class categories', () => {
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('hotel')).toBe(true)
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('aparthotel')).toBe(true)
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('mini_hotel')).toBe(true)
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('sanatorium')).toBe(true)
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('hostel')).toBe(true)
	})

	test('does NOT contain guest_house (separate 127-ФЗ path)', () => {
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('guest_house')).toBe(false)
	})

	test('does NOT contain camping/tourist_center/recreation_complex/other (graceful)', () => {
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('camping')).toBe(false)
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('tourist_center')).toBe(false)
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('recreation_complex')).toBe(false)
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('other')).toBe(false)
	})

	test('does NOT contain rest_house (санатории separately; rest_house is leisure-class, graceful)', () => {
		// rest_house = «дом отдыха» — historically not strictly КСР-required;
		// graceful path matches policy «warn don\'t block» для legacy data.
		expect(HOTEL_LIKE_KSR_CATEGORIES.has('rest_house')).toBe(false)
	})
})
