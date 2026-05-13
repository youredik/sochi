/**
 * useWizardStore — strict unit tests.
 *
 * Pre-done audit:
 *   [I1] initial state: step='identify', party=null, manualOverride=false,
 *        rooms=10, avgPriceRub=3500 (Сочи-SMB-friendly defaults)
 *   [S1] setStep('inventory') transitions cleanly without touching other fields
 *   [S2] setParty(party) populates party
 *   [S3] setManualOverride(true) flips the flag
 *   [S4] setRooms / setAvgPriceRub mutate only the targeted field
 *   [R1] reset() returns to INITIAL regardless of intermediate state
 *   [R2] reset() after a full happy-path leaves NO residual state
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { DaDataParty } from './lib/dadata.ts'
import { useWizardStore } from './wizard-store.ts'

const PARTY: DaDataParty = {
	inn: '2320000001',
	ogrn: '1232300000001',
	name: 'ООО «Демо-Сириус»',
	legalForm: 'LEGAL',
	address: '354340, г. Сочи, Имеретинская низменность, д. 1',
	city: 'Сочи',
	taxRegime: 'USN_DOHODY',
	status: 'ACTIVE',
}

afterEach(() => {
	useWizardStore.getState().reset()
})

describe('useWizardStore — initial state', () => {
	it('[I1] starts on identify with party=null, manualOverride=false, rooms=10, avgPriceRub=3500', () => {
		const s = useWizardStore.getState()
		expect(s.step).toBe('identify')
		expect(s.party).toBe(null)
		expect(s.manualOverride).toBe(false)
		expect(s.rooms).toBe(10)
		expect(s.avgPriceRub).toBe(3500)
	})
})

describe('useWizardStore — setters', () => {
	it('[S1] setStep transitions step without touching other fields', () => {
		useWizardStore.getState().setStep('inventory')
		const s = useWizardStore.getState()
		expect(s.step).toBe('inventory')
		expect(s.party).toBe(null)
		expect(s.manualOverride).toBe(false)
		expect(s.rooms).toBe(10)
	})

	it('[S2] setParty populates the party reference', () => {
		useWizardStore.getState().setParty(PARTY)
		expect(useWizardStore.getState().party).toBe(PARTY)
	})

	it('[S3] setManualOverride flips the flag', () => {
		useWizardStore.getState().setManualOverride(true)
		expect(useWizardStore.getState().manualOverride).toBe(true)
		useWizardStore.getState().setManualOverride(false)
		expect(useWizardStore.getState().manualOverride).toBe(false)
	})

	it('[S4] setRooms / setAvgPriceRub mutate only the targeted field', () => {
		useWizardStore.getState().setRooms(50)
		useWizardStore.getState().setAvgPriceRub(7500)
		const s = useWizardStore.getState()
		expect(s.rooms).toBe(50)
		expect(s.avgPriceRub).toBe(7500)
		expect(s.step).toBe('identify')
		expect(s.party).toBe(null)
	})
})

describe('useWizardStore — reset', () => {
	it('[R1] reset() returns to INITIAL regardless of intermediate state', () => {
		const api = useWizardStore.getState()
		api.setStep('inventory')
		api.setParty(PARTY)
		api.setManualOverride(true)
		api.setRooms(42)
		api.setAvgPriceRub(99_999)
		api.reset()
		const s = useWizardStore.getState()
		expect(s.step).toBe('identify')
		expect(s.party).toBe(null)
		expect(s.manualOverride).toBe(false)
		expect(s.rooms).toBe(10)
		expect(s.avgPriceRub).toBe(3500)
	})

	it('[R2] reset() leaves no residual: setters re-applied land on INITIAL', () => {
		const api = useWizardStore.getState()
		api.setStep('inventory')
		api.reset()
		api.setRooms(1)
		expect(useWizardStore.getState().step).toBe('identify')
		expect(useWizardStore.getState().rooms).toBe(1)
	})
})
