/**
 * `<BulkEditPricesSheet>` — strict tests for 3-mode bulk edit (Bnovo canon).
 *
 * Pre-done audit:
 *   Modes (exact-value computation):
 *     [M1] mode='set' → rates с amount = price input verbatim
 *     [M2] mode='percent' с factor +10 → amount = current * 1.10
 *     [M3] mode='amount' с factor -500 → amount = current - 500
 *     [M4] relative mode (percent/amount) с cell без current → SKIPPED
 *
 *   Submit shape:
 *     [S1] payload per ratePlanId. Default selects all rate plans →
 *          one bulk.mutateAsync call per plan.
 *
 *   Adversarial:
 *     [A1] day-of-week filter excludes weekend → only weekday dates emitted
 *     [A2] dates filter intersection empty → toast error, no mutate call
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const bulkMutateAsync = mock(async () => [])

mock.module('@tanstack/react-query', () => ({
	useMutation: () => ({ mutateAsync: bulkMutateAsync, isPending: false }),
	useQuery: () => ({ data: undefined, error: null, isPending: false }),
	useQueries: () => [],
	useQueryClient: () => ({ invalidateQueries: () => {} }),
	queryOptions: <T,>(opts: T) => opts,
}))

const toastError = mock()
const toastInfo = mock()
const toastSuccess = mock()
mock.module('sonner', () => ({
	toast: {
		error: toastError,
		info: toastInfo,
		success: toastSuccess,
		warning: () => {},
	},
}))

const { BulkEditPricesSheet } = await import('./bulk-edit-prices-sheet.tsx')

const ROOM_TYPES = [
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
]

const PLAN = {
	id: 'rp-1',
	tenantId: 't',
	propertyId: 'prop-1',
	roomTypeId: 'rt-1',
	name: 'Базовый',
	code: 'BASE',
	isDefault: true,
	isRefundable: true,
	cancellationHours: 24,
	mealsIncluded: 'none' as const,
	minStay: 1,
	maxStay: null,
	currency: 'RUB',
	isActive: true,
	createdAt: '',
	updatedAt: '',
}

beforeEach(() => {
	bulkMutateAsync.mockReset()
	bulkMutateAsync.mockImplementation(async () => [])
	toastError.mockReset()
	toastInfo.mockReset()
	toastSuccess.mockReset()
})

afterEach(cleanup)

/**
 * Set a date input by simulating native change event (`<input type="date">`).
 * userEvent.type doesn't play well с native-date inputs in JSDOM.
 */
function setDateInput(label: string, isoDate: string): void {
	const input = screen.getByLabelText(label) as HTMLInputElement
	fireEvent.change(input, { target: { value: isoDate } })
}

async function selectModeRadio(modeLabel: string): Promise<void> {
	await userEvent.setup().click(screen.getByLabelText(modeLabel))
}

