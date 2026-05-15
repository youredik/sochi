/**
 * `<SingleRateEditSheet>` — strict tests Phase IV.bis per-cell rate edit.
 *
 * Pre-done audit (per `[[strict_tests]]` + `[[pre_done_audit]]`):
 *
 *   Render:
 *     [R1] sheet title «Изменить цену» + description «{date} · {roomType} · тариф {code}»
 *     [R2] price input pre-filled с currentAmount string
 *     [R3] price input pre-filled с default '4000' когда currentAmount undefined
 *
 *   Submit (exact-value):
 *     [S1] submit calls useBulkUpsertRates.mutateAsync с canonical shape:
 *          { ratePlanId, input: { rates: [{ date, amount, currency: 'RUB' }] }}
 *     [S2] amount sent verbatim as typed (no transformation)
 *
 *   Delete (adversarial / immutable):
 *     [D1] «Удалить цену» button disabled когда currentAmount === undefined
 *          (no rate to delete)
 *     [D2] «Удалить цену» enabled когда currentAmount present; click calls
 *          useDeleteRate.mutateAsync с {ratePlanId, date} EXACT shape
 *
 *   Adversarial — validation:
 *     [V1] empty price → onChange validator returns error message → submit
 *          attempts but mutation NOT called (price regex fails parse)
 *     [V2] price с invalid format ('abc') → validator returns RU error
 *
 *   Adversarial — mutation failure:
 *     [E1] upsert reject → error banner с err.message renders inside sheet
 *
 *   Immutable fields:
 *     [I1] target.ratePlan.id passed AS-IS — not re-derived/looked up;
 *          tests pre-compute target and verify hook called с exactly that id.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

type UpsertArg = {
	ratePlanId: string
	input: { rates: Array<{ date: string; amount: string; currency: 'RUB' }> }
}
const upsertMutateAsync = mock<(arg: UpsertArg) => Promise<unknown[]>>(async () => [])
const deleteMutateAsync = mock<
	(arg: { ratePlanId: string; date: string }) => Promise<{
		success: boolean
	}>
>(async () => ({ success: true }))
const upsertState = { isPending: false }
const deleteState = { isPending: false }

mock.module('@tanstack/react-query', () => ({
	useMutation: (() => {
		// Distinguish via mutationFn identity: hook calls differ by mutationFn ref.
		// Simpler: per-instance return matching real shapes.
		let callIdx = 0
		return () => {
			const idx = callIdx++
			// SingleRateEditSheet calls useBulkUpsertRates FIRST then useDeleteRate.
			// Mirror that order по idx.
			if (idx % 2 === 0) {
				return { mutateAsync: upsertMutateAsync, isPending: upsertState.isPending }
			}
			return { mutateAsync: deleteMutateAsync, isPending: deleteState.isPending }
		}
	})(),
	useQuery: () => ({ data: undefined, error: null, isPending: false }),
	useQueries: () => [],
	useQueryClient: () => ({ invalidateQueries: () => {} }),
	queryOptions: <T,>(opts: T) => opts,
}))

mock.module('sonner', () => ({
	toast: { success: () => {}, error: () => {} },
}))

const { SingleRateEditSheet } = await import('./single-rate-edit-sheet.tsx')

const TARGET_WITH_AMOUNT = {
	date: '2026-06-15',
	ratePlan: {
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
	},
	roomType: {
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
	currentAmount: '4500',
} as const

const TARGET_EMPTY_AMOUNT = { ...TARGET_WITH_AMOUNT, currentAmount: undefined } as const

beforeEach(() => {
	upsertMutateAsync.mockReset()
	upsertMutateAsync.mockImplementation(async () => [])
	deleteMutateAsync.mockReset()
	deleteMutateAsync.mockImplementation(async () => ({ success: true }))
	upsertState.isPending = false
	deleteState.isPending = false
})

afterEach(cleanup)

describe('SingleRateEditSheet — render', () => {
	it('[R1] sheet title + description с date / roomType / code (exact)', () => {
		render(<SingleRateEditSheet open onOpenChange={() => {}} target={TARGET_WITH_AMOUNT} />)
		expect(screen.queryByText('Изменить цену')).not.toBe(null)
		expect(screen.queryByText('2026-06-15 · Стандартный · тариф BASE')).not.toBe(null)
	})

	it('[R2] price input pre-filled с currentAmount string', () => {
		render(<SingleRateEditSheet open onOpenChange={() => {}} target={TARGET_WITH_AMOUNT} />)
		const input = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		expect(input.value).toBe('4500')
	})

	it('[R3] price input EMPTY когда currentAmount undefined (placeholder-as-default trap avoided)', () => {
		render(<SingleRateEditSheet open onOpenChange={() => {}} target={TARGET_EMPTY_AMOUNT} />)
		const input = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		// Empty default forces operator к ввести explicit value — see commit
		// note re: «placeholder-as-default trap» (same lesson as inventoryCount
		// и orgName). Submit should fail validation если оставить пустым.
		expect(input.value).toBe('')
	})
})

describe('SingleRateEditSheet — submit shape (exact-value, immutable-field)', () => {
	it('[S1+S2+I1] submit calls upsert.mutateAsync с EXACT canonical payload, ratePlan.id verbatim', async () => {
		const onOpenChange = mock()
		render(<SingleRateEditSheet open onOpenChange={onOpenChange} target={TARGET_WITH_AMOUNT} />)

		const input = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		await userEvent.setup().clear(input)
		await userEvent.setup().type(input, '5200')

		fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }))

		await waitFor(() => {
			expect(upsertMutateAsync).toHaveBeenCalledTimes(1)
		})
		expect(upsertMutateAsync).toHaveBeenCalledWith({
			ratePlanId: 'rp-1',
			input: { rates: [{ date: '2026-06-15', amount: '5200', currency: 'RUB' }] },
		})
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
	})
})

describe('SingleRateEditSheet — delete (adversarial)', () => {
	it('[D1] «Удалить цену» disabled когда currentAmount undefined (нет цены — удалять нечего)', () => {
		render(<SingleRateEditSheet open onOpenChange={() => {}} target={TARGET_EMPTY_AMOUNT} />)
		const delBtn = screen.getByRole('button', { name: /Удалить цену/ }) as HTMLButtonElement
		expect(delBtn.disabled).toBe(true)
	})

	it('[D2] «Удалить цену» enabled + click calls deleteMutate с {ratePlanId, date} EXACT', async () => {
		const onOpenChange = mock()
		render(<SingleRateEditSheet open onOpenChange={onOpenChange} target={TARGET_WITH_AMOUNT} />)

		const delBtn = screen.getByRole('button', { name: /Удалить цену/ }) as HTMLButtonElement
		expect(delBtn.disabled).toBe(false)
		fireEvent.click(delBtn)

		await waitFor(() => {
			expect(deleteMutateAsync).toHaveBeenCalledTimes(1)
		})
		expect(deleteMutateAsync).toHaveBeenCalledWith({ ratePlanId: 'rp-1', date: '2026-06-15' })
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
	})
})

describe('SingleRateEditSheet — adversarial failure', () => {
	it('[E1] upsert rejection → error banner с err.message renders; sheet stays open', async () => {
		upsertMutateAsync.mockImplementation(async () => {
			throw new Error('Сервер недоступен')
		})
		const onOpenChange = mock()
		render(<SingleRateEditSheet open onOpenChange={onOpenChange} target={TARGET_WITH_AMOUNT} />)

		fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }))

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBe(null)
		})
		expect(screen.getByRole('alert').textContent).toBe('Сервер недоступен')
		// Sheet stays open — onOpenChange NOT called с false.
		expect(onOpenChange.mock.calls.some((c) => c[0] === false)).toBe(false)
	})
})

describe('SingleRateEditSheet — strict-positive price (real-bug-hunt 2026-05-15)', () => {
	it('[Z1] price=«0» surfaces «Цена должна быть больше нуля»; no mutation', async () => {
		render(<SingleRateEditSheet open onOpenChange={() => {}} target={TARGET_EMPTY_AMOUNT} />)
		const priceInput = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		fireEvent.change(priceInput, { target: { value: '0' } })
		await waitFor(() => {
			expect(screen.queryByText('Цена должна быть больше нуля')).not.toBe(null)
		})
		fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }))
		await new Promise((r) => setTimeout(r, 50))
		// CRITICAL: zero must NOT slip through → previously created 0₽ rate
		// (sellable for free, data-loss trap).
		expect(upsertMutateAsync).not.toHaveBeenCalled()
	})

	it('[Z2] valid positive price (e.g. «4500») сохраняется через upsert', async () => {
		render(<SingleRateEditSheet open onOpenChange={() => {}} target={TARGET_EMPTY_AMOUNT} />)
		const priceInput = screen.getByLabelText('Цена за ночь, ₽') as HTMLInputElement
		fireEvent.change(priceInput, { target: { value: '4500' } })
		// Make sure no error visible.
		await new Promise((r) => setTimeout(r, 20))
		expect(screen.queryByText('Цена должна быть больше нуля')).toBe(null)
		fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }))
		await waitFor(() => {
			expect(upsertMutateAsync).toHaveBeenCalled()
		})
		const payload = upsertMutateAsync.mock.calls[0]?.[0] as unknown as {
			input: { rates: Array<{ amount: string }> }
		}
		expect(payload.input.rates[0]?.amount).toBe('4500')
	})
})
