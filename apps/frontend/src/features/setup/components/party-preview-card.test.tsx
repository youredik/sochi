/**
 * PartyPreviewCard — strict render tests.
 *
 * Pre-done audit:
 *   [R1] renders ИНН + name + address + city + tax regime + status labels
 *   [R2] renders ОГРН label for LEGAL entity (когда ogrn !== null)
 *   [R3] renders ОГРНИП label for INDIVIDUAL entity
 *   [R4] omits the ОГРН row when ogrn === null
 *   [S1] LIQUIDATED status renders с destructive styling (border-destructive)
 *   [S2] ACTIVE status renders normal primary styling (border-primary)
 *   [T1] UNKNOWN tax regime maps to «Налоговый режим не указан»
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { PartyPreviewCard } from './party-preview-card.tsx'
import type { DaDataParty } from '../lib/dadata.ts'

const LEGAL_ACTIVE: DaDataParty = {
	inn: '2320000001',
	ogrn: '1232300000001',
	name: 'ООО «Демо-Сириус»',
	legalForm: 'LEGAL',
	address: '354340, г. Сочи, Имеретинская низменность, д. 1',
	city: 'Сочи',
	taxRegime: 'USN_DOHODY',
	status: 'ACTIVE',
}

const IP_NO_OGRN: DaDataParty = {
	...LEGAL_ACTIVE,
	inn: '232000000003',
	ogrn: null,
	name: 'ИП Демонстрационный К.П.',
	legalForm: 'INDIVIDUAL',
	city: 'Красная Поляна',
	taxRegime: 'NPD',
}

const LEGAL_LIQUIDATED: DaDataParty = {
	...LEGAL_ACTIVE,
	status: 'LIQUIDATED',
}

afterEach(cleanup)

describe('PartyPreviewCard — render fields', () => {
	it('[R1] renders core fields: ИНН + name + address + city + tax regime + status', () => {
		render(<PartyPreviewCard party={LEGAL_ACTIVE} />)
		expect(screen.queryByText('ООО «Демо-Сириус»')).not.toBe(null)
		expect(screen.queryByText('2320000001')).not.toBe(null)
		expect(screen.queryByText('354340, г. Сочи, Имеретинская низменность, д. 1')).not.toBe(null)
		expect(screen.queryByText('Сочи')).not.toBe(null)
		expect(screen.queryByText('УСН «Доходы» (6%)')).not.toBe(null)
		expect(screen.queryByText('Действующая')).not.toBe(null)
	})

	it('[R2] renders ОГРН label for LEGAL entity with ogrn set', () => {
		render(<PartyPreviewCard party={LEGAL_ACTIVE} />)
		expect(screen.queryByText('ОГРН')).not.toBe(null)
		expect(screen.queryByText('1232300000001')).not.toBe(null)
	})

	it('[R3] renders ОГРНИП label for INDIVIDUAL entity (when ogrn set)', () => {
		render(<PartyPreviewCard party={{ ...IP_NO_OGRN, ogrn: '321231231231231' }} />)
		expect(screen.queryByText('ОГРНИП')).not.toBe(null)
	})

	it('[R4] omits the ОГРН row when ogrn === null', () => {
		render(<PartyPreviewCard party={IP_NO_OGRN} />)
		expect(screen.queryByText('ОГРН')).toBe(null)
		expect(screen.queryByText('ОГРНИП')).toBe(null)
	})
})

describe('PartyPreviewCard — status branching', () => {
	it('[S1] LIQUIDATED renders destructive styling on the wrapping aside', () => {
		const { container } = render(<PartyPreviewCard party={LEGAL_LIQUIDATED} />)
		const aside = container.querySelector('aside')
		expect(aside?.className.includes('border-destructive')).toBe(true)
		// «Ликвидирована» в Russian
		expect(screen.queryByText('Ликвидирована')).not.toBe(null)
	})

	it('[S2] ACTIVE renders primary styling', () => {
		const { container } = render(<PartyPreviewCard party={LEGAL_ACTIVE} />)
		const aside = container.querySelector('aside')
		expect(aside?.className.includes('border-primary')).toBe(true)
		expect(aside?.className.includes('border-destructive')).toBe(false)
	})
})

describe('PartyPreviewCard — tax regime labels', () => {
	it('[T1] UNKNOWN maps to «Налоговый режим не указан»', () => {
		render(<PartyPreviewCard party={{ ...LEGAL_ACTIVE, taxRegime: 'UNKNOWN' }} />)
		expect(screen.queryByText('Налоговый режим не указан')).not.toBe(null)
	})
})
