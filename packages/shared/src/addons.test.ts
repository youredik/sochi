/**
 * Strict tests for addons schemas + computeAddonCharge.
 *
 * Per `feedback_strict_tests.md`:
 *   - exact-value asserts on every pricing-unit formula (no ranges)
 *   - bigint precision at boundary (no number coercion through Math.*)
 *   - adversarial: TIME_SLOT rejected (deferred), DAILY_COUNTER without
 *     dailyCapacity rejected, PERCENT > 100% rejected
 *   - VAT enum FULL coverage
 *   - non-integer nights/persons rejected, negative ctx rejected
 */
import { describe, expect, it } from 'vitest'
import {
	type Addon,
	addonCategoryValues,
	addonCreateInputSchema,
	addonInventoryModeValues,
	addonPatchSchema,
	addonPricingUnitValues,
	addonSeasonalTagValues,
	addonVatBpsSchema,
	computeAddonCharge,
	VAT_RATE_BPS_VALUES,
} from './addons.ts'

describe('enum surface (regression — fail loud on additions)', () => {
	it('addonCategoryValues = 12 categories (research §4)', () => {
		expect(addonCategoryValues).toHaveLength(12)
	})

	it('addonPricingUnitValues = 6 units (research §5.1)', () => {
		expect(addonPricingUnitValues).toEqual([
			'PER_STAY',
			'PER_PERSON',
			'PER_NIGHT',
			'PER_NIGHT_PER_PERSON',
			'PER_HOUR',
			'PERCENT_OF_ROOM_RATE',
		])
	})

	it('addonInventoryModeValues = 3 modes', () => {
		expect(addonInventoryModeValues).toEqual(['NONE', 'DAILY_COUNTER', 'TIME_SLOT'])
	})

	it('addonSeasonalTagValues = 4 Sochi tags', () => {
		expect(addonSeasonalTagValues).toEqual([
			'ski-season',
			'sea-season',
			'new-year-peak',
			'may-holidays',
		])
	})

	it('VAT_RATE_BPS_VALUES = 6 supported RU 2026 rates (0%, 5%, 7%, 10%, 20%, 22%)', () => {
		// 376-ФЗ от 12.07.2025: основная 22% с 01.01.2026 + УСН-НДС 5%/7% +
		// pre-existing 0% (accommodation льгота, продлена до 30.06.2027) +
		// 10% (пониженная — продукты/детские) + 20% (переходная). Plan v2
		// research/ru-compliance-2026.md §3.
		expect(VAT_RATE_BPS_VALUES).toEqual([0, 500, 700, 1000, 2000, 2200])
	})
})

describe('addonVatBpsSchema', () => {
	it.each(VAT_RATE_BPS_VALUES)('accepts canonical rate %i bps', (rate) => {
		expect(addonVatBpsSchema.parse(rate)).toBe(rate)
	})

	it('accepts 5% (УСН-НДС нижний — для УСН с выручкой 60-250M ₽)', () => {
		expect(addonVatBpsSchema.parse(500)).toBe(500)
	})

	it('accepts 7% (УСН-НДС средний — для УСН с выручкой 250-450M ₽)', () => {
		expect(addonVatBpsSchema.parse(700)).toBe(700)
	})

	it('rejects unsupported rate (1500 bps = 15%)', () => {
		const r = addonVatBpsSchema.safeParse(1500)
		expect(r.success).toBe(false)
		if (!r.success) {
			expect(r.error.issues[0]?.message).toMatch(/Unsupported VAT rate/)
		}
	})

	it('rejects 600 bps (between 5% and 7% — not a canonical rate)', () => {
		const r = addonVatBpsSchema.safeParse(600)
		expect(r.success).toBe(false)
	})

	it('rejects 1800 bps (between 10% and 20% — not canonical)', () => {
		expect(() => addonVatBpsSchema.parse(1800)).toThrow()
	})

	it('rejects > 10000 bps (sanity — typo guard)', () => {
		expect(() => addonVatBpsSchema.parse(22000)).toThrow()
	})

	it('rejects negative', () => {
		expect(() => addonVatBpsSchema.parse(-100)).toThrow()
	})

	it('rejects non-integer', () => {
		expect(() => addonVatBpsSchema.parse(2200.5)).toThrow()
	})
})

