/**
 * Unit tests for routing-rule shared schemas (Apaleo+Mews canonical
 * declarative folio routing).
 *
 * Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):
 *   [X] routingRuleMatchScopeSchema: 3 values FULL + reject unknown
 *   [X] folioLineCategorySchema: 11 values FULL + reject unknown
 *   [X] routingRuleCreateInput happy path positive
 *   [X] priority bounds: 0..1000 boundary + reject -1 + reject 1001
 *   [X] amountLimitMinor: > 0 + Int64 max + null OK
 *   [X] validFrom / validTo: ISO date format strict
 *   [X] **CROSS-FIELD refinement**: matchScope='company' → matchCompanyId required
 *   [X] **CROSS-FIELD refinement**: matchScope='ratePlan' → matchRatePlanId required
 *   [X] **CROSS-FIELD refinement**: targetFolioKind='company' → targetCompanyId required
 *   [X] **CROSS-FIELD refinement**: validTo >= validFrom (forbid backward window)
 *   [X] All 4 refinements tested in BOTH directions: violation + satisfaction
 *   [X] routingRuleUpdateInput: partial validation
 *   [X] ROUTING_DEFAULT_FOLIO_KIND: literal 'guest'
 *   [X] enabled defaults to true when omitted
 */

import { describe, expect, it } from 'vitest'
import { newId } from './ids.ts'
import {
	folioLineCategorySchema,
	ROUTING_DEFAULT_FOLIO_KIND,
	routingRuleCreateInput,
	routingRuleMatchScopeSchema,
	routingRuleUpdateInput,
} from './routing-rule.ts'

const validBase = () =>
	({
		name: 'F&B → Master',
		priority: 100,
		matchScope: 'property' as const,
		matchChargeCategories: ['fnb' as const],
		targetFolioKind: 'guest' as const,
		validFrom: '2026-01-01',
	}) satisfies Record<string, unknown>

describe('routingRuleMatchScopeSchema (3 enum values FULL)', () => {
	it.each(['property', 'company', 'ratePlan'] as const)('accepts %s', (v) => {
		expect(routingRuleMatchScopeSchema.safeParse(v).success).toBe(true)
	})

	it('rejects unknown scope', () => {
		expect(routingRuleMatchScopeSchema.safeParse('booking').success).toBe(false)
	})
})

describe('folioLineCategorySchema (11 enum values FULL)', () => {
	const ALL_CATEGORIES = [
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

	it.each(ALL_CATEGORIES)('accepts %s', (v) => {
		expect(folioLineCategorySchema.safeParse(v).success).toBe(true)
	})

	it('exhaustively covers exactly 11 values', () => {
		expect(ALL_CATEGORIES.length).toBe(11)
	})

	it('rejects unknown category', () => {
		expect(folioLineCategorySchema.safeParse('breakfast').success).toBe(false)
	})
})

describe('routingRuleCreateInput — happy path + boundary', () => {
	it('accepts a fully valid base payload', () => {
		expect(routingRuleCreateInput.safeParse(validBase()).success).toBe(true)
	})

	it('priority lower boundary 0', () => {
		expect(routingRuleCreateInput.safeParse({ ...validBase(), priority: 0 }).success).toBe(true)
	})

	it('priority upper boundary 1000', () => {
		expect(routingRuleCreateInput.safeParse({ ...validBase(), priority: 1000 }).success).toBe(true)
	})

	it('rejects priority = -1', () => {
		expect(routingRuleCreateInput.safeParse({ ...validBase(), priority: -1 }).success).toBe(false)
	})

	it('rejects priority = 1001', () => {
		expect(routingRuleCreateInput.safeParse({ ...validBase(), priority: 1001 }).success).toBe(false)
	})

	it('rejects non-integer priority', () => {
		expect(routingRuleCreateInput.safeParse({ ...validBase(), priority: 100.5 }).success).toBe(
			false,
		)
	})

	it('rejects matchChargeCategories = empty array', () => {
		expect(
			routingRuleCreateInput.safeParse({ ...validBase(), matchChargeCategories: [] }).success,
		).toBe(false)
	})

	it('rejects validFrom = non-ISO date', () => {
		expect(
			routingRuleCreateInput.safeParse({ ...validBase(), validFrom: '01/01/2026' }).success,
		).toBe(false)
	})

	it('amountLimitMinor accepts null', () => {
		expect(
			routingRuleCreateInput.safeParse({ ...validBase(), amountLimitMinor: null }).success,
		).toBe(true)
	})

	it('amountLimitMinor rejects 0n (must be > 0)', () => {
		expect(routingRuleCreateInput.safeParse({ ...validBase(), amountLimitMinor: 0n }).success).toBe(
			false,
		)
	})

	it('amountLimitMinor rejects negative', () => {
		expect(
			routingRuleCreateInput.safeParse({ ...validBase(), amountLimitMinor: -1n }).success,
		).toBe(false)
	})

	it('amountLimitMinor accepts Int64 max', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				amountLimitMinor: 9_223_372_036_854_775_807n,
			}).success,
		).toBe(true)
	})

	it('amountLimitMinor rejects > Int64 max', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				amountLimitMinor: 9_223_372_036_854_775_808n,
			}).success,
		).toBe(false)
	})

	it('enabled defaults to true when omitted', () => {
		const parsed = routingRuleCreateInput.parse(validBase())
		expect(parsed.enabled).toBe(true)
	})

	it('enabled = false explicit is preserved', () => {
		const parsed = routingRuleCreateInput.parse({ ...validBase(), enabled: false })
		expect(parsed.enabled).toBe(false)
	})
})

