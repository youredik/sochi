import { create } from 'zustand'
import type { DaDataParty } from './lib/dadata.ts'

/**
 * Setup wizard state — Zustand store backing the 2-screen onboarding flow.
 *
 * Screen 1 «identify» — user enters ИНН, DaData lookup populates `party`.
 * If DaData has no record OR the user wants to type freely, `manualOverride`
 * = true and the inventory step still works without a party.
 *
 * Screen 2 «inventory» — `rooms` count + `avgPriceRub` flow into the bulk
 * `/onboarding/inventory` POST. On success the wizard shell navigates to
 * the tenant grid, the orchestrator resets this store, and the user lands
 * in a fully-wired Шахматка in ≤90 seconds from signup.
 *
 * Not persisted to localStorage — a stale draft from a week ago re-
 * appearing would confuse far more than starting fresh costs.
 */

export type WizardStep = 'identify' | 'inventory' | 'done'

interface WizardState {
	step: WizardStep
	/** DaData lookup result, or `null` when not yet looked up. */
	party: DaDataParty | null
	/**
	 * True when user opted out of the DaData auto-fill (no result OR
	 * deliberate manual entry). Drives the inventory-step copy + lets the
	 * orchestrator know whether to trust the party fields or read user-
	 * edited form values. Phase 1 keeps it boolean; future may swap in
	 * a discriminated «source» union (`dadata` | `manual` | `edited`).
	 */
	manualOverride: boolean
	rooms: number
	avgPriceRub: number
	setStep: (step: WizardStep) => void
	setParty: (party: DaDataParty | null) => void
	setManualOverride: (v: boolean) => void
	setRooms: (n: number) => void
	setAvgPriceRub: (n: number) => void
	reset: () => void
}

const INITIAL: Pick<WizardState, 'step' | 'party' | 'manualOverride' | 'rooms' | 'avgPriceRub'> = {
	step: 'identify',
	party: null,
	manualOverride: false,
	rooms: 10,
	avgPriceRub: 3500,
}

export const useWizardStore = create<WizardState>((set) => ({
	...INITIAL,
	setStep: (step) => set({ step }),
	setParty: (party) => set({ party }),
	setManualOverride: (v) => set({ manualOverride: v }),
	setRooms: (n) => set({ rooms: n }),
	setAvgPriceRub: (n) => set({ avgPriceRub: n }),
	reset: () => set(INITIAL),
}))