describe('addonCreateInputSchema', () => {
	const baseInput = {
		code: 'BREAKFAST',
		category: 'FOOD_AND_BEVERAGES' as const,
		nameRu: 'Завтрак',
		pricingUnit: 'PER_NIGHT_PER_PERSON' as const,
		priceMicros: 800_000_000n, // 800 ₽
		vatBps: 0, // 0% общепит-льгота
	}

	it('parses minimal valid input + applies defaults', () => {
		const out = addonCreateInputSchema.parse(baseInput)
		expect(out.currency).toBe('RUB')
		expect(out.isActive).toBe(true)
		expect(out.isMandatory).toBe(false)
		expect(out.inventoryMode).toBe('NONE')
		expect(out.seasonalTags).toEqual([])
		expect(out.sortOrder).toBe(0)
	})

	it('rejects unknown category', () => {
		expect(() => addonCreateInputSchema.parse({ ...baseInput, category: 'BOGUS' })).toThrow()
	})

	it('DAILY_COUNTER without dailyCapacity → rejected', () => {
		expect(() =>
			addonCreateInputSchema.parse({ ...baseInput, inventoryMode: 'DAILY_COUNTER' }),
		).toThrowError(/DAILY_COUNTER requires dailyCapacity/)
	})

	it('DAILY_COUNTER with dailyCapacity=0 → rejected (must be > 0)', () => {
		expect(() =>
			addonCreateInputSchema.parse({
				...baseInput,
				inventoryMode: 'DAILY_COUNTER',
				dailyCapacity: 0,
			}),
		).toThrow()
	})

	it('DAILY_COUNTER with dailyCapacity=10 → OK', () => {
		const out = addonCreateInputSchema.parse({
			...baseInput,
			inventoryMode: 'DAILY_COUNTER',
			dailyCapacity: 10,
		})
		expect(out.dailyCapacity).toBe(10)
	})

	it('TIME_SLOT mode rejected (deferred to M9)', () => {
		expect(() =>
			addonCreateInputSchema.parse({ ...baseInput, inventoryMode: 'TIME_SLOT' }),
		).toThrowError(/TIME_SLOT not supported yet/)
	})

	it('PERCENT_OF_ROOM_RATE: priceMicros ≤ 100_000_000 (=100%) accepted at boundary', () => {
		const out = addonCreateInputSchema.parse({
			...baseInput,
			pricingUnit: 'PERCENT_OF_ROOM_RATE',
			priceMicros: 100_000_000n,
		})
		expect(out.priceMicros).toBe(100_000_000n)
	})

	it('PERCENT_OF_ROOM_RATE: priceMicros = 100_000_001 (>100%) → rejected', () => {
		expect(() =>
			addonCreateInputSchema.parse({
				...baseInput,
				pricingUnit: 'PERCENT_OF_ROOM_RATE',
				priceMicros: 100_000_001n,
			}),
		).toThrow()
	})

	it('rejects negative priceMicros', () => {
		expect(() => addonCreateInputSchema.parse({ ...baseInput, priceMicros: -1n })).toThrow()
	})

	it('seasonalTags array of valid tags accepted', () => {
		const out = addonCreateInputSchema.parse({
			...baseInput,
			seasonalTags: ['ski-season', 'new-year-peak'],
		})
		expect(out.seasonalTags).toEqual(['ski-season', 'new-year-peak'])
	})

	it('seasonalTags rejects unknown tag', () => {
		expect(() =>
			addonCreateInputSchema.parse({ ...baseInput, seasonalTags: ['summer-2027'] }),
		).toThrow()
	})

	it('rejects empty code', () => {
		expect(() => addonCreateInputSchema.parse({ ...baseInput, code: '' })).toThrow()
	})

	it('rejects code > 50 chars', () => {
		expect(() => addonCreateInputSchema.parse({ ...baseInput, code: 'X'.repeat(51) })).toThrow()
	})
})

