/**
 * createMockDaData — strict tests.
 *
 * Pre-done audit:
 *   [R1] returns ООО «Демо-Сириус» for ИНН 2320000001 (10 digits / LEGAL / Сочи / USN)
 *   [R2] returns Гостевой дом «Демо-Адлер» for ИНН 2320000002 (LEGAL / Сочи / NPD)
 *   [R3] returns ИП Демонстрационный К.П. for ИНН 232000000003 (12 digits / INDIVIDUAL / Красная Поляна)
 *   [R4] returns ООО «Демо-Ликвидированная» for ИНН 2320000099 (LIQUIDATED — adversarial canon fixture)
 *   [N1] returns null for unknown ИНН (10-digit)
 *   [N2] returns null for unknown ИНН (12-digit)
 *   [N3] returns null for empty string
 *   [I1] each ACTIVE canonical record satisfies the DaDataParty contract (status='ACTIVE', name non-empty)
 *   [I2] mock is deterministic across repeated calls (same ИНН → same reference-equal record)
 */
import { describe, expect, it } from 'bun:test'
import { createMockDaData } from './mock-dadata.ts'

describe('createMockDaData — canonical demo set', () => {
	it('[R1] returns ООО «Демо-Сириус» for ИНН 2320000001', async () => {
		const adapter = createMockDaData()
		const party = await adapter.findByInn('2320000001')
		expect(party).not.toBe(null)
		expect(party).toEqual({
			inn: '2320000001',
			ogrn: '1232300000001',
			name: 'ООО «Демо-Сириус»',
			legalForm: 'LEGAL',
			address: '354340, Краснодарский край, г. Сочи, Имеретинская низменность, д. 1',
			city: 'Сочи',
			taxRegime: 'USN_DOHODY',
			status: 'ACTIVE',
		})
	})

	it('[R2] returns Гостевой дом «Демо-Адлер» for ИНН 2320000002', async () => {
		const adapter = createMockDaData()
		const party = await adapter.findByInn('2320000002')
		expect(party).not.toBe(null)
		expect(party?.name).toBe('Гостевой дом «Демо-Адлер»')
		expect(party?.city).toBe('Сочи')
		expect(party?.taxRegime).toBe('NPD')
		expect(party?.legalForm).toBe('LEGAL')
		expect(party?.status).toBe('ACTIVE')
	})

	it('[R3] returns ИП Демонстрационный К.П. for ИНН 232000000003 (12-digit ИП format)', async () => {
		const adapter = createMockDaData()
		const party = await adapter.findByInn('232000000003')
		expect(party).not.toBe(null)
		expect(party?.inn).toBe('232000000003')
		expect(party?.inn.length).toBe(12)
		expect(party?.legalForm).toBe('INDIVIDUAL')
		expect(party?.city).toBe('Красная Поляна')
		expect(party?.ogrn).toBe(null)
	})

	it('[R4] returns ООО «Демо-Ликвидированная» for ИНН 2320000099 (LIQUIDATED adversarial)', async () => {
		const adapter = createMockDaData()
		const party = await adapter.findByInn('2320000099')
		expect(party).toEqual({
			inn: '2320000099',
			ogrn: '1232300000099',
			name: 'ООО «Демо-Ликвидированная»',
			legalForm: 'LEGAL',
			address: '354340, Краснодарский край, г. Сочи, Имеретинская низменность, д. 99',
			city: 'Сочи',
			taxRegime: 'USN_DOHODY',
			status: 'LIQUIDATED',
		})
	})
})

describe('createMockDaData — unknown lookups', () => {
	it('[N1] returns null for unknown 10-digit ИНН', async () => {
		const adapter = createMockDaData()
		expect(await adapter.findByInn('7707083893')).toBe(null)
	})

	it('[N2] returns null for unknown 12-digit ИНН', async () => {
		const adapter = createMockDaData()
		expect(await adapter.findByInn('770708389312')).toBe(null)
	})

	it('[N3] returns null for empty string', async () => {
		const adapter = createMockDaData()
		expect(await adapter.findByInn('')).toBe(null)
	})
})

describe('createMockDaData — contract invariants', () => {
	it('[I1] every ACTIVE canonical record has non-empty name + ACTIVE status', async () => {
		// ИНН 2320000099 is the LIQUIDATED adversarial fixture — covered by
		// [R4] separately. This invariant scans only the happy-path active set.
		const adapter = createMockDaData()
		for (const inn of ['2320000001', '2320000002', '232000000003']) {
			const party = await adapter.findByInn(inn)
			expect(party).not.toBe(null)
			expect((party?.name.length ?? 0) > 0).toBe(true)
			expect(party?.status).toBe('ACTIVE')
			expect(party?.address.length).toBeGreaterThan(0)
			expect(party?.city.length).toBeGreaterThan(0)
			expect(party?.inn).toBe(inn)
		}
	})

	it('[I2] repeated calls return reference-equal record (deterministic)', async () => {
		const adapter = createMockDaData()
		const a = await adapter.findByInn('2320000001')
		const b = await adapter.findByInn('2320000001')
		expect(a).toBe(b)
	})
})
