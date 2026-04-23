import { create } from 'zustand'

/**
 * Setup wizard state — Zustand store, NOT TanStack-Query-backed because
 * it's UI-ephemeral (forgotten on page reload is fine and arguably
 * correct: a stale draft from a week ago re-appearing would confuse).
 *
 * Steps: property → roomType → rooms. Each step's draft lives here so
 * user can hit "Back" without losing what they typed. IDs of created
 * entities propagate forward (roomType needs `propertyId`, rooms need
 * `roomTypeId`).
 *
 * `reset()` nukes the whole draft on successful completion or if user
 * explicitly cancels. Not persisted to localStorage for the reason above.
 */

type WizardStep = 'property' | 'roomType' | 'rooms' | 'done'

interface WizardState {
	step: WizardStep
	propertyId: string | null
	roomTypeId: string | null
	roomsCreated: number
	goTo: (step: WizardStep) => void
	setPropertyId: (id: string) => void
	setRoomTypeId: (id: string) => void
	incRooms: (n?: number) => void
	reset: () => void
}

const INITIAL = {
	step: 'property' as WizardStep,
	propertyId: null,
	roomTypeId: null,
	roomsCreated: 0,
}

export const useWizardStore = create<WizardState>((set) => ({
	...INITIAL,
	goTo: (step) => set({ step }),
	setPropertyId: (id) => set({ propertyId: id, step: 'roomType' }),
	setRoomTypeId: (id) => set({ roomTypeId: id, step: 'rooms' }),
	incRooms: (n = 1) => set((s) => ({ roomsCreated: s.roomsCreated + n })),
	reset: () => set(INITIAL),
}))

/** Ordered steps for progress indicator rendering. */
export const WIZARD_STEPS: WizardStep[] = ['property', 'roomType', 'rooms', 'done']

export const STEP_LABELS: Record<WizardStep, string> = {
	property: 'Гостиница',
	roomType: 'Тип номеров',
	rooms: 'Номера',
	done: 'Готово',
}