describe('addonPatchSchema', () => {
	it('accepts single-field patch', () => {
		expect(addonPatchSchema.parse({ priceMicros: 1_000_000n })).toEqual({
			priceMicros: 1_000_000n,
		})
	})

	it('accepts explicit null on nullable field (clear)', () => {
		expect(addonPatchSchema.parse({ nameEn: null })).toEqual({ nameEn: null })
	})

	it('rejects empty patch', () => {
		expect(() => addonPatchSchema.parse({})).toThrow(/At least one field/)
	})

	it('accepts price=0n (free addon allowed)', () => {
		expect(addonPatchSchema.parse({ priceMicros: 0n })).toEqual({ priceMicros: 0n })
	})
})

describe('computeAddonCharge — pricing units (exact-value)', () => {
	const baseAddon: Pick<Addon, 'pricingUnit' | 'priceMicros' | 'vatBps'> = {
		pricingUnit: 'PER_STAY',
		priceMicros: 2_500_000_000n, // 2500 ₽
		vatBps: 2200, // 22%
	}
	const ctx = {
		nights: 3,
		persons: 2,
		hours: 4,
		roomSubtotalMicros: 15_000_000_000n, // 15 000 ₽
	}

	it('PER_STAY = price × 1', () => {
		const r = computeAddonCharge(baseAddon, ctx)
		expect(r.netMicros).toBe(2_500_000_000n)
		expect(r.vatMicros).toBe(550_000_000n) // 2500 × 0.22 = 550
		expect(r.grossMicros).toBe(3_050_000_000n)
	})

	it('PER_PERSON = price × persons', () => {
		const a = { ...baseAddon, pricingUnit: 'PER_PERSON' as const, priceMicros: 1_500_000_000n }
		const r = computeAddonCharge(a, ctx)
		expect(r.netMicros).toBe(3_000_000_000n) // 1500 × 2
	})

	it('PER_NIGHT = price × nights', () => {
		const a = { ...baseAddon, pricingUnit: 'PER_NIGHT' as const, priceMicros: 500_000_000n }
		const r = computeAddonCharge(a, ctx)
		expect(r.netMicros).toBe(1_500_000_000n) // 500 × 3
	})

	it('PER_NIGHT_PER_PERSON = price × nights × persons', () => {
		const a = {
			...baseAddon,
			pricingUnit: 'PER_NIGHT_PER_PERSON' as const,
			priceMicros: 800_000_000n,
		}
		const r = computeAddonCharge(a, ctx)
		expect(r.netMicros).toBe(4_800_000_000n) // 800 × 3 × 2
	})

	it('PER_HOUR = price × hours (integer hours)', () => {
		const a = { ...baseAddon, pricingUnit: 'PER_HOUR' as const, priceMicros: 600_000_000n }
		const r = computeAddonCharge(a, { ...ctx, hours: 4 })
		expect(r.netMicros).toBe(2_400_000_000n) // 600 × 4
	})

	it('PER_HOUR with fractional hours (1.5 — millihours scale)', () => {
		const a = { ...baseAddon, pricingUnit: 'PER_HOUR' as const, priceMicros: 600_000_000n }
		const r = computeAddonCharge(a, { ...ctx, hours: 1.5 })
		// 600 × 1.5 = 900 → 900_000_000 micros
		expect(r.netMicros).toBe(900_000_000n)
	})

	it('PERCENT_OF_ROOM_RATE: 5% (5_000_000) of 15_000 ₽ subtotal = 750 ₽', () => {
		const a = {
			...baseAddon,
			pricingUnit: 'PERCENT_OF_ROOM_RATE' as const,
			priceMicros: 5_000_000n, // 5%
		}
		const r = computeAddonCharge(a, { ...ctx, roomSubtotalMicros: 15_000_000_000n })
		expect(r.netMicros).toBe(750_000_000n)
	})

	it('PERCENT_OF_ROOM_RATE: 100% (100_000_000) of 10 000 ₽ = 10 000 ₽', () => {
		const a = {
			...baseAddon,
			pricingUnit: 'PERCENT_OF_ROOM_RATE' as const,
			priceMicros: 100_000_000n,
		}
		const r = computeAddonCharge(a, { ...ctx, roomSubtotalMicros: 10_000_000_000n })
		expect(r.netMicros).toBe(10_000_000_000n)
	})
})