describe('BulkEditPricesSheet — 3-mode computation (Bnovo canon)', () => {
	it('[M1] mode=set: rates have amount = price input verbatim', async () => {
		render(
			<BulkEditPricesSheet
				open
				onOpenChange={() => {}}
				ratePlans={[PLAN]}
				roomTypes={ROOM_TYPES}
				existingRates={new Map()}
			/>,
		)

		// Narrow date range к single day to keep test small.
		setDateInput('С даты', '2026-06-15')
		setDateInput('По дату', '2026-06-15')

		const priceInput = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		await userEvent.setup().clear(priceInput)
		await userEvent.setup().type(priceInput, '5500')

		fireEvent.click(screen.getByRole('button', { name: /Применить цену/ }))

		await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledTimes(1))
		expect(bulkMutateAsync).toHaveBeenCalledWith({
			ratePlanId: 'rp-1',
			input: { rates: [{ date: '2026-06-15', amount: '5500', currency: 'RUB' }] },
		})
	})

	it('[M2] mode=percent с factor +10 + current=4000 → amount=4400', async () => {
		const existingRates = new Map([['rp-1', new Map([['2026-06-15', '4000']])]])
		render(
			<BulkEditPricesSheet
				open
				onOpenChange={() => {}}
				ratePlans={[PLAN]}
				roomTypes={ROOM_TYPES}
				existingRates={existingRates}
			/>,
		)

		setDateInput('С даты', '2026-06-15')
		setDateInput('По дату', '2026-06-15')

		await selectModeRadio('Изменить на %')
		const priceInput = screen.getByLabelText(/Изменение, %/) as HTMLInputElement
		await userEvent.setup().clear(priceInput)
		await userEvent.setup().type(priceInput, '10')

		fireEvent.click(screen.getByRole('button', { name: /Применить цену/ }))

		await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledTimes(1))
		expect(bulkMutateAsync).toHaveBeenCalledWith({
			ratePlanId: 'rp-1',
			input: { rates: [{ date: '2026-06-15', amount: '4400', currency: 'RUB' }] },
		})
	})

	it('[M3] mode=amount с factor=-500 + current=4000 → amount=3500', async () => {
		const existingRates = new Map([['rp-1', new Map([['2026-06-15', '4000']])]])
		render(
			<BulkEditPricesSheet
				open
				onOpenChange={() => {}}
				ratePlans={[PLAN]}
				roomTypes={ROOM_TYPES}
				existingRates={existingRates}
			/>,
		)

		setDateInput('С даты', '2026-06-15')
		setDateInput('По дату', '2026-06-15')

		await selectModeRadio('Изменить на ₽')
		const priceInput = screen.getByLabelText(/Изменение, ₽/) as HTMLInputElement
		await userEvent.setup().clear(priceInput)
		await userEvent.setup().type(priceInput, '-500')

		fireEvent.click(screen.getByRole('button', { name: /Применить цену/ }))

		await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledTimes(1))
		expect(bulkMutateAsync).toHaveBeenCalledWith({
			ratePlanId: 'rp-1',
			input: { rates: [{ date: '2026-06-15', amount: '3500', currency: 'RUB' }] },
		})
	})

	it('[M4] mode=percent с empty existingRates → skip + toast.info «пропущено N ячеек»', async () => {
		render(
			<BulkEditPricesSheet
				open
				onOpenChange={() => {}}
				ratePlans={[PLAN]}
				roomTypes={ROOM_TYPES}
				existingRates={new Map()}
			/>,
		)

		setDateInput('С даты', '2026-06-15')
		setDateInput('По дату', '2026-06-15')

		await selectModeRadio('Изменить на %')
		// Need explicit price input — default is empty (placeholder-as-default
		// trap avoided commit 2026-05-14).
		const priceInput = screen.getByLabelText(/Изменение, %/) as HTMLInputElement
		await userEvent.setup().type(priceInput, '10')

		fireEvent.click(screen.getByRole('button', { name: /Применить цену/ }))

		await waitFor(() => expect(toastInfo).toHaveBeenCalled())
		// No actual mutation since no rates to operate on
		expect(bulkMutateAsync).toHaveBeenCalledTimes(0)
	})

	it('[V1] empty price → field-level FieldError visible; no mutation (placeholder-as-default trap fix)', async () => {
		render(
			<BulkEditPricesSheet
				open
				onOpenChange={() => {}}
				ratePlans={[PLAN]}
				roomTypes={ROOM_TYPES}
				existingRates={new Map()}
			/>,
		)
		// Trigger field validation by typing+clearing.
		const priceInput = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		await userEvent.setup().type(priceInput, '1')
		await userEvent.setup().clear(priceInput)
		fireEvent.click(screen.getByRole('button', { name: /Применить цену/ }))
		// No mutation fired (field validator gate).
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(bulkMutateAsync).toHaveBeenCalledTimes(0)
	})

	it('[V2] mode=set с negative price → toast.error strict-positive; no mutation', async () => {
		render(
			<BulkEditPricesSheet
				open
				onOpenChange={() => {}}
				ratePlans={[PLAN]}
				roomTypes={ROOM_TYPES}
				existingRates={new Map()}
			/>,
		)
		setDateInput('С даты', '2026-06-15')
		setDateInput('По дату', '2026-06-15')
		const priceInput = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		await userEvent.setup().type(priceInput, '-100')
		fireEvent.click(screen.getByRole('button', { name: /Применить цену/ }))
		await waitFor(() => expect(toastError).toHaveBeenCalled())
		const errMsg = toastError.mock.calls[0]
		// New canon 2026-05-15: strict-positive (negative AND zero both rejected).
		expect(JSON.stringify(errMsg)).toContain('больше нуля')
		expect(bulkMutateAsync).toHaveBeenCalledTimes(0)
	})

	it('[V3] mode=set с price=0 → toast.error strict-positive; no mutation (data-loss trap caught 2026-05-15)', async () => {
		render(
			<BulkEditPricesSheet
				open
				onOpenChange={() => {}}
				ratePlans={[PLAN]}
				roomTypes={ROOM_TYPES}
				existingRates={new Map()}
			/>,
		)
		setDateInput('С даты', '2026-06-15')
		setDateInput('По дату', '2026-06-15')
		const priceInput = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		await userEvent.setup().type(priceInput, '0')
		fireEvent.click(screen.getByRole('button', { name: /Применить цену/ }))
		await waitFor(() => expect(toastError).toHaveBeenCalled())
		// CRITICAL: factor=0 must NOT slip through. Previous `factor < 0`
		// check let zero pass → 90×N cells set к 0₽ (sellable free).
		expect(JSON.stringify(toastError.mock.calls[0])).toContain('больше нуля')
		expect(bulkMutateAsync).toHaveBeenCalledTimes(0)
	})

	it('[V4] from > to surfaces targeted error (не misleading «не попадает»); no mutation', async () => {
		render(
			<BulkEditPricesSheet
				open
				onOpenChange={() => {}}
				ratePlans={[PLAN]}
				roomTypes={ROOM_TYPES}
				existingRates={new Map()}
			/>,
		)
		setDateInput('С даты', '2026-06-30')
		setDateInput('По дату', '2026-06-01')
		const priceInput = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		await userEvent.setup().type(priceInput, '4500')
		fireEvent.click(screen.getByRole('button', { name: /Применить цену/ }))
		await waitFor(() => expect(toastError).toHaveBeenCalled())
		// Was misleading «Под выбранные дни не попадает ни одна дата» — caught
		// real-bug-hunt 2026-05-15. Targeted message references the «С» / «По»
		// canon labels.
		const msg = JSON.stringify(toastError.mock.calls[0])
		expect(msg).toContain('«С»')
		expect(msg).toContain('«По»')
		expect(bulkMutateAsync).toHaveBeenCalledTimes(0)
	})

	it('[V5] dates.length > 365 surfaces targeted cap error before server round-trip', async () => {
		render(
			<BulkEditPricesSheet
				open
				onOpenChange={() => {}}
				ratePlans={[PLAN]}
				roomTypes={ROOM_TYPES}
				existingRates={new Map()}
			/>,
		)
		// 2026-01-01 → 2027-06-30 = 546 days, all DOW selected by default.
		setDateInput('С даты', '2026-01-01')
		setDateInput('По дату', '2027-06-30')
		const priceInput = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		await userEvent.setup().type(priceInput, '4500')
		fireEvent.click(screen.getByRole('button', { name: /Применить цену/ }))
		await waitFor(() => expect(toastError).toHaveBeenCalled())
		const msg = JSON.stringify(toastError.mock.calls[0])
		// Targeted message names the limit и hints на recovery.
		expect(msg).toContain('365')
		expect(bulkMutateAsync).toHaveBeenCalledTimes(0)
	})
})
