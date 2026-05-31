/**
 * `<RatePlanFormSheet>` — strict adversarial + immutable tests.
 *
 * Pre-done audit:
 *   Render:
 *     [R1] create mode: title «Новый тариф»; button «Создать тариф»
 *     [R2] edit mode: title «Изменить «<name>»»; button «Сохранить»;
 *          roomTypeId Select disabled (immutable — see RatePlan PATCH schema)
 *
 *   Submit (exact-value + immutable):
 *     [S1] create payload includes roomTypeId AND isRefundable=true →
 *          cancellationHours: 24 (default). currency='RUB'.
 *     [S2] edit patch EXCLUDES roomTypeId (server PATCH schema doesn't
 *          accept changing it — immutable canon). Includes converted
 *          cancellationHours.
 *     [S3] code field always upper-cased on type ('base' → 'BASE')
 *     [S4] isRefundable=false + create → cancellationHours OMITTED from
 *          payload (server `roomTypeCreateInput` refine: refundable=false
 *          forbids cancellationHours)
 *     [S5] isRefundable=false + edit → patch sets cancellationHours: null
 *          (explicit clear semantic).
 *
 *   Adversarial:
 *     [A1] create.mutateAsync reject → error banner; sheet stays open
 *
 *   Inline-bounds (B5 — Zod refine mirrors server `ratePlan.ts` bounds):
 *     [B1] minStay='0' → «Не меньше 1» FieldError
 *     [B2] minStay='31' → «Не больше 30» (server cap)
 *     [B3] cancellationHours='-1' → «Не меньше 0» (server cancellationHours
 *          permits 0 — same-day non-refundable window)
 *     [B4] cancellationHours='721' → «Не больше 720» (server 30d cap)
 *     [B5] out-of-range submit attempt blocks mutation
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const createMutateAsync = mock(async () => ({}))
const updateMutateAsync = mock(async () => ({}))

await mock.module('@tanstack/react-query', () => ({
	useMutation: (() => {
		let callIdx = 0
		return () => {
			const idx = callIdx++
			if (idx % 2 === 0) {
				return { mutateAsync: createMutateAsync, isPending: false }
			}
			return { mutateAsync: updateMutateAsync, isPending: false }
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

const { RatePlanFormSheet } = await import('./rate-plan-form-sheet.tsx')

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

const EXISTING_PLAN = {
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
	createMutateAsync.mockReset()
	createMutateAsync.mockImplementation(async () => ({}))
	updateMutateAsync.mockReset()
	updateMutateAsync.mockImplementation(async () => ({}))
})

afterEach(cleanup)

describe('RatePlanFormSheet — render', () => {
	it('[R1] create mode: title + Создать тариф button', () => {
		render(
			<RatePlanFormSheet open onOpenChange={() => {}} propertyId="prop-1" roomTypes={ROOM_TYPES} />,
		)
		expect(screen.queryByText('Новый тариф')).not.toBe(null)
		expect(screen.queryByRole('button', { name: /Создать тариф/ })).not.toBe(null)
	})

	it('[R2] edit mode: title + Сохранить button + roomType Select disabled', () => {
		render(
			<RatePlanFormSheet
				open
				onOpenChange={() => {}}
				propertyId="prop-1"
				roomTypes={ROOM_TYPES}
				existing={EXISTING_PLAN}
			/>,
		)
		expect(screen.queryByText('Изменить «Базовый»')).not.toBe(null)
		expect(screen.queryByRole('button', { name: /Сохранить/ })).not.toBe(null)
		const select = screen.getByLabelText('Категория')
		expect(select.getAttribute('data-disabled')).not.toBe(null)
	})
})

describe('RatePlanFormSheet — submit shape (exact-value + immutable)', () => {
	it('[S1+S3] create includes roomTypeId; code auto-upper; currency=RUB; isRefundable=true defaults cancellationHours=24', async () => {
		render(
			<RatePlanFormSheet open onOpenChange={() => {}} propertyId="prop-1" roomTypes={ROOM_TYPES} />,
		)

		const nameInput = screen.getByLabelText('Название')
		await userEvent.setup().type(nameInput, 'Базовый')
		const codeInput = screen.getByLabelText('Код тарифа')
		await userEvent.setup().type(codeInput, 'base') // lowercase typed

		fireEvent.click(screen.getByRole('button', { name: /Создать тариф/ }))

		await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1))
		expect(createMutateAsync).toHaveBeenCalledWith({
			roomTypeId: 'rt-1',
			name: 'Базовый',
			code: 'BASE', // auto-uppered
			isDefault: false,
			isRefundable: true,
			cancellationHours: 24,
			mealsIncluded: 'none',
			minStay: 1,
			currency: 'RUB',
		})
	})

	it('[S2] edit patch EXCLUDES roomTypeId (immutable canon)', async () => {
		render(
			<RatePlanFormSheet
				open
				onOpenChange={() => {}}
				propertyId="prop-1"
				roomTypes={ROOM_TYPES}
				existing={EXISTING_PLAN}
			/>,
		)

		const nameInput = screen.getByLabelText('Название') as HTMLInputElement
		await userEvent.setup().clear(nameInput)
		await userEvent.setup().type(nameInput, 'Базовый-Plus')

		fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }))

		await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1))
		// IMMUTABLE canon: roomTypeId NOT in patch (admin can't change category).
		expect(updateMutateAsync).toHaveBeenCalledWith({
			id: 'rp-1',
			patch: {
				name: 'Базовый-Plus',
				code: 'BASE',
				isRefundable: true,
				cancellationHours: 24,
				mealsIncluded: 'none',
				minStay: 1,
			},
		})
	})
})

describe('RatePlanFormSheet — adversarial', () => {
	it('[A1] create rejection → error banner с message; sheet stays open', async () => {
		createMutateAsync.mockImplementation(async () => {
			throw new Error('code already exists')
		})
		const onOpenChange = mock()
		render(
			<RatePlanFormSheet
				open
				onOpenChange={onOpenChange}
				propertyId="prop-1"
				roomTypes={ROOM_TYPES}
			/>,
		)

		const nameInput = screen.getByLabelText('Название')
		await userEvent.setup().type(nameInput, 'Test')
		const codeInput = screen.getByLabelText('Код тарифа')
		await userEvent.setup().type(codeInput, 'TEST')

		fireEvent.click(screen.getByRole('button', { name: /Создать тариф/ }))

		await waitFor(() => expect(screen.queryByRole('alert')).not.toBe(null))
		expect(screen.getByRole('alert').textContent).toBe('code already exists')
		expect(onOpenChange.mock.calls.some((c) => c[0] === false)).toBe(false)
	})
})

describe('RatePlanFormSheet — inline-bounds (B5)', () => {
	it('[B1] minStay=0 surfaces «Не меньше 1»', async () => {
		render(
			<RatePlanFormSheet open onOpenChange={() => {}} propertyId="prop-1" roomTypes={ROOM_TYPES} />,
		)
		const minStay = screen.getByLabelText('Мин. ночей') as HTMLInputElement
		fireEvent.change(minStay, { target: { value: '0' } })
		await waitFor(() => {
			expect(screen.queryByText('Не меньше 1')).not.toBe(null)
		})
	})

	it('[B2] minStay=31 surfaces «Не больше 30»', async () => {
		render(
			<RatePlanFormSheet open onOpenChange={() => {}} propertyId="prop-1" roomTypes={ROOM_TYPES} />,
		)
		const minStay = screen.getByLabelText('Мин. ночей') as HTMLInputElement
		fireEvent.change(minStay, { target: { value: '31' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 30')).not.toBe(null)
		})
	})

	it('[B3] cancellationHours=-1 surfaces «Не меньше 0» (server min=0)', async () => {
		render(
			<RatePlanFormSheet open onOpenChange={() => {}} propertyId="prop-1" roomTypes={ROOM_TYPES} />,
		)
		// isRefundable defaults true → cancellationHours field mounted.
		const ch = screen.getByLabelText(/бесплатная отмена/) as HTMLInputElement
		fireEvent.change(ch, { target: { value: '-1' } })
		await waitFor(() => {
			expect(screen.queryByText('Не меньше 0')).not.toBe(null)
		})
	})

	it('[B4] cancellationHours=721 surfaces «Не больше 720» (server 30d cap)', async () => {
		render(
			<RatePlanFormSheet open onOpenChange={() => {}} propertyId="prop-1" roomTypes={ROOM_TYPES} />,
		)
		const ch = screen.getByLabelText(/бесплатная отмена/) as HTMLInputElement
		fireEvent.change(ch, { target: { value: '721' } })
		await waitFor(() => {
			expect(screen.queryByText('Не больше 720')).not.toBe(null)
		})
	})

	it('[B5] out-of-range submit attempt blocks createMutateAsync', async () => {
		render(
			<RatePlanFormSheet open onOpenChange={() => {}} propertyId="prop-1" roomTypes={ROOM_TYPES} />,
		)
		await userEvent.setup().type(screen.getByLabelText('Название'), 'Test')
		await userEvent.setup().type(screen.getByLabelText('Код тарифа'), 'TEST')
		const minStay = screen.getByLabelText('Мин. ночей') as HTMLInputElement
		fireEvent.change(minStay, { target: { value: '99' } })

		await waitFor(() => {
			expect(screen.queryByText('Не больше 30')).not.toBe(null)
		})

		fireEvent.click(screen.getByRole('button', { name: /Создать тариф/ }))

		await new Promise((r) => setTimeout(r, 50))
		expect(createMutateAsync).not.toHaveBeenCalled()
		expect(screen.queryByText('Не больше 30')).not.toBe(null)
	})
})