describe('computeAddonCharge — VAT layered exactly', () => {
	const a = {
		pricingUnit: 'PER_STAY' as const,
		priceMicros: 1_000_000_000n, // 1 000 ₽
	}
	const ctx = { nights: 1, persons: 1, hours: 0, roomSubtotalMicros: 0n }

	it('vatBps=0 → vat=0, gross=net', () => {
		const r = computeAddonCharge({ ...a, vatBps: 0 }, ctx)
		expect(r.netMicros).toBe(1_000_000_000n)
		expect(r.vatMicros).toBe(0n)
		expect(r.grossMicros).toBe(1_000_000_000n)
	})

	it('vatBps=2000 (20%) → vat = net × 0.2', () => {
		const r = computeAddonCharge({ ...a, vatBps: 2000 }, ctx)
		expect(r.vatMicros).toBe(200_000_000n)
		expect(r.grossMicros).toBe(1_200_000_000n)
	})

	it('vatBps=2200 (22% — 376-ФЗ 2026) → vat = net × 0.22', () => {
		const r = computeAddonCharge({ ...a, vatBps: 2200 }, ctx)
		expect(r.vatMicros).toBe(220_000_000n)
		expect(r.grossMicros).toBe(1_220_000_000n)
	})
})

describe('computeAddonCharge — adversarial', () => {
	const a = {
		pricingUnit: 'PER_NIGHT' as const,
		priceMicros: 1_000_000_000n,
		vatBps: 0,
	}

	it('rejects negative nights', () => {
		expect(() =>
			computeAddonCharge(a, { nights: -1, persons: 1, hours: 0, roomSubtotalMicros: 0n }),
		).toThrow(/non-negative/)
	})

	it('rejects negative persons', () => {
		expect(() =>
			computeAddonCharge(a, { nights: 1, persons: -1, hours: 0, roomSubtotalMicros: 0n }),
		).toThrow(/non-negative/)
	})

	it('rejects negative hours', () => {
		expect(() =>
			computeAddonCharge(a, { nights: 1, persons: 1, hours: -0.5, roomSubtotalMicros: 0n }),
		).toThrow(/non-negative/)
	})

	it('rejects non-integer nights', () => {
		expect(() =>
			computeAddonCharge(a, { nights: 1.5, persons: 1, hours: 0, roomSubtotalMicros: 0n }),
		).toThrow(/integers/)
	})

	it('rejects non-integer persons', () => {
		expect(() =>
			computeAddonCharge(a, { nights: 1, persons: 1.5, hours: 0, roomSubtotalMicros: 0n }),
		).toThrow(/integers/)
	})

	it('PER_STAY with persons=0 still computes (charge per stay; persons irrelevant)', () => {
		const r = computeAddonCharge(
			{ pricingUnit: 'PER_STAY', priceMicros: 100n, vatBps: 0 },
			{ nights: 1, persons: 0, hours: 0, roomSubtotalMicros: 0n },
		)
		expect(r.netMicros).toBe(100n)
	})

	it('PER_PERSON with persons=0 → 0 charge', () => {
		const r = computeAddonCharge(
			{ pricingUnit: 'PER_PERSON', priceMicros: 100n, vatBps: 0 },
			{ nights: 0, persons: 0, hours: 0, roomSubtotalMicros: 0n },
		)
		expect(r.netMicros).toBe(0n)
	})

	it('PER_NIGHT_PER_PERSON: huge values stay exact (no MAX_SAFE_INTEGER drift)', () => {
		const r = computeAddonCharge(
			{ pricingUnit: 'PER_NIGHT_PER_PERSON', priceMicros: 999_999_999_999n, vatBps: 0 },
			{ nights: 1000, persons: 1000, hours: 0, roomSubtotalMicros: 0n },
		)
		// 999_999_999_999 × 1000 × 1000 = 999_999_999_999_000_000
		expect(r.netMicros).toBe(999_999_999_999_000_000n)
	})
})
