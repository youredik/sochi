/**
 * `<InventoryPricesPage>` — strict tests Phase IV read + bulk-edit trigger.
 *
 * Pre-done audit:
 *   [P1] Zero ratePlans → empty-state nudge + «Изменить цены» disabled
 *   [P2] ratePlans + rates → grid renders с date column + price cells; missing
 *        rates render «—»
 *   [P3] Click «Изменить цены» → BulkEditPricesSheet opens (sheet legend +
 *        submit button visible)
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const roomTypesData: unknown = { current: { data: [] as unknown, error: null, isPending: false } }
const ratePlansData: unknown = { current: { data: [] as unknown, error: null, isPending: false } }
const ratesData: unknown = { current: [] as unknown }

await mock.module('@tanstack/react-query', () => ({
	useQuery: (opts: { queryKey: readonly unknown[] }) => {
		const kind = (opts.queryKey[1] as string | undefined) ?? ''
		// biome-ignore lint/suspicious/noExplicitAny: ref slot
		if (kind === 'room-types') return (roomTypesData as any).current
		// biome-ignore lint/suspicious/noExplicitAny: ref slot
		if (kind === 'rate-plans') return (ratePlansData as any).current
		return { data: undefined, error: null, isPending: false }
	},
	useQueries: () => {
		// biome-ignore lint/suspicious/noExplicitAny: ref slot
		return (ratesData as any).current
	},
	useMutation: () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false }),
	useQueryClient: () => ({ invalidateQueries: () => {} }),
	queryOptions: <T,>(opts: T) => opts,
}))

await mock.module('sonner', () => ({
	toast: { success: () => {}, warning: () => {}, error: () => {} },
}))

const { InventoryPricesPage } = await import('./inventory-prices-page.tsx')

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
const BASE_PLAN = {
	id: 'rp-1',
	tenantId: 't',
	propertyId: 'prop-1',
	roomTypeId: 'rt-1',
	name: 'Базовый',
	code: 'BASE',
	isDefault: true,
	isRefundable: true,
	cancellationHours: 24,
	mealsIncluded: 'none',
	minStay: 1,
	maxStay: null,
	currency: 'RUB',
	isActive: true,
	createdAt: '',
	updatedAt: '',
}

beforeEach(() => {
	// biome-ignore lint/suspicious/noExplicitAny: seed
	;(roomTypesData as any).current = { data: [STANDARD_RT], error: null, isPending: false }
	// biome-ignore lint/suspicious/noExplicitAny: seed
	;(ratePlansData as any).current = { data: [], error: null, isPending: false }
	// biome-ignore lint/suspicious/noExplicitAny: seed
	;(ratesData as any).current = []
})

afterEach(cleanup)

function isoForOffset(today: Date, offset: number): string {
	const d = new Date(today)
	d.setDate(d.getDate() + offset)
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}

describe('InventoryPricesPage — render', () => {
	it('[P1] zero ratePlans → empty-state + «Изменить цены» disabled', () => {
		// biome-ignore lint/suspicious/noExplicitAny: seed
		;(ratePlansData as any).current = { data: [], error: null, isPending: false }
		render(<InventoryPricesPage propertyId="prop-1" />)
		expect(screen.queryByText(/Сначала создайте хотя бы один тариф/)).not.toBe(null)
		const btn = screen.getByRole('button', { name: /Изменить цены/ }) as HTMLButtonElement
		expect(btn.disabled).toBe(true)
	})

	it('[P2] ratePlans + rates render grid + price cells + «—» for missing', () => {
		// biome-ignore lint/suspicious/noExplicitAny: seed
		;(ratePlansData as any).current = { data: [BASE_PLAN], error: null, isPending: false }
		const today = new Date()
		today.setHours(0, 0, 0, 0)
		const iso0 = isoForOffset(today, 0)
		// biome-ignore lint/suspicious/noExplicitAny: seed
		;(ratesData as any).current = [
			{
				data: [
					{
						tenantId: 't',
						propertyId: 'prop-1',
						roomTypeId: 'rt-1',
						ratePlanId: 'rp-1',
						date: iso0,
						amount: '4500',
						currency: 'RUB',
						createdAt: '',
						updatedAt: '',
					},
				],
				error: null,
				isPending: false,
			},
		]

		render(<InventoryPricesPage propertyId="prop-1" />)
		expect(screen.queryByText('BASE')).not.toBe(null)
		expect(screen.queryByText('Стандартный')).not.toBe(null)
		// Today price renders с ru-RU Intl. NBSP (U+00A0) between thousands +
		// before ₽. Match via textContent predicate (flexible whitespace).
		const matches = screen.queryAllByText((_t, node) => {
			const text = node?.textContent ?? ''
			return /4\s?500/.test(text) && text.includes('₽')
		})
		expect(matches.length).toBeGreaterThan(0)
		// At least one «—» cell appears (88 other future days have no rates).
		const dashes = screen.queryAllByText('—')
		expect(dashes.length).toBeGreaterThan(0)
	})

	it('[P3] click «Изменить цены» → BulkEditPricesSheet opens', () => {
		// biome-ignore lint/suspicious/noExplicitAny: seed
		;(ratePlansData as any).current = { data: [BASE_PLAN], error: null, isPending: false }
		// biome-ignore lint/suspicious/noExplicitAny: seed
		;(ratesData as any).current = [{ data: [], error: null, isPending: false }]
		render(<InventoryPricesPage propertyId="prop-1" />)
		const btn = screen.getByRole('button', { name: /Изменить цены/ })
		fireEvent.click(btn)
		// Sheet-specific content: legend + submit button.
		expect(screen.queryByText('Дни недели')).not.toBe(null)
		expect(screen.queryByRole('button', { name: /Применить цену/ })).not.toBe(null)
	})
})
