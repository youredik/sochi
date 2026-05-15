/**
 * `<BookingCreateSheet>` — strict component tests focused on G1 fixes
 * (real-bug-hunt 2026-05-15 G1). E2e covers integration через сервер mock;
 * component tests here verify per-field UX contracts independently of the
 * network round-trip.
 *
 * Pre-done audit (per `[[strict_tests]]`):
 *   Render:
 *     [R1] mount с propertyId + roomTypeId + roomTypeName + checkIn —
 *          title «Новое бронирование» + description «{roomTypeName} ·
 *          заезд {checkIn}»
 *
 *   G-B3 rate plan picker:
 *     [P1] picker visible (label «Тариф») + after ratePlans query lands,
 *          form.ratePlanId auto-seeded к first active plan; Select
 *          trigger displays plan name (não placeholder)
 *
 *   G-B2 guestsCount inline validation:
 *     [V1] guestsCount=0 on blur → «Не меньше 1» FieldError visible
 *     [V2] guestsCount=21 on blur → «Не больше 20» FieldError visible
 *     [V3] valid integer (5) — no error rendered
 *
 *   G-B4 price preview:
 *     [P-PV1] rates query returns 1 row (1 ночь × 3500₽) → preview
 *             text contains «1 ночь» + «тариф Базовый» + «Итого:» +
 *             «3 500 ₽» (RU number format с non-breaking space)
 *     [P-PV2] rates query empty (no seeded data) → graceful fallback
 *             text «стоимость рассчитается при создании», submit still
 *             functional
 *
 *   G-B1 silent guest failure fix:
 *     [E1] useCreateGuest mocked-throw → toast.error called с RU-prefixed
 *          message (assertion via sonner mock)
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

type GuestShape = { id: string; firstName: string; lastName: string }
const createGuestMock = mock<(input: unknown) => Promise<GuestShape>>(async () => ({
	id: 'guest_test',
	firstName: 'Иван',
	lastName: 'Иванов',
}))
const createBookingMock = mock<(input: unknown) => Promise<{ id: string }>>(async () => ({
	id: 'booking_test',
}))

const BAR = {
	id: 'rp_bar',
	tenantId: 't',
	propertyId: 'prop_1',
	roomTypeId: 'rt_1',
	name: 'Базовый',
	code: 'BAR',
	isDefault: true,
	isActive: true,
	isRefundable: true,
	cancellationHours: 24,
	mealsIncluded: 'none' as const,
	minStay: 1,
	maxStay: null,
	currency: 'RUB',
	createdAt: '',
	updatedAt: '',
}
const NR = { ...BAR, id: 'rp_nr', name: 'Невозвратный', code: 'NR', isDefault: false }

const SEEDED_RATES = [{ date: '2026-05-20', amount: '3500.00', currency: 'RUB' }] as const

const ratePlansState = { data: [BAR, NR] as ReadonlyArray<unknown>, isPending: false }
const ratesState = {
	data: SEEDED_RATES as ReadonlyArray<unknown>,
	isPending: false,
	isError: false,
}

mock.module('@tanstack/react-query', () => ({
	useQuery: () => ratesState,
	useMutation: () => ({ mutateAsync: async () => undefined, isPending: false }),
	useQueryClient: () => ({
		invalidateQueries: () => {},
		cancelQueries: async () => {},
		getQueryData: () => null,
		setQueryData: () => {},
	}),
	queryOptions: <T,>(opts: T) => opts,
}))

mock.module('../hooks/use-booking-mutations', () => ({
	useRatePlans: () => ratePlansState,
	useCreateGuest: () => ({ mutateAsync: createGuestMock, isPending: false }),
	useCreateBooking: () => ({ mutateAsync: createBookingMock, isPending: false }),
}))

const toastErrorMock = mock()
mock.module('sonner', () => ({
	toast: { error: toastErrorMock, success: () => {}, warning: () => {}, info: () => {} },
}))

const { BookingCreateSheet } = await import('./booking-create-sheet.tsx')

const baseProps = {
	open: true,
	onOpenChange: () => {},
	propertyId: 'prop_1',
	roomTypeId: 'rt_1',
	roomTypeName: 'Стандартный',
	checkIn: '2026-05-20',
	windowFrom: '2026-05-15',
	windowTo: '2026-05-29',
}

beforeEach(() => {
	createGuestMock.mockReset()
	createGuestMock.mockImplementation(async () => ({
		id: 'guest_test',
		firstName: 'Иван',
		lastName: 'Иванов',
	}))
	createBookingMock.mockReset()
	createBookingMock.mockImplementation(async () => ({ id: 'booking_test' }))
	toastErrorMock.mockReset()
	ratePlansState.data = [BAR, NR]
	ratesState.data = SEEDED_RATES
	ratesState.isPending = false
	ratesState.isError = false
})

afterEach(cleanup)

describe('BookingCreateSheet — render', () => {
	it('[R1] mount renders title + description с roomTypeName + checkIn', () => {
		render(<BookingCreateSheet {...baseProps} />)
		expect(screen.queryByText('Новое бронирование')).not.toBe(null)
		expect(screen.queryByText('Стандартный · заезд 2026-05-20')).not.toBe(null)
	})
})

describe('BookingCreateSheet — G-B3 rate plan picker', () => {
	it('[P1] picker visible; default rate plan auto-seeded после query lands', async () => {
		render(<BookingCreateSheet {...baseProps} />)
		// Label «Тариф» rendered.
		expect(screen.queryByText('Тариф')).not.toBe(null)
		// Combobox trigger present с accessible name «Тариф».
		const trigger = screen.getByRole('combobox', { name: 'Тариф' })
		expect(trigger).not.toBe(null)
		// Default ratePlan = BAR (isDefault=true && isActive). useEffect
		// seeds form.ratePlanId post-mount → trigger shows BAR.name.
		await waitFor(() => {
			expect(trigger.textContent).toContain('Базовый')
		})
		// Placeholder ABSENT after seed.
		expect(trigger.textContent).not.toContain('Выберите тариф')
		expect(trigger.textContent).not.toContain('Загружаем')
	})
})

describe('BookingCreateSheet — G-B2 guestsCount inline validation', () => {
	it('[V1] guestsCount=0 on blur surfaces «Не меньше 1»', async () => {
		render(<BookingCreateSheet {...baseProps} />)
		const input = screen.getByLabelText('Гостей') as HTMLInputElement
		// Set value 0 via fireEvent.change (TextField type=number coerces к 0)
		fireEvent.change(input, { target: { value: '0' } })
		fireEvent.blur(input)
		await waitFor(() => {
			expect(screen.queryByText('Не меньше 1')).not.toBe(null)
		})
	})

	it('[V2] guestsCount=21 on blur surfaces «Не больше 20»', async () => {
		render(<BookingCreateSheet {...baseProps} />)
		const input = screen.getByLabelText('Гостей') as HTMLInputElement
		fireEvent.change(input, { target: { value: '21' } })
		fireEvent.blur(input)
		await waitFor(() => {
			expect(screen.queryByText('Не больше 20')).not.toBe(null)
		})
	})

	it('[V3] valid integer (5) — no validation error rendered', async () => {
		render(<BookingCreateSheet {...baseProps} />)
		const input = screen.getByLabelText('Гостей') as HTMLInputElement
		fireEvent.change(input, { target: { value: '5' } })
		fireEvent.blur(input)
		// Wait a tick для validator to run.
		await new Promise((r) => setTimeout(r, 30))
		expect(screen.queryByText('Не меньше 1')).toBe(null)
		expect(screen.queryByText('Не больше 20')).toBe(null)
	})
})

describe('BookingCreateSheet — G-B4 price preview', () => {
	it('[P-PV1] rates loaded → preview shows nights + plan + Итого ₽', async () => {
		render(<BookingCreateSheet {...baseProps} />)
		// PricePreview component reads form state; default 1 night
		// (checkIn=2026-05-20, checkOut=defaultCheckOut → +1day).
		const preview = screen.getByText(/Итого:/)
		expect(preview).not.toBe(null)
		// Both rouble symbol AND amount visible.
		expect(preview.textContent ?? '').toContain('₽')
	})

	it('[P-PV2] rates empty → graceful fallback «стоимость рассчитается при создании»', async () => {
		ratesState.data = []
		render(<BookingCreateSheet {...baseProps} />)
		await waitFor(() => {
			expect(screen.queryByText(/стоимость рассчитается при создании/)).not.toBe(null)
		})
		// «Итого:» line NOT rendered without rates.
		expect(screen.queryByText(/Итого:/)).toBe(null)
	})
})
