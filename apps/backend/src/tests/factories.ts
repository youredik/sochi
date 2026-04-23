/**
 * Test data factories. Each produces a schema-valid input shape for a given
 * domain. Pattern: sensible defaults + `Partial<T>` overrides.
 *
 * Kent Beck: "Manually calculating the expected value forces me to think
 * through the problem 2 independent ways."
 *
 * Factories live here (not in each `*.repo.test.ts`) so integration tests
 * across domains (e.g. booking/availability) can compose fixtures without
 * re-implementing property/roomType/room setup every time.
 */
import type { PropertyCreateInput, RoomCreateInput, RoomTypeCreateInput } from '@horeca/shared'

export function aPropertyCreateInput(
	overrides: Partial<PropertyCreateInput> = {},
): PropertyCreateInput {
	return {
		name: 'Test Villa',
		address: 'Kurortny prospekt 1',
		city: 'Sochi',
		timezone: 'Europe/Moscow',
		...overrides,
	}
}

export function aRoomTypeCreateInput(
	overrides: Partial<RoomTypeCreateInput> = {},
): RoomTypeCreateInput {
	return {
		name: 'Standard Double',
		description: 'Queen bed, balcony',
		maxOccupancy: 2,
		baseBeds: 1,
		extraBeds: 1,
		areaSqm: 22,
		inventoryCount: 5,
		...overrides,
	}
}

export function aRoomCreateInput(
	roomTypeId: string,
	overrides: Partial<RoomCreateInput> = {},
): RoomCreateInput {
	return {
		roomTypeId,
		number: '101',
		floor: 1,
		...overrides,
	}
}
