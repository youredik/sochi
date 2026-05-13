/**
 * DaDataParty Zod schema — strict tests (P4 2026-05-13).
 *
 * Pre-done audit:
 *   [R1] valid LEGAL party + 13-digit ОГРН → safeParse success
 *   [R2] valid INDIVIDUAL party + 15-digit ОГРНИП → safeParse success
 *   [R3] valid LEGAL party + ogrn=null → safeParse success (state-reg pending)
 *   [R4] valid INDIVIDUAL + ogrn=null → safeParse success
 *   [P1] LEGAL with 15-digit ogrn → fail with issue.path=['ogrn'] (cross-field)
 *   [P2] INDIVIDUAL with 13-digit ogrn → fail with issue.path=['ogrn']
 *   [P3] LEGAL with 12-digit ogrn → fail (base regex catches before refine)
 *   [P4] LEGAL with 14-digit ogrn → fail (base regex)
 *   [P5] ИП with 14-digit ogrn → fail (base regex; lengths 14/16 forbidden)
 *   [P6] non-digit ogrn → fail
 *   [I1] ИНН 9-digit → fail
 *   [I2] ИНН 11-digit → fail
 *   [I3] ИНН 13-digit → fail (only 10 or 12 allowed)
 *   [I4] ИНН с буквами → fail
 *   [N1] empty name → fail
 *   [N2] empty address → fail
 *   [N3] empty city → fail
 *   [L1] invalid legalForm → fail
 *   [S1] invalid status → fail
 *   [T1] invalid taxRegime → fail
 *   [F1] parseDaDataParty returns party for valid input
 *   [F2] parseDaDataParty returns null for invalid input
 *   [F3] parseDaDataParty returns null for non-object input
 */
import { describe, expect, it } from 'bun:test'
import { daDataPartySchema, parseDaDataParty } from './dadata.ts'

const VALID_LEGAL = {
	inn: '2320000001',
	ogrn: '1232300000001', // 13 digits
	name: 'ООО «Демо-Сириус»',
	legalForm: 'LEGAL',
	address: '354340, Краснодарский край, г. Сочи',
	city: 'Сочи',
	taxRegime: 'USN_DOHODY',
	status: 'ACTIVE',
} as const

const VALID_INDIVIDUAL = {
	inn: '232000000003',
	ogrn: '123230000000003', // 15 digits
	name: 'ИП Демонстрационный К.П.',
	legalForm: 'INDIVIDUAL',
	address: '354392, Краснодарский край, Красная Поляна',
	city: 'Красная Поляна',
	taxRegime: 'NPD',
	status: 'ACTIVE',
} as const

describe('daDataPartySchema — happy paths', () => {
	it('[R1] valid LEGAL party + 13-digit ОГРН parses', () => {
		const result = daDataPartySchema.safeParse(VALID_LEGAL)
		expect(result.success).toBe(true)
	})

	it('[R2] valid INDIVIDUAL party + 15-digit ОГРНИП parses', () => {
		const result = daDataPartySchema.safeParse(VALID_INDIVIDUAL)
		expect(result.success).toBe(true)
	})

	it('[R3] valid LEGAL party with ogrn=null parses (state-reg pending)', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, ogrn: null })
		expect(result.success).toBe(true)
	})

	it('[R4] valid INDIVIDUAL with ogrn=null parses', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_INDIVIDUAL, ogrn: null })
		expect(result.success).toBe(true)
	})
})

