/**
 * `<RoomsBulkAddSheet>` — strict tests focused на the floor field bounds
 * (B5.bis 2026-05-15). The bulk-add sheet had no component test file
 * before this commit; the only coverage came from the parent
 * `inventory-rooms-page` integration. Per `[[strict_tests]]` canon —
 * exact-value + adversarial.
 *
 * Pre-done audit (this initial slice — focused on B5.bis scope, not full
 * form coverage — каждое поле полного покрытия waits для its own slice):
 *
 *   Render:
 *     [R1] mount calls render с roomType prop; floor field default '1';
 *          FieldError absent
 *
 *   Inline-bounds (B5.bis — floor mirrors server floorSchema -5..50):
 *     [B1] floor='1.5' (decimal — passes <input type=number>, fails regex)
 *          → «Целое число». NOTE: cannot test 'abc' because happy-dom
 *          coerces non-numeric input value к '' silently; that path is
 *          covered directly by helper test [E2] via `safeParse('abc')`.
 *     [B2] floor='-6' → «Не меньше -5»
 *     [B3] floor='51' → «Не больше 50»
 *     [B4] floor='' (cleared) → NO error («Если пусто — этаж не присваивается»)
 *     [B5] floor='50' (max boundary) → no error
 *
 * NOTE: startNumber/endNumber upper bound + cross-field refine (endNumber
 * ≥ startNumber, range ≤ 500) — separate backlog item.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const bulkMutateAsync = mock(async () => ({ created: [], failed: [] }))

mock.module('@tanstack/react-query', () => ({
	useMutation: () => ({ mutateAsync: bulkMutateAsync, isPending: false }),
	useQuery: () => ({ data: undefined, error: null, isPending: false }),
	useQueries: () => [],
	useQueryClient: () => ({ invalidateQueries: () => {} }),
	queryOptions: <T,>(opts: T) => opts,
}))

mock.module('sonner', () => ({
	toast: { success: () => {}, error: () => {}, warning: () => {} },
}))

const { RoomsBulkAddSheet } = await import('./rooms-bulk-add-sheet.tsx')

const ROOM_TYPE = {
	id: 'rt-1',
	tenantId: 't',
	propertyId: 'prop-1',
	name: 'Стандартный',
	description: null,
	maxOccupancy: 2,
	baseBeds: 1,
	extraBeds: 0,
	areaSqm: null,
	inventoryCount: 10,
	isActive: true,
	createdAt: '',
	updatedAt: '',
} as const

beforeEach(() => {
	bulkMutateAsync.mockReset()
	bulkMutateAsync.mockImplementation(async () => ({ created: [], failed: [] }))
})

afterEach(cleanup)

describe('RoomsBulkAddSheet — render', () => {
	it('[R1] mounts с roomType; floor default «1»; no FieldError на mount', () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		expect(screen.queryByText('Добавить номера в категорию «Стандартный»')).not.toBe(null)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		expect(floor.value).toBe('1')
		// No range error visible on initial render.
		expect(screen.queryByText('Не меньше -5')).toBe(null)
		expect(screen.queryByText('Не больше 50')).toBe(null)
	})
})

describe('RoomsBulkAddSheet — floor inline-bounds (B5.bis)', () => {
	it('[B1] floor=«1.5» (decimal — fails regex) surfaces «Целое число»', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		fireEvent.change(floor, { target: { value: '1.5' } })
		await waitFor(() => {
			expect(screen.queryByText('Целое число')).not.toBe(null)
		})
	})

	it('[B2] floor=-6 surfaces «Не меньше -5» (mirrors server min)', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		fireEvent.change(floor, { target: { value: '-6' } })
		await waitFor(() => {
			expect(screen.queryByText('Не меньше -5')).not.toBe(null)
		})
	})

	it('[B3] floor=51 surfaces «Не больше 50» (mirrors server max)', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		fireEvent.change(floor, { target: { value: '51' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 50')).not.toBe(null)
		})
	})

	it('[B4] floor cleared («») emits NO error — optional field semantic', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		// First introduce an error, then clear, ensure error gone.
		fireEvent.change(floor, { target: { value: '99' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 50')).not.toBe(null)
		})
		fireEvent.change(floor, { target: { value: '' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 50')).toBe(null)
		})
		expect(screen.queryByText('Целое число')).toBe(null)
		expect(screen.queryByText('Введите число')).toBe(null)
	})

	it('[B5] floor=50 (max boundary) — no error', async () => {
		render(
			<RoomsBulkAddSheet open onOpenChange={() => {}} propertyId="prop-1" roomType={ROOM_TYPE} />,
		)
		const floor = screen.getByLabelText('Этаж (необязательно)') as HTMLInputElement
		fireEvent.change(floor, { target: { value: '50' } })
		// Wait a tick to let validator run.
		await new Promise((r) => setTimeout(r, 20))
		expect(screen.queryByText('Не больше 50')).toBe(null)
		expect(screen.queryByText('Целое число')).toBe(null)
	})
})
