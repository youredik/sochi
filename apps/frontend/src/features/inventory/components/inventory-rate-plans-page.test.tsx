/**
 * `<InventoryRatePlansPage>` — strict tests for Phase III read+create.
 *
 * Pre-done audit:
 *   [P1] No roomTypes → «Сначала создайте хотя бы одну категорию» empty state
 *        + «+ Тариф» CTA disabled (can't pick parent roomType).
 *   [P2] roomTypes present but no ratePlans → «У вас пока нет тарифов» CTA.
 *   [P3] ratePlans grouped by roomType heading; per-plan card shows code +
 *        refundable / non-refundable label + meals + minStay correctly.
 *   [P4] «+ Тариф» enabled when roomTypes present → opens RatePlanFormSheet
 *        (sheet title visible).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const roomTypesData: unknown = { current: { data: [] as unknown, error: null, isPending: false } }
const ratePlansData: unknown = { current: { data: [] as unknown, error: null, isPending: false } }

mock.module('@tanstack/react-query', () => ({
	useQuery: (opts: { queryKey: readonly unknown[] }) => {
		const kind = (opts.queryKey[1] as string | undefined) ?? ''
		// biome-ignore lint/suspicious/noExplicitAny: test ref-pass-through
		if (kind === 'room-types') return (roomTypesData as any).current
		// biome-ignore lint/suspicious/noExplicitAny: test ref-pass-through
		if (kind === 'rate-plans') return (ratePlansData as any).current
		return { data: undefined, error: null, isPending: false }
	},
	useMutation: () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false }),
	useQueries: () => [],
	useQueryClient: () => ({ invalidateQueries: () => {} }),
	queryOptions: <T,>(opts: T) => opts,
}))

mock.module('sonner', () => ({
	toast: { success: () => {}, error: () => {} },
}))

const { InventoryRatePlansPage } = await import('./inventory-rate-plans-page.tsx')

const STANDARD_RT = {
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
}

beforeEach(() => {
	// biome-ignore lint/suspicious/noExplicitAny: ref slot
	;(roomTypesData as any).current = { data: [], error: null, isPending: false }
	// biome-ignore lint/suspicious/noExplicitAny: ref slot
	;(ratePlansData as any).current = { data: [], error: null, isPending: false }
})

afterEach(cleanup)

describe('InventoryRatePlansPage — render', () => {
	it('[P1] no roomTypes → empty-state nudge + «+ Тариф» disabled', () => {
		render(<InventoryRatePlansPage propertyId="prop-1" />)
		expect(screen.queryByText(/Сначала создайте хотя бы одну категорию/)).not.toBe(null)
		const addBtn = screen.getByRole('button', { name: /Тариф/ }) as HTMLButtonElement
		expect(addBtn.disabled).toBe(true)
	})

	it('[P2] roomTypes present but zero ratePlans → «У вас пока нет тарифов»', () => {
		// biome-ignore lint/suspicious/noExplicitAny: seed
		;(roomTypesData as any).current = { data: [STANDARD_RT], error: null, isPending: false }
		render(<InventoryRatePlansPage propertyId="prop-1" />)
		expect(screen.queryByText(/У вас пока нет тарифов/)).not.toBe(null)
		const addBtn = screen.getByRole('button', { name: /Тариф/ }) as HTMLButtonElement
		expect(addBtn.disabled).toBe(false)
	})

	it('[P3] ratePlans render с group heading + code badge + refundable/meals/LOS label', () => {
		// biome-ignore lint/suspicious/noExplicitAny: seed
		;(roomTypesData as any).current = { data: [STANDARD_RT], error: null, isPending: false }
		// biome-ignore lint/suspicious/noExplicitAny: seed
		;(ratePlansData as any).current = {
			data: [
				{
					id: 'rp-1',
					tenantId: 't',
					propertyId: 'prop-1',
					roomTypeId: 'rt-1',
					name: 'Базовый',
					code: 'BASE',
					isDefault: true,
					isRefundable: true,
					cancellationHours: 24,
					mealsIncluded: 'breakfast',
					minStay: 1,
					maxStay: null,
					currency: 'RUB',
					isActive: true,
					createdAt: '',
					updatedAt: '',
				},
				{
					id: 'rp-2',
					tenantId: 't',
					propertyId: 'prop-1',
					roomTypeId: 'rt-1',
					name: 'Невозвратный -10%',
					code: 'NR-10',
					isDefault: false,
					isRefundable: false,
					cancellationHours: null,
					mealsIncluded: 'none',
					minStay: 2,
					maxStay: null,
					currency: 'RUB',
					isActive: true,
					createdAt: '',
					updatedAt: '',
				},
			],
			error: null,
			isPending: false,
		}
		render(<InventoryRatePlansPage propertyId="prop-1" />)
		expect(screen.queryByText('Стандартный')).not.toBe(null)
		expect(screen.queryByText('Базовый')).not.toBe(null)
		expect(screen.queryByText('BASE')).not.toBe(null)
		expect(screen.queryByText(/Возврат за 24 ч · Завтрак · от 1 ночи/)).not.toBe(null)
		expect(screen.queryByText('Невозвратный -10%')).not.toBe(null)
		expect(screen.queryByText('NR-10')).not.toBe(null)
		expect(screen.queryByText(/Невозвратный · Без питания · от 2 ночей/)).not.toBe(null)
		expect(screen.queryByText('По умолчанию')).not.toBe(null)
	})

	it('[P4] «+ Тариф» с роумтайпами → opens RatePlanFormSheet', () => {
		// biome-ignore lint/suspicious/noExplicitAny: seed
		;(roomTypesData as any).current = { data: [STANDARD_RT], error: null, isPending: false }
		render(<InventoryRatePlansPage propertyId="prop-1" />)
		const addBtn = screen.getByRole('button', { name: /Тариф/ })
		fireEvent.click(addBtn)
		expect(screen.queryByText('Новый тариф')).not.toBe(null)
	})
})