describe('daDataPartySchema — ОГРН length × legalForm refinement', () => {
	it('[P1] LEGAL + 15-digit ogrn fails с issue.path=[ogrn]', () => {
		const result = daDataPartySchema.safeParse({
			...VALID_LEGAL,
			ogrn: '123230000000099', // 15d
		})
		expect(result.success).toBe(false)
		if (!result.success) {
			const ogrnIssue = result.error.issues.find((i) => i.path[0] === 'ogrn')
			expect(ogrnIssue).not.toBe(undefined)
			expect(ogrnIssue?.message).toContain('13 цифр')
		}
	})

	it('[P2] INDIVIDUAL + 13-digit ogrn fails с issue.path=[ogrn]', () => {
		const result = daDataPartySchema.safeParse({
			...VALID_INDIVIDUAL,
			ogrn: '1232300000001', // 13d
		})
		expect(result.success).toBe(false)
		if (!result.success) {
			const ogrnIssue = result.error.issues.find((i) => i.path[0] === 'ogrn')
			expect(ogrnIssue).not.toBe(undefined)
			expect(ogrnIssue?.message).toContain('15 цифр')
		}
	})

	it('[P3] LEGAL + 12-digit ogrn fails at base regex (before refine)', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, ogrn: '123230000001' })
		expect(result.success).toBe(false)
	})

	it('[P4] LEGAL + 14-digit ogrn fails (lengths 14/16 не allowed)', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, ogrn: '12323000000019' })
		expect(result.success).toBe(false)
	})

	it('[P5] INDIVIDUAL + 14-digit ogrn fails', () => {
		const result = daDataPartySchema.safeParse({
			...VALID_INDIVIDUAL,
			ogrn: '12323000000019', // 14d
		})
		expect(result.success).toBe(false)
	})

	it('[P6] non-digit ogrn fails', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, ogrn: 'abc1234567890' })
		expect(result.success).toBe(false)
	})
})

describe('daDataPartySchema — ИНН regex', () => {
	it('[I1] ИНН 9-digit fails', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, inn: '123456789' })
		expect(result.success).toBe(false)
	})

	it('[I2] ИНН 11-digit fails (only 10 OR 12)', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, inn: '12345678901' })
		expect(result.success).toBe(false)
	})

	it('[I3] ИНН 13-digit fails (only 10 OR 12)', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, inn: '1234567890123' })
		expect(result.success).toBe(false)
	})

	it('[I4] ИНН с буквами fails', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, inn: '232000000a' })
		expect(result.success).toBe(false)
	})
})

describe('daDataPartySchema — required string fields', () => {
	it('[N1] empty name fails', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, name: '' })
		expect(result.success).toBe(false)
	})

	it('[N2] empty address fails', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, address: '' })
		expect(result.success).toBe(false)
	})

	it('[N3] empty city fails', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, city: '' })
		expect(result.success).toBe(false)
	})
})

describe('daDataPartySchema — enum constraints', () => {
	it('[L1] invalid legalForm fails', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, legalForm: 'PARTNERSHIP' })
		expect(result.success).toBe(false)
	})

	it('[S1] invalid status fails', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, status: 'ZOMBIE' })
		expect(result.success).toBe(false)
	})

	it('[T1] invalid taxRegime fails', () => {
		const result = daDataPartySchema.safeParse({ ...VALID_LEGAL, taxRegime: 'WIZARD_TAX' })
		expect(result.success).toBe(false)
	})
})

describe('parseDaDataParty helper', () => {
	it('[F1] returns party object on valid input (LEGAL)', () => {
		const parsed = parseDaDataParty(VALID_LEGAL)
		expect(parsed).toEqual(VALID_LEGAL)
	})

	it('[F2] returns null on cross-field refinement violation', () => {
		const parsed = parseDaDataParty({ ...VALID_LEGAL, ogrn: '123230000000099' })
		expect(parsed).toBe(null)
	})

	it('[F3] returns null on non-object input', () => {
		expect(parseDaDataParty('not-an-object')).toBe(null)
		expect(parseDaDataParty(null)).toBe(null)
		expect(parseDaDataParty(undefined)).toBe(null)
		expect(parseDaDataParty(42)).toBe(null)
	})

	it('[F4] returns null on missing required field', () => {
		const { ogrn: _ogrn, ...withoutOgrn } = VALID_LEGAL
		expect(parseDaDataParty(withoutOgrn)).toBe(null)
	})
})
