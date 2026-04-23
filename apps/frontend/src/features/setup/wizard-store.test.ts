import { beforeEach, describe, expect, it } from 'vitest'
import { useWizardStore } from './wizard-store'

/**
 * Strict tests for the wizard Zustand store — exact-value asserts,
 * adversarial transitions, ID propagation invariants.
 */
describe('wizard-store', () => {
	beforeEach(() => {
		useWizardStore.getState().reset()
	})

	describe('initial state (exact-value)', () => {
		it('starts on property step with no IDs, zero rooms, no rate plan', () => {
			const s = useWizardStore.getState()
			expect(s.step).toBe('property')
			expect(s.propertyId).toBeNull()
			expect(s.roomTypeId).toBeNull()
			expect(s.roomsCreated).toBe(0)
			expect(s.ratePlanId).toBeNull()
		})
	})

	describe('4-step flow (property → roomType → rooms → ratePlan → done)', () => {
		it('finishRooms from rooms step advances to ratePlan (not done)', () => {
			const store = useWizardStore.getState()
			store.setPropertyId('prop_x')
			store.setRoomTypeId('rmt_x', 1)
			store.incRooms()
			store.finishRooms()
			expect(useWizardStore.getState().step).toBe('ratePlan')
		})

		it('setRatePlanId advances to done + stores id', () => {
			const store = useWizardStore.getState()
			store.setPropertyId('prop_x')
			store.setRoomTypeId('rmt_x', 1)
			store.incRooms()
			store.finishRooms()
			store.setRatePlanId('rp_abc')
			const s = useWizardStore.getState()
			expect(s.ratePlanId).toBe('rp_abc')
			expect(s.step).toBe('done')
		})
	})

	describe('ID propagation + step auto-advance (invariant)', () => {
		it('setPropertyId advances to roomType step + stores id', () => {
			useWizardStore.getState().setPropertyId('prop_123')
			const s = useWizardStore.getState()
			expect(s.propertyId).toBe('prop_123')
			expect(s.step).toBe('roomType')
		})

		it('setRoomTypeId advances to rooms step + stores id + snapshots inventoryCount', () => {
			useWizardStore.getState().setPropertyId('prop_123')
			useWizardStore.getState().setRoomTypeId('rmt_456', 5)
			const s = useWizardStore.getState()
			expect(s.roomTypeId).toBe('rmt_456')
			expect(s.roomTypeInventoryCount).toBe(5)
			expect(s.step).toBe('rooms')
		})
	})

	describe('rooms counter', () => {
		it('incRooms default adds 1', () => {
			useWizardStore.getState().incRooms()
			expect(useWizardStore.getState().roomsCreated).toBe(1)
		})

		it('incRooms(n) adds n', () => {
			useWizardStore.getState().incRooms(5)
			expect(useWizardStore.getState().roomsCreated).toBe(5)
		})

		it('incRooms accumulates across calls', () => {
			useWizardStore.getState().incRooms(3)
			useWizardStore.getState().incRooms(2)
			expect(useWizardStore.getState().roomsCreated).toBe(5)
		})
	})

	describe('reset (adversarial)', () => {
		it('reset from ratePlan step nukes all progress back to property', () => {
			const store = useWizardStore.getState()
			store.setPropertyId('prop_abc')
			store.setRoomTypeId('rmt_def', 1)
			store.incRooms(7)
			store.finishRooms()
			store.setRatePlanId('rp_xyz')
			store.reset()
			const s = useWizardStore.getState()
			expect(s.step).toBe('property')
			expect(s.propertyId).toBeNull()
			expect(s.roomTypeId).toBeNull()
			expect(s.roomsCreated).toBe(0)
			expect(s.ratePlanId).toBeNull()
		})

		it('reset from done step also returns to property', () => {
			const store = useWizardStore.getState()
			store.setPropertyId('prop_abc')
			store.setRoomTypeId('rmt_def', 1)
			store.goTo('done')
			store.reset()
			expect(useWizardStore.getState().step).toBe('property')
		})
	})

	describe('goTo (manual override)', () => {
		it('can jump to arbitrary step without changing IDs', () => {
			const store = useWizardStore.getState()
			store.setPropertyId('prop_x')
			store.goTo('property') // user clicked "back"
			expect(useWizardStore.getState().step).toBe('property')
			expect(useWizardStore.getState().propertyId).toBe('prop_x')
		})
	})
})
