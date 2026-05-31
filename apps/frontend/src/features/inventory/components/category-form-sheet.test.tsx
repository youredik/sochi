/**
 * `<CategoryFormSheet>` — strict adversarial + immutable-field tests.
 *
 * Pre-done audit (per `[[strict_tests]]`):
 *
 *   Render:
 *     [R1] create mode (no existing): title «Новая категория номеров»;
 *          button label «Создать категорию»
 *     [R2] edit mode: title «Изменить «<name>»»; button «Сохранить»;
 *          prefilled values (name + maxOccupancy + baseBeds)
 *     [R3] inventoryCount field NOT visible (admin canon — derived from
 *          actual Room count, not stored value)
 *
 *   Submit shape (exact-value + immutable-field):
 *     [S1] create submit calls useCreateRoomType.mutateAsync с EXACT payload:
 *          { name, description=undefined, maxOccupancy, baseBeds, extraBeds:0,
 *            inventoryCount:0 (default — admin doesn't pass count) }
 *     [S2] edit submit calls useUpdateRoomType.mutateAsync с { id, patch }
 *          where patch preserves existing.extraBeds и existing.inventoryCount
 *          (immutable-field canon — admin can't accidentally zero them)
 *     [S3] name trimmed (whitespace stripped); description omitted (undefined)
 *          when empty
 *
 *   Adversarial:
 *     [A1] mutation rejection → error banner с err.message; sheet stays open
 *     [A2] invalid maxOccupancy = '0' → validator error rendered;
 *          BUT button still clickable (form-level validation, не attr disable —
 *          submit path errors instead)
 *
 *   Inline-bounds (B5 — `[[no-half-measures]]`, Zod refine mirrors server):
 *     [B1] maxOccupancy='0' → «Не меньше 1» FieldError visible
 *     [B2] maxOccupancy='21' → «Не больше 20» FieldError visible (out-of-range
 *          previously passed client and crashed at server with 400)
 *     [B3] baseBeds='-5' → «Не меньше 1» (regex permits leading minus to
 *          surface precise message)
 *     [B4] baseBeds='11' → «Не больше 10»
 *     [B5] out-of-range value submit → createMutateAsync NOT called (validator
 *          gates submission; no silent server round-trip)
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const createMutateAsync = mock(async () => ({}))
const updateMutateAsync = mock(async () => ({}))
const createState = { isPending: false }
const updateState = { isPending: false }

await mock.module('@tanstack/react-query', () => ({
	useMutation: (() => {
		let callIdx = 0
		return () => {
			const idx = callIdx++
			// CategoryFormSheet calls useCreateRoomType THEN useUpdateRoomType.
			if (idx % 2 === 0) {
				return { mutateAsync: createMutateAsync, isPending: createState.isPending }
			}
			return { mutateAsync: updateMutateAsync, isPending: updateState.isPending }
		}
	})(),
	useQuery: () => ({ data: undefined, error: null, isPending: false }),
	useQueries: () => [],
	useQueryClient: () => ({ invalidateQueries: () => {} }),
	queryOptions: <T,>(opts: T) => opts,
}))

await mock.module('sonner', () => ({
	toast: { success: () => {}, error: () => {} },
}))

const { CategoryFormSheet } = await import('./category-form-sheet.tsx')

const EXISTING_RT = {
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
	createMutateAsync.mockReset()
	createMutateAsync.mockImplementation(async () => ({}))
	updateMutateAsync.mockReset()
	updateMutateAsync.mockImplementation(async () => ({}))
	createState.isPending = false
	updateState.isPending = false
})

afterEach(cleanup)

describe('CategoryFormSheet — render', () => {
	it('[R1] create mode (no existing): title «Новая категория номеров» + button «Создать категорию»', () => {
		render(<CategoryFormSheet open onOpenChange={() => {}} propertyId="prop-1" />)
		expect(screen.queryByText('Новая категория номеров')).not.toBe(null)
		expect(screen.queryByRole('button', { name: /Создать категорию/ })).not.toBe(null)
	})

	it('[R2] edit mode: title с name + button «Сохранить» + prefilled name', () => {
		render(
			<CategoryFormSheet open onOpenChange={() => {}} propertyId="prop-1" existing={EXISTING_RT} />,
		)
		expect(screen.queryByText('Изменить «Стандартный»')).not.toBe(null)
		expect(screen.queryByRole('button', { name: /Сохранить/ })).not.toBe(null)
		const nameInput = screen.getByLabelText('Название категории') as HTMLInputElement
		expect(nameInput.value).toBe('Стандартный')
		const occInput = screen.getByLabelText('Гостей') as HTMLInputElement
		expect(occInput.value).toBe('2')
	})

	it('[R3] inventoryCount field hidden (admin canon — derived from Room count)', () => {
		render(<CategoryFormSheet open onOpenChange={() => {}} propertyId="prop-1" />)
		expect(screen.queryByLabelText('Сколько номеров')).toBe(null)
	})
})

describe('CategoryFormSheet — submit shape (exact-value + immutable)', () => {
	it('[S1] create submit: EXACT payload includes inventoryCount=0 (default for admin), extraBeds=0', async () => {
		const onOpenChange = mock()
		render(<CategoryFormSheet open onOpenChange={onOpenChange} propertyId="prop-1" />)

		const nameInput = screen.getByLabelText('Название категории')
		await userEvent.setup().type(nameInput, 'Полулюкс')

		fireEvent.click(screen.getByRole('button', { name: /Создать категорию/ }))

		await waitFor(() => {
			expect(createMutateAsync).toHaveBeenCalledTimes(1)
		})
		expect(createMutateAsync).toHaveBeenCalledWith({
			name: 'Полулюкс',
			description: undefined,
			maxOccupancy: 2,
			baseBeds: 1,
			extraBeds: 0,
			inventoryCount: 0,
		})
	})

	it('[S2] edit submit: patch preserves existing.extraBeds AND existing.inventoryCount (immutable от admin UI)', async () => {
		const onOpenChange = mock()
		const existing = { ...EXISTING_RT, extraBeds: 1, inventoryCount: 10 }
		render(
			<CategoryFormSheet
				open
				onOpenChange={onOpenChange}
				propertyId="prop-1"
				existing={existing}
			/>,
		)

		const nameInput = screen.getByLabelText('Название категории') as HTMLInputElement
		await userEvent.setup().clear(nameInput)
		await userEvent.setup().type(nameInput, 'Стандартный Plus')

		fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }))

		await waitFor(() => {
			expect(updateMutateAsync).toHaveBeenCalledTimes(1)
		})
		// extraBeds + inventoryCount preserved from existing — not zeroed by form
		expect(updateMutateAsync).toHaveBeenCalledWith({
			id: 'rt-1',
			patch: {
				name: 'Стандартный Plus',
				description: undefined,
				maxOccupancy: 2,
				baseBeds: 1,
				extraBeds: 1,
				inventoryCount: 10,
			},
		})
	})

	it('[S3] name trimmed; empty description sent as undefined (not empty string)', async () => {
		render(<CategoryFormSheet open onOpenChange={() => {}} propertyId="prop-1" />)
		const nameInput = screen.getByLabelText('Название категории')
		await userEvent.setup().type(nameInput, '  Сюит  ')

		fireEvent.click(screen.getByRole('button', { name: /Создать категорию/ }))

		await waitFor(() => {
			expect(createMutateAsync).toHaveBeenCalledTimes(1)
		})
		expect(createMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'Сюит',
				description: undefined,
			}),
		)
	})
})

describe('CategoryFormSheet — adversarial', () => {
	it('[A1] mutation rejection → error banner с message; sheet stays open', async () => {
		createMutateAsync.mockImplementation(async () => {
			throw new Error('HTTP 409 conflict')
		})
		const onOpenChange = mock()
		render(<CategoryFormSheet open onOpenChange={onOpenChange} propertyId="prop-1" />)

		const nameInput = screen.getByLabelText('Название категории')
		await userEvent.setup().type(nameInput, 'X')

		fireEvent.click(screen.getByRole('button', { name: /Создать категорию/ }))

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBe(null)
		})
		expect(screen.getByRole('alert').textContent).toBe('HTTP 409 conflict')
		// Sheet stays open — onOpenChange NOT called с false
		expect(onOpenChange.mock.calls.some((c) => c[0] === false)).toBe(false)
	})
})

describe('CategoryFormSheet — inline-bounds (B5)', () => {
	it('[B1] maxOccupancy=0 surfaces «Не меньше 1»', async () => {
		render(<CategoryFormSheet open onOpenChange={() => {}} propertyId="prop-1" />)
		const occ = screen.getByLabelText('Гостей') as HTMLInputElement
		fireEvent.change(occ, { target: { value: '0' } })
		await waitFor(() => {
			expect(screen.queryByText('Не меньше 1')).not.toBe(null)
		})
	})

	it('[B2] maxOccupancy=21 surfaces «Не больше 20» (server bound max)', async () => {
		render(<CategoryFormSheet open onOpenChange={() => {}} propertyId="prop-1" />)
		const occ = screen.getByLabelText('Гостей') as HTMLInputElement
		fireEvent.change(occ, { target: { value: '21' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 20')).not.toBe(null)
		})
	})

	it('[B3] baseBeds=-5 surfaces «Не меньше 1» (negative integer parsed → range message)', async () => {
		render(<CategoryFormSheet open onOpenChange={() => {}} propertyId="prop-1" />)
		const beds = screen.getByLabelText('Кроватей') as HTMLInputElement
		fireEvent.change(beds, { target: { value: '-5' } })
		await waitFor(() => {
			expect(screen.queryByText('Не меньше 1')).not.toBe(null)
		})
	})

	it('[B4] baseBeds=11 surfaces «Не больше 10»', async () => {
		render(<CategoryFormSheet open onOpenChange={() => {}} propertyId="prop-1" />)
		const beds = screen.getByLabelText('Кроватей') as HTMLInputElement
		fireEvent.change(beds, { target: { value: '11' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 10')).not.toBe(null)
		})
	})

	it('[B5] out-of-range submit attempt blocks mutation (no silent server round-trip)', async () => {
		render(<CategoryFormSheet open onOpenChange={() => {}} propertyId="prop-1" />)
		const nameInput = screen.getByLabelText('Название категории')
		await userEvent.setup().type(nameInput, 'Бракованный')
		const occ = screen.getByLabelText('Гостей') as HTMLInputElement
		fireEvent.change(occ, { target: { value: '999' } })

		await waitFor(() => {
			expect(screen.queryByText('Не больше 20')).not.toBe(null)
		})

		fireEvent.click(screen.getByRole('button', { name: /Создать категорию/ }))

		// Wait long enough for any submit path to fire if it were going to.
		await new Promise((r) => setTimeout(r, 50))
		expect(createMutateAsync).not.toHaveBeenCalled()
		expect(screen.queryByText('Не больше 20')).not.toBe(null)
	})
})
