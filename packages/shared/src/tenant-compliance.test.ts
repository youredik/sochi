/**
 * Strict tests for tenant compliance invariants + threshold predicates.
 *
 * Per `feedback_strict_tests.md`:
 *   - exact-value asserts on threshold semantics (≥, не >)
 *   - adversarial coverage (each invalid combo of (legalEntity, taxRegime)
 *     and (ksrCategory, guestHouseFz127Registered))
 *   - exact error message regex match (allows precise wiring of i18n later)
 *   - enum FULL coverage on cross-field invariants
 *
 * Pure functions only — no DB. Repo-level tests in
 * apps/backend/src/domains/tenant/compliance.repo.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
	checkGuestHouseInvariant,
	checkTaxRegimeInvariant,
	isNpdLimitExceeded,
	isUsnThresholdAtRisk,
	ksrCategoryValues,
	legalEntityTypeValues,
	NPD_LIMIT_2026_MICRO_RUB,
	taxRegimeValues,
	tenantCompliancePatchSchema,
	tenantComplianceSchema,
	USN_THRESHOLD_2026_MICRO_RUB,
} from './tenant-compliance.ts'

describe('checkGuestHouseInvariant', () => {
	it('passes when ksrCategory=guest_house AND guestHouseFz127Registered=true', () => {
		expect(
			checkGuestHouseInvariant({ ksrCategory: 'guest_house', guestHouseFz127Registered: true }),
		).toBeNull()
	})

	it('passes when ksrCategory=guest_house AND guestHouseFz127Registered=false', () => {
		// User explicitly opted OUT of the experiment — valid per ПП-1345 §4
		// (участие добровольное в переходный период).
		expect(
			checkGuestHouseInvariant({ ksrCategory: 'guest_house', guestHouseFz127Registered: false }),
		).toBeNull()
	})

	it('rejects ksrCategory=guest_house with guestHouseFz127Registered=null', () => {
		const err = checkGuestHouseInvariant({
			ksrCategory: 'guest_house',
			guestHouseFz127Registered: null,
		})
		expect(err).toMatch(/гостевых домов.*ФЗ-127/)
	})

	it.each(
		ksrCategoryValues.filter((v) => v !== 'guest_house'),
	)('rejects ksrCategory=%s with guestHouseFz127Registered=true (only guest_house may set this)', (category) => {
		const err = checkGuestHouseInvariant({
			ksrCategory: category,
			guestHouseFz127Registered: true,
		})
		expect(err).toMatch(/применимо только к категории guest_house/)
	})

	it.each(
		ksrCategoryValues.filter((v) => v !== 'guest_house'),
	)('rejects ksrCategory=%s with guestHouseFz127Registered=false (same constraint)', (category) => {
		const err = checkGuestHouseInvariant({
			ksrCategory: category,
			guestHouseFz127Registered: false,
		})
		expect(err).toMatch(/применимо только к категории guest_house/)
	})

	it('passes when both fields are null (deferred onboarding step)', () => {
		expect(
			checkGuestHouseInvariant({ ksrCategory: null, guestHouseFz127Registered: null }),
		).toBeNull()
	})

	it('passes for non-guest_house with null guestHouseFz127Registered', () => {
		expect(
			checkGuestHouseInvariant({ ksrCategory: 'hotel', guestHouseFz127Registered: null }),
		).toBeNull()
	})
})

describe('checkTaxRegimeInvariant', () => {
	it('passes when both fields are null (deferred onboarding)', () => {
		expect(checkTaxRegimeInvariant({ legalEntityType: null, taxRegime: null })).toBeNull()
	})

	it('passes legalEntityType=npd + taxRegime=NPD', () => {
		expect(checkTaxRegimeInvariant({ legalEntityType: 'npd', taxRegime: 'NPD' })).toBeNull()
	})

	it('rejects legalEntityType=npd + taxRegime=USN_DOHODY (NPD-only)', () => {
		const err = checkTaxRegimeInvariant({ legalEntityType: 'npd', taxRegime: 'USN_DOHODY' })
		expect(err).toMatch(/Самозанятый.*NPD/)
	})

	it.each(
		legalEntityTypeValues.filter((v) => v !== 'npd'),
	)('rejects legalEntityType=%s + taxRegime=NPD (NPD only for self-employed)', (legalType) => {
		const err = checkTaxRegimeInvariant({ legalEntityType: legalType, taxRegime: 'NPD' })
		expect(err).toMatch(/NPD.*только для legalEntityType=npd/)
	})

	it('rejects legalEntityType=ip + taxRegime=AUSN_DOHODY_RASHODY', () => {
		const err = checkTaxRegimeInvariant({
			legalEntityType: 'ip',
			taxRegime: 'AUSN_DOHODY_RASHODY',
		})
		expect(err).toMatch(/ИП на АУСН.*AUSN_DOHODY/)
	})

	it('passes legalEntityType=ip + taxRegime=AUSN_DOHODY', () => {
		expect(checkTaxRegimeInvariant({ legalEntityType: 'ip', taxRegime: 'AUSN_DOHODY' })).toBeNull()
	})

	it.each([
		['ooo', 'USN_DOHODY'],
		['ooo', 'OSN'],
		['ao', 'OSN'],
		['ip', 'PSN'],
		['ip', 'USN_DOHODY_RASHODY'],
		['ooo', 'AUSN_DOHODY_RASHODY'],
	] as const)('passes legalEntityType=%s + taxRegime=%s', (legalType, regime) => {
		expect(checkTaxRegimeInvariant({ legalEntityType: legalType, taxRegime: regime })).toBeNull()
	})
})

describe('isUsnThresholdAtRisk (УСН 60M ₽ 2026 — 376-ФЗ)', () => {
	it('returns false for null revenue (not yet entered)', () => {
		expect(isUsnThresholdAtRisk(null)).toBe(false)
	})

	it('returns false at 79% of threshold', () => {
		const r = (USN_THRESHOLD_2026_MICRO_RUB * 79n) / 100n
		expect(isUsnThresholdAtRisk(r)).toBe(false)
	})

	it('returns true at exactly 80% of threshold (boundary)', () => {
		const r = (USN_THRESHOLD_2026_MICRO_RUB * 80n) / 100n
		expect(isUsnThresholdAtRisk(r)).toBe(true)
	})

	it('returns true at 95% of threshold', () => {
		const r = (USN_THRESHOLD_2026_MICRO_RUB * 95n) / 100n
		expect(isUsnThresholdAtRisk(r)).toBe(true)
	})

	it('returns true at 100% (exceeded)', () => {
		expect(isUsnThresholdAtRisk(USN_THRESHOLD_2026_MICRO_RUB)).toBe(true)
	})

	it('returns true above threshold (already lost USN)', () => {
		expect(isUsnThresholdAtRisk(USN_THRESHOLD_2026_MICRO_RUB * 2n)).toBe(true)
	})

	it('returns false at 0', () => {
		expect(isUsnThresholdAtRisk(0n)).toBe(false)
	})
})

describe('isNpdLimitExceeded (НПД 3.8M ₽ 2026 — 425-ФЗ)', () => {
	it('returns false for null revenue', () => {
		expect(isNpdLimitExceeded(null)).toBe(false)
	})

	it('returns false at NPD_LIMIT - 1 micro', () => {
		expect(isNpdLimitExceeded(NPD_LIMIT_2026_MICRO_RUB - 1n)).toBe(false)
	})

	it('returns true at exactly NPD_LIMIT (≥ — 425-ФЗ ст. 4 ч. 2)', () => {
		expect(isNpdLimitExceeded(NPD_LIMIT_2026_MICRO_RUB)).toBe(true)
	})

	it('returns true above limit', () => {
		expect(isNpdLimitExceeded(NPD_LIMIT_2026_MICRO_RUB + 1_000_000_000n)).toBe(true)
	})

	it('returns false at 0', () => {
		expect(isNpdLimitExceeded(0n)).toBe(false)
	})

	it('NPD_LIMIT_2026 = 3.8M ₽ exactly (per 425-ФЗ от 30.10.2025)', () => {
		// 3_800_000 ₽ × 1_000_000 micros/RUB = 3_800_000_000_000
		expect(NPD_LIMIT_2026_MICRO_RUB).toBe(3_800_000_000_000n)
	})

	it('USN_THRESHOLD_2026 = 60M ₽ exactly (per 376-ФЗ)', () => {
		// 60_000_000 ₽ × 1_000_000 micros/RUB = 60_000_000_000_000
		expect(USN_THRESHOLD_2026_MICRO_RUB).toBe(60_000_000_000_000n)
	})
})

describe('tenantComplianceSchema (Zod parsing)', () => {
	it('parses fully-populated valid object', () => {
		const input = {
			ksrRegistryId: 'KSR-2026-001234',
			ksrCategory: 'guest_house' as const,
			legalEntityType: 'ip' as const,
			taxRegime: 'USN_DOHODY' as const,
			annualRevenueEstimateMicroRub: 5_000_000_000_000n,
			guestHouseFz127Registered: true,
			ksrVerifiedAt: '2026-04-27T10:00:00.000Z',
		}
		const out = tenantComplianceSchema.parse(input)
		expect(out).toEqual(input)
	})

	it('parses all-null object (fresh org, nothing filled)', () => {
		const out = tenantComplianceSchema.parse({
			ksrRegistryId: null,
			ksrCategory: null,
			legalEntityType: null,
			taxRegime: null,
			annualRevenueEstimateMicroRub: null,
			guestHouseFz127Registered: null,
			ksrVerifiedAt: null,
		})
		expect(out.ksrRegistryId).toBeNull()
	})

	it('rejects unknown ksrCategory', () => {
		expect(() =>
			tenantComplianceSchema.parse({
				ksrRegistryId: null,
				ksrCategory: 'motel', // not in enum
				legalEntityType: null,
				taxRegime: null,
				annualRevenueEstimateMicroRub: null,
				guestHouseFz127Registered: null,
				ksrVerifiedAt: null,
			}),
		).toThrow()
	})

	it('rejects unknown taxRegime', () => {
		expect(() =>
			tenantComplianceSchema.parse({
				ksrRegistryId: null,
				ksrCategory: null,
				legalEntityType: null,
				taxRegime: 'EXOTIC_REGIME',
				annualRevenueEstimateMicroRub: null,
				guestHouseFz127Registered: null,
				ksrVerifiedAt: null,
			}),
		).toThrow()
	})

	it('rejects negative revenue', () => {
		expect(() =>
			tenantComplianceSchema.parse({
				ksrRegistryId: null,
				ksrCategory: null,
				legalEntityType: null,
				taxRegime: null,
				annualRevenueEstimateMicroRub: -1n,
				guestHouseFz127Registered: null,
				ksrVerifiedAt: null,
			}),
		).toThrow()
	})

	it('rejects ksrRegistryId longer than 50 chars', () => {
		expect(() =>
			tenantComplianceSchema.parse({
				ksrRegistryId: 'X'.repeat(51),
				ksrCategory: null,
				legalEntityType: null,
				taxRegime: null,
				annualRevenueEstimateMicroRub: null,
				guestHouseFz127Registered: null,
				ksrVerifiedAt: null,
			}),
		).toThrow()
	})

	it('exposes 11 ksrCategory values (ПП-1912 enum)', () => {
		expect(ksrCategoryValues).toHaveLength(11)
	})

	it('exposes 7 taxRegime values', () => {
		expect(taxRegimeValues).toHaveLength(7)
	})

	it('exposes 5 legalEntityType values', () => {
		expect(legalEntityTypeValues).toHaveLength(5)
	})
})

describe('tenantCompliancePatchSchema (Zod patch)', () => {
	it('accepts single-field patch', () => {
		expect(tenantCompliancePatchSchema.parse({ ksrRegistryId: 'KSR-001' })).toEqual({
			ksrRegistryId: 'KSR-001',
		})
	})

	it('accepts explicit null to clear a field', () => {
		expect(tenantCompliancePatchSchema.parse({ ksrRegistryId: null })).toEqual({
			ksrRegistryId: null,
		})
	})

	it('rejects empty patch (must have at least one field)', () => {
		expect(() => tenantCompliancePatchSchema.parse({})).toThrow(/At least one field/)
	})

	it('accepts multi-field patch with mixed types', () => {
		const out = tenantCompliancePatchSchema.parse({
			ksrCategory: 'hotel' as const,
			taxRegime: 'USN_DOHODY' as const,
			annualRevenueEstimateMicroRub: 1_000_000_000_000n,
		})
		expect(out.ksrCategory).toBe('hotel')
		expect(out.taxRegime).toBe('USN_DOHODY')
		expect(out.annualRevenueEstimateMicroRub).toBe(1_000_000_000_000n)
	})
})
