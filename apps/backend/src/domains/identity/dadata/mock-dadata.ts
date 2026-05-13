import type { DaDataAdapter, DaDataParty } from './types.ts'

/**
 * Canonical demo organizations used by demo tenants per
 * `[[behaviour_faithful_mock_canon]]` + `[[demo_strategy]]`. Three records
 * cover the geo + legal-form + tax-regime spread that the onboarding flow
 * must accommodate without the user typing anything else.
 *
 * ИНН values are NOT real legal-entity numbers — they are reserved within
 * the `2320` (Краснодарский край) prefix as deliberately fictitious. The
 * `0000001..3` suffix is unambiguous demo signalling.
 */
const DEMO_COMPANIES: Record<string, DaDataParty> = {
	'2320000001': {
		inn: '2320000001',
		ogrn: '1232300000001',
		name: 'ООО «Демо-Сириус»',
		legalForm: 'LEGAL',
		address: '354340, Краснодарский край, г. Сочи, Имеретинская низменность, д. 1',
		city: 'Сочи',
		taxRegime: 'USN_DOHODY',
		status: 'ACTIVE',
	},
	'2320000002': {
		inn: '2320000002',
		ogrn: '1232300000002',
		name: 'Гостевой дом «Демо-Адлер»',
		legalForm: 'LEGAL',
		address: '354340, Краснодарский край, г. Сочи, мкр. Адлер, ул. Демонстрационная, д. 7',
		city: 'Сочи',
		taxRegime: 'NPD',
		status: 'ACTIVE',
	},
	'232000000003': {
		inn: '232000000003',
		ogrn: null,
		name: 'ИП Демонстрационный К.П.',
		legalForm: 'INDIVIDUAL',
		address: '354392, Краснодарский край, г. Сочи, Красная Поляна, ул. Эстосадокская, д. 12',
		city: 'Красная Поляна',
		taxRegime: 'NPD',
		status: 'ACTIVE',
	},
}

/**
 * In-process DaData stand-in. No network, no clock, deterministic — safe to
 * call from any environment including unit tests and e2e. Returns `null` for
 * any ИНН outside the canonical demo set, mirroring the real adapter's
 * «record not found» branch.
 */
export function createMockDaData(): DaDataAdapter {
	return {
		async findByInn(inn) {
			return DEMO_COMPANIES[inn] ?? null
		},
	}
}
