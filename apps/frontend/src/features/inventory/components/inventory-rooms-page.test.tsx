/**
 * `<InventoryRoomsPage>` — strict tests covering the read+create surface.
 *
 * Pre-done audit:
 *   [P1] Empty state — zero roomTypes → «У вас нет категорий» CTA visible
 *   [P2] Loaded state — renders 1 card per RoomType с правильным room-count
 *        + RU pluralization ('1 номер' / '2 номера' / '5 номеров')
 *   [P3] Click «+ Категория» → CategoryFormSheet opens (Sheet title visible)
 *   [P4] Click «+ Номера» on a category → BulkAdd sheet opens с category name
 *
 * Mocking strategy:
 *   - `useQuery` mocked at module scope so we can flip between empty / loaded
 *     states without standing up a full QueryClient + fetch chain.
 *   - `sonner.toast` — noop. Sheet drawers — render their own DOM, no extra mock.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const roomTypesData: unknown = { current: { data: [] as unknown, error: null, isPending: false } }
const roomsData: unknown = { current: { data: [] as unknown, error: null, isPending: false } }

mock.module('@tanstack/react-query', () => ({
	useQuery: (opts: { queryKey: readonly unknown[] }) => {
		const kind = (opts.queryKey[1] as string | undefined) ?? ''
		// biome-ignore lint/suspicious/noExplicitAny: test ref-pass-through
		if (kind === 'room-types') return (roomTypesData as any).current
		// biome-ignore lint/suspicious/noExplicitAny: test ref-pass-through
		if (kind === 'rooms') return (roomsData as any).current
		return { data: undefined, error: null, isPending: false }
	},
	useMutation: () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false }),
	useQueries: () => [],
	useQueryClient: () => ({ invalidateQueries: () => {} }),
	queryOptions: <T,>(opts: T) => opts,
}))

mock.module('sonner', () => ({
	toast: { success: () => {}, warning: () => {}, error: () => {} },
}))

const { InventoryRoomsPage } = await import('./inventory-rooms-page.tsx')

beforeEach(() => {
	// biome-ignore lint/suspicious/noExplicitAny: ref slot pattern
	;(roomTypesData as any).current = { data: [], error: null, isPending: false }
	// biome-ignore lint/suspicious/noExplicitAny: ref slot pattern
	;(roomsData as any).current = { data: [], error: null, isPending: false }
})

afterEach(cleanup)

describe('InventoryRoomsPage — render', () => {
	it('[P1] empty state — zero categories → «У вас нет категорий» CTA visible', () => {
		render(<InventoryRoomsPage propertyId="prop-1" />)
		expect(screen.queryByText(/У вас пока нет категорий номеров/)).not.toBe(null)
		const addCta = screen.getByRole('button', { name: /Категория/ })
		expect(addCta).not.toBe(null)
	})

	it('[P2] loaded — renders one card per RoomType с corrected RU plural counts', () => {
		// biome-ignore lint/suspicious/noExplicitAny: test seed
		;(roomTypesData as any).current = {
			data: [
				{
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
				},
				{
					id: 'rt-2',
					tenantId: 't',
					propertyId: 'prop-1',
					name: 'Полулюкс',
					description: null,
					maxOccupancy: 3,
					baseBeds: 2,
					extraBeds: 0,
					areaSqm: null,
					inventoryCount: 5,
					isActive: true,
					createdAt: '',
					updatedAt: '',
				},
			],
			error: null,
			isPending: false,
		}
		// biome-ignore lint/suspicious/noExplicitAny: test seed
		;(roomsData as any).current = {
			data: [
				...Array.from({ length: 10 }, (_, i) => ({
					id: `r-${i}`,
					tenantId: 't',
					propertyId: 'prop-1',
					roomTypeId: 'rt-1',
					number: String(101 + i),
					floor: 1,
					isActive: true,
					notes: null,
					createdAt: '',
					updatedAt: '',
				})),
				{
					id: 'r-x',
					tenantId: 't',
					propertyId: 'prop-1',
					roomTypeId: 'rt-2',
					number: '201',
					floor: 2,
					isActive: true,
					notes: null,
					createdAt: '',
					updatedAt: '',
				},
			],
			error: null,
			isPending: false,
		}

		render(<InventoryRoomsPage propertyId="prop-1" />)
		expect(screen.queryByText('Стандартный')).not.toBe(null)
		expect(screen.queryByText('Полулюкс')).not.toBe(null)
		// 10 → «10 номеров» (many); 1 → «1 номер» (one)
		expect(screen.queryByText(/10 номеров · до 2 гостей/)).not.toBe(null)
		expect(screen.queryByText(/1 номер · до 3 гостей/)).not.toBe(null)
	})

	it('[P3] click «+ Категория» → CategoryFormSheet opens', () => {
		render(<InventoryRoomsPage propertyId="prop-1" />)
		const addCategoryBtn = screen.getByRole('button', { name: /Категория/ })
		fireEvent.click(addCategoryBtn)
		// Sheet title surfaces (Radix portals it into document.body)
		expect(screen.queryByText('Новая категория номеров')).not.toBe(null)
	})

	it('[P4] click «+ Номера» on a category → BulkAdd sheet opens с category name', () => {
		// biome-ignore lint/suspicious/noExplicitAny: test seed
		;(roomTypesData as any).current = {
			data: [
				{
					id: 'rt-1',
					tenantId: 't',
					propertyId: 'prop-1',
					name: 'Полулюкс',
					description: null,
					maxOccupancy: 3,
					baseBeds: 2,
					extraBeds: 0,
					areaSqm: null,
					inventoryCount: 0,
					isActive: true,
					createdAt: '',
					updatedAt: '',
				},
			],
			error: null,
			isPending: false,
		}
		render(<InventoryRoomsPage propertyId="prop-1" />)
		const addRoomsBtn = screen.getByRole('button', {
			name: /Добавить номера в категорию «Полулюкс»/,
		})
		fireEvent.click(addRoomsBtn)
		expect(screen.queryByText(/Добавить номера в категорию «Полулюкс»/)).not.toBe(null)
	})
})