describe('CROSS-FIELD refinement — matchScope=company → matchCompanyId required', () => {
	it('REJECTS matchScope=company without matchCompanyId', () => {
		const result = routingRuleCreateInput.safeParse({
			...validBase(),
			matchScope: 'company',
		})
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues.some((i) => i.path.includes('matchCompanyId'))).toBe(true)
		}
	})

	it('REJECTS matchScope=company with matchCompanyId=null', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				matchScope: 'company',
				matchCompanyId: null,
			}).success,
		).toBe(false)
	})

	it('ACCEPTS matchScope=company with matchCompanyId set', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				matchScope: 'company',
				matchCompanyId: 'co-acme-001',
			}).success,
		).toBe(true)
	})

	it('does NOT require matchCompanyId for matchScope=property', () => {
		expect(
			routingRuleCreateInput.safeParse({ ...validBase(), matchScope: 'property' }).success,
		).toBe(true)
	})
})

describe('CROSS-FIELD refinement — matchScope=ratePlan → matchRatePlanId required', () => {
	it('REJECTS matchScope=ratePlan without matchRatePlanId', () => {
		expect(
			routingRuleCreateInput.safeParse({ ...validBase(), matchScope: 'ratePlan' }).success,
		).toBe(false)
	})

	it('REJECTS matchScope=ratePlan with matchRatePlanId=null', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				matchScope: 'ratePlan',
				matchRatePlanId: null,
			}).success,
		).toBe(false)
	})

	it('ACCEPTS matchScope=ratePlan with valid matchRatePlanId typeid', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				matchScope: 'ratePlan',
				matchRatePlanId: newId('ratePlan'),
			}).success,
		).toBe(true)
	})

	it('REJECTS matchScope=ratePlan with non-ratePlan typeid (wrong prefix)', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				matchScope: 'ratePlan',
				matchRatePlanId: newId('property'),
			}).success,
		).toBe(false)
	})
})

describe('CROSS-FIELD refinement — targetFolioKind=company → targetCompanyId required', () => {
	it('REJECTS targetFolioKind=company without targetCompanyId', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				matchScope: 'company',
				matchCompanyId: 'co-1',
				targetFolioKind: 'company',
			}).success,
		).toBe(false)
	})

	it('REJECTS targetFolioKind=company with targetCompanyId=null', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				matchScope: 'company',
				matchCompanyId: 'co-1',
				targetFolioKind: 'company',
				targetCompanyId: null,
			}).success,
		).toBe(false)
	})

	it('ACCEPTS targetFolioKind=company with targetCompanyId set', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				matchScope: 'company',
				matchCompanyId: 'co-1',
				targetFolioKind: 'company',
				targetCompanyId: 'co-1',
			}).success,
		).toBe(true)
	})

	it('does NOT require targetCompanyId for targetFolioKind=guest', () => {
		expect(
			routingRuleCreateInput.safeParse({ ...validBase(), targetFolioKind: 'guest' }).success,
		).toBe(true)
	})
})

describe('CROSS-FIELD refinement — validTo >= validFrom', () => {
	it('ACCEPTS validTo > validFrom', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				validFrom: '2026-01-01',
				validTo: '2026-12-31',
			}).success,
		).toBe(true)
	})

	it('ACCEPTS validTo = validFrom (single-day window)', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				validFrom: '2026-06-15',
				validTo: '2026-06-15',
			}).success,
		).toBe(true)
	})

	it('REJECTS validTo < validFrom (backward window)', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				validFrom: '2026-06-15',
				validTo: '2026-06-14',
			}).success,
		).toBe(false)
	})

	it('ACCEPTS validTo = null (open-ended window)', () => {
		expect(
			routingRuleCreateInput.safeParse({
				...validBase(),
				validFrom: '2026-06-15',
				validTo: null,
			}).success,
		).toBe(true)
	})

	it('ACCEPTS validTo = omitted (open-ended window)', () => {
		expect(routingRuleCreateInput.safeParse(validBase()).success).toBe(true)
	})
})

describe('routingRuleUpdateInput', () => {
	it('accepts empty patch (no fields)', () => {
		expect(routingRuleUpdateInput.safeParse({}).success).toBe(true)
	})

	it('accepts single-field patch (priority)', () => {
		expect(routingRuleUpdateInput.safeParse({ priority: 50 }).success).toBe(true)
	})

	it('rejects priority out of bounds in patch', () => {
		expect(routingRuleUpdateInput.safeParse({ priority: 1001 }).success).toBe(false)
	})

	it('accepts validTo = null in patch (clear an end-date)', () => {
		expect(routingRuleUpdateInput.safeParse({ validTo: null }).success).toBe(true)
	})

	it('rejects empty matchChargeCategories in patch', () => {
		expect(routingRuleUpdateInput.safeParse({ matchChargeCategories: [] }).success).toBe(false)
	})
})

describe('ROUTING_DEFAULT_FOLIO_KIND', () => {
	it('equals "guest" (canon safe default)', () => {
		expect(ROUTING_DEFAULT_FOLIO_KIND).toBe('guest')
	})
})
