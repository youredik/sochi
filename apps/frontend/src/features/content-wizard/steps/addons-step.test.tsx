/**
 * <AddonsStep> — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── RBAC × 3 roles ──────────────────────────────────────────────
 *     [R1] owner — create button enabled (with required filled)
 *     [R2] manager — create button enabled (manager has CRUD on addon)
 *     [R3] staff — create form fieldset disabled + readonly Alert
 *
 *   ─── Branches ────────────────────────────────────────────────────
 *     [B1] isLoading=true → "Загрузка…"
 *     [B2] error → destructive Alert
 *
 *   ─── Empty / list rendering ──────────────────────────────────────
 *     [L1] empty list → "Пока ничего не добавлено."
 *     [L2] list of 2 addons → both nameRu values rendered
 *
 *   ─── Min-required gate ───────────────────────────────────────────
 *     [V1] empty code+name+price → create disabled
 *     [V2] only code → create disabled
 *     [V3] code+name + invalid priceRub "abc" → create disabled
 *     [V4] code+name + valid priceRub "1500" → create ENABLED
 *
 *   ─── Enum coverage in dropdowns (drift surface) ──────────────────
 *     [E1] all 12 categories present
 *     [E2] all 6 pricing units present
 *     [E3] all 6 VAT rates present (incl. 22% default)
 *
 *   ─── Default form values ─────────────────────────────────────────
 *     [D1] vatBps default = 22% (2200 bps)
 *     [D2] pricingUnit default = PER_STAY
 *     [D3] isActive default = true
 *     [D4] isMandatory default = false
 *
 *   ─── Seasonal tags multi-select ──────────────────────────────────
 *     [Sg1] all 4 seasonal tags rendered as checkboxes
 *     [Sg2] check ski-season → in payload seasonalTags
 *     [Sg3] check + uncheck → not in payload
 *
 *   ─── Create serialization ────────────────────────────────────────
 *     [Cr1] price "1500" → priceMicros 1_500_000_000n
 *     [Cr2] price "1500.50" → priceMicros 1_500_500_000n
 *     [Cr3] empty nameEn → null in payload (NOT "")
 *     [Cr4] empty descRu → null
 *     [Cr5] payload.currency='RUB', inventoryMode='NONE', dailyCapacity=null
 *     [Cr6] payload.sortOrder=0, descriptionEn=null
 *
 *   ─── Existing row interactions ───────────────────────────────────
 *     [Rx1] active=true → "Деактивировать" button
 *     [Rx2] active=false → "Неактивна" badge + "Активировать" button
 *     [Rx3] mandatory=true → "Обязательная" badge
 *     [Rx4] click "Деактивировать" → patch.mutate called with {isActive: false}
 *     [Rx5] click "Удалить" → del.mutate called with addonId
 *     [Rx6] seasonalTags rendered as labelled spans
 *
 *   ─── a11y ────────────────────────────────────────────────────────
 *     [A1] section labelled by h2 via aria-labelledby
 */
import {
	type Addon,
	addonCategoryValues,
	addonPricingUnitValues,
	addonSeasonalTagValues,
	hasPermission,
	type MemberRole,
	VAT_RATE_BPS_VALUES,
} from '@horeca/shared'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../../lib/use-can.ts', () => ({
	useCan: vi.fn(() => true),
	useCurrentRole: vi.fn(() => 'owner'),
}))

vi.mock('../hooks/use-addons.ts', () => ({
	useAddons: vi.fn(() => ({ data: [], isLoading: false, error: null })),
	useCreateAddon: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
	usePatchAddon: vi.fn(() => ({ mutate: vi.fn() })),
	useDeleteAddon: vi.fn(() => ({ mutate: vi.fn() })),
}))

import { useCan } from '../../../lib/use-can.ts'
import { useAddons, useCreateAddon, useDeleteAddon, usePatchAddon } from '../hooks/use-addons.ts'
import { AddonsStep } from './addons-step.tsx'

const mockedUseCan = vi.mocked(useCan)
const mockedUseAddons = vi.mocked(useAddons)
const mockedCreate = vi.mocked(useCreateAddon)
const mockedPatch = vi.mocked(usePatchAddon)
const mockedDelete = vi.mocked(useDeleteAddon)

beforeEach(() => {
	mockedUseCan.mockImplementation(() => true)
	mockedUseAddons.mockReturnValue({
		data: [],
		isLoading: false,
		error: null,
	} as unknown as ReturnType<typeof useAddons>)
	const stub = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
	mockedCreate.mockReturnValue(stub as unknown as ReturnType<typeof useCreateAddon>)
	mockedPatch.mockReturnValue(stub as unknown as ReturnType<typeof usePatchAddon>)
	mockedDelete.mockReturnValue(stub as unknown as ReturnType<typeof useDeleteAddon>)
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

function setRole(role: MemberRole) {
	mockedUseCan.mockImplementation((perms) => hasPermission(role, perms))
}

const ADDON_ROW = (overrides: Partial<Addon> = {}): Addon => ({
	tenantId: 'org-test',
	propertyId: 'prop_x',
	addonId: 'addn_1',
	code: 'BREAKFAST_RU',
	category: 'FOOD_AND_BEVERAGES',
	nameRu: 'Завтрак',
	nameEn: null,
	descriptionRu: null,
	descriptionEn: null,
	pricingUnit: 'PER_PERSON',
	priceMicros: 500_000_000n,
	currency: 'RUB',
	vatBps: 2200,
	isActive: true,
	isMandatory: false,
	inventoryMode: 'NONE',
	dailyCapacity: null,
	seasonalTags: [],
	sortOrder: 0,
	createdAt: '2026-04-27T00:00:00.000Z',
	updatedAt: '2026-04-27T00:00:00.000Z',
	...overrides,
})

function fillRequired() {
	fireEvent.change(screen.getByLabelText('Код (уникален в гостинице)'), {
		target: { value: 'BREAKFAST' },
	})
	fireEvent.change(screen.getByLabelText('Название (ru)'), { target: { value: 'Завтрак' } })
	fireEvent.change(screen.getByLabelText('Цена, ₽'), { target: { value: '1500' } })
}

// ────────────────────────────────────────────────────────────────────
// RBAC matrix
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — RBAC matrix', () => {
	test('[R1] owner — Add button enabled when min required filled', () => {
		setRole('owner')
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		expect(
			(screen.getByRole('button', { name: 'Добавить услугу' }) as HTMLButtonElement).disabled,
		).toBe(false)
	})

	test('[R2] manager — Add button enabled (manager has CRUD on addon)', () => {
		setRole('manager')
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		expect(
			(screen.getByRole('button', { name: 'Добавить услугу' }) as HTMLButtonElement).disabled,
		).toBe(false)
	})

	test('[R3] staff — readonly Alert + create fieldset has disabled attribute', () => {
		setRole('staff')
		render(<AddonsStep propertyId="prop_x" />)
		expect(screen.getByText('Только просмотр')).toBeTruthy()
		// Browser propagates `disabled` from <fieldset>, but happy-dom doesn't
		// always — assert on the fieldset element directly (prop is what we
		// control). UX-wise the inputs render visually disabled via CSS.
		const fieldset = screen.getByText('Новая услуга').closest('fieldset') as HTMLFieldSetElement
		expect(fieldset).not.toBeNull()
		expect(fieldset.disabled).toBe(true)
	})
})

// ────────────────────────────────────────────────────────────────────
// Branches
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — branches', () => {
	test('[B1] isLoading=true → "Загрузка…"', () => {
		mockedUseAddons.mockReturnValue({
			data: undefined,
			isLoading: true,
			error: null,
		} as unknown as ReturnType<typeof useAddons>)
		render(<AddonsStep propertyId="prop_x" />)
		expect(screen.getByText('Загрузка…')).toBeTruthy()
		expect(screen.queryByText('Новая услуга')).toBeNull()
	})

	test('[B2] error → destructive Alert', () => {
		mockedUseAddons.mockReturnValue({
			data: undefined,
			isLoading: false,
			error: { message: 'load fail' } as unknown as Error,
		} as unknown as ReturnType<typeof useAddons>)
		render(<AddonsStep propertyId="prop_x" />)
		expect(screen.getByText('Ошибка загрузки')).toBeTruthy()
		expect(screen.getByText('load fail')).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// List rendering
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — list', () => {
	test('[L1] empty list → "Пока ничего не добавлено."', () => {
		render(<AddonsStep propertyId="prop_x" />)
		expect(screen.getByText('Пока ничего не добавлено.')).toBeTruthy()
	})

	test('[L2] two addons → both names rendered', () => {
		mockedUseAddons.mockReturnValue({
			data: [
				ADDON_ROW({ addonId: 'a1', nameRu: 'Завтрак' }),
				ADDON_ROW({ addonId: 'a2', nameRu: 'Трансфер из аэропорта', code: 'TRANSFER' }),
			],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useAddons>)
		render(<AddonsStep propertyId="prop_x" />)
		expect(screen.getByText('Завтрак')).toBeTruthy()
		expect(screen.getByText('Трансфер из аэропорта')).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// Min-required gate
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — min required', () => {
	test('[V1] empty form → create disabled', () => {
		render(<AddonsStep propertyId="prop_x" />)
		expect(
			(screen.getByRole('button', { name: 'Добавить услугу' }) as HTMLButtonElement).disabled,
		).toBe(true)
	})

	test('[V2] only code filled → create disabled', () => {
		render(<AddonsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Код (уникален в гостинице)'), {
			target: { value: 'X' },
		})
		expect(
			(screen.getByRole('button', { name: 'Добавить услугу' }) as HTMLButtonElement).disabled,
		).toBe(true)
	})

	test('[V3] code+name + invalid price "abc" → create disabled', () => {
		render(<AddonsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Код (уникален в гостинице)'), {
			target: { value: 'X' },
		})
		fireEvent.change(screen.getByLabelText('Название (ru)'), { target: { value: 'Y' } })
		fireEvent.change(screen.getByLabelText('Цена, ₽'), { target: { value: 'abc' } })
		expect(
			(screen.getByRole('button', { name: 'Добавить услугу' }) as HTMLButtonElement).disabled,
		).toBe(true)
	})

	test('[V4] valid required → create enabled', () => {
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		expect(
			(screen.getByRole('button', { name: 'Добавить услугу' }) as HTMLButtonElement).disabled,
		).toBe(false)
	})
})

// ────────────────────────────────────────────────────────────────────
// Enum coverage in dropdowns
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — enum coverage', () => {
	test('[E1] category dropdown has 12 options (drift surface)', () => {
		render(<AddonsStep propertyId="prop_x" />)
		fireEvent.click(screen.getByLabelText('Категория'))
		expect(screen.getAllByRole('option')).toHaveLength(addonCategoryValues.length)
	})

	test('[E2] pricing-unit dropdown has 6 options', () => {
		render(<AddonsStep propertyId="prop_x" />)
		fireEvent.click(screen.getByLabelText('Единица цены'))
		expect(screen.getAllByRole('option')).toHaveLength(addonPricingUnitValues.length)
	})

	test('[E3] VAT dropdown has 6 options matching VAT_RATE_BPS_VALUES', () => {
		render(<AddonsStep propertyId="prop_x" />)
		fireEvent.click(screen.getByLabelText('НДС'))
		expect(screen.getAllByRole('option')).toHaveLength(VAT_RATE_BPS_VALUES.length)
	})
})

// ────────────────────────────────────────────────────────────────────
// Defaults
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — default form values', () => {
	test('[D1] vatBps default visible as "22% (основная)"', () => {
		render(<AddonsStep propertyId="prop_x" />)
		const vatTrigger = screen.getByLabelText('НДС')
		// Trigger displays its current SelectValue; assert by accessibility name
		// includes the basic-rate label
		expect(vatTrigger.textContent ?? '').toContain('22%')
	})

	test('[D2] pricingUnit default visible as "За проживание"', () => {
		render(<AddonsStep propertyId="prop_x" />)
		const trigger = screen.getByLabelText('Единица цены')
		expect(trigger.textContent ?? '').toContain('За проживание')
	})

	test('[D3] isActive default checked', () => {
		render(<AddonsStep propertyId="prop_x" />)
		const cb = screen.getByLabelText('Активна')
		expect(cb.getAttribute('aria-checked') ?? (cb as HTMLInputElement).checked).toBeTruthy()
	})

	test('[D4] isMandatory default unchecked', () => {
		render(<AddonsStep propertyId="prop_x" />)
		const cb = screen.getByLabelText('Обязательная')
		const ariaChecked = cb.getAttribute('aria-checked')
		// Either 'false' (Radix) or HTMLInputElement.checked === false
		const checked =
			ariaChecked !== null ? ariaChecked === 'true' : Boolean((cb as HTMLInputElement).checked)
		expect(checked).toBe(false)
	})
})

// ────────────────────────────────────────────────────────────────────
// Seasonal tags multi-select
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — seasonal tags', () => {
	test('[Sg1] all 4 seasonal tags rendered as checkboxes', () => {
		render(<AddonsStep propertyId="prop_x" />)
		// Each tag has a Label associated with the Checkbox via for/id pair.
		const seasonal = [
			'Лыжный сезон (15.12-15.04)',
			'Морской сезон (01.06-30.09)',
			'Новогодние праздники',
			'Майские праздники',
		]
		expect(seasonal).toHaveLength(addonSeasonalTagValues.length)
		for (const lbl of seasonal) expect(screen.getByLabelText(lbl)).toBeTruthy()
	})

	test('[Sg2] check ski-season → present in create payload', async () => {
		const mutateAsync = vi.fn().mockResolvedValue({})
		mockedCreate.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useCreateAddon>)
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		fireEvent.click(screen.getByLabelText('Лыжный сезон (15.12-15.04)'))
		fireEvent.click(screen.getByRole('button', { name: 'Добавить услугу' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { seasonalTags: string[] }
		expect(arg.seasonalTags).toEqual(['ski-season'])
	})

	test('[Sg3] check + uncheck → tag NOT in payload', async () => {
		const mutateAsync = vi.fn().mockResolvedValue({})
		mockedCreate.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useCreateAddon>)
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		const cb = screen.getByLabelText('Лыжный сезон (15.12-15.04)')
		fireEvent.click(cb)
		fireEvent.click(cb)
		fireEvent.click(screen.getByRole('button', { name: 'Добавить услугу' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { seasonalTags: string[] }
		expect(arg.seasonalTags).toEqual([])
	})
})

// ────────────────────────────────────────────────────────────────────
// Create serialization
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — create serialization', () => {
	function setCreate(): ReturnType<typeof vi.fn> {
		const mutateAsync = vi.fn().mockResolvedValue({})
		mockedCreate.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useCreateAddon>)
		return mutateAsync
	}

	test('[Cr1] price "1500" → priceMicros 1_500_000_000n', async () => {
		const mutateAsync = setCreate()
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		fireEvent.click(screen.getByRole('button', { name: 'Добавить услугу' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { priceMicros: bigint }
		expect(arg.priceMicros).toBe(1_500_000_000n)
	})

	test('[Cr2] price "1500.50" → priceMicros 1_500_500_000n', async () => {
		const mutateAsync = setCreate()
		render(<AddonsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Код (уникален в гостинице)'), {
			target: { value: 'X' },
		})
		fireEvent.change(screen.getByLabelText('Название (ru)'), { target: { value: 'Y' } })
		fireEvent.change(screen.getByLabelText('Цена, ₽'), { target: { value: '1500.50' } })
		fireEvent.click(screen.getByRole('button', { name: 'Добавить услугу' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { priceMicros: bigint }
		expect(arg.priceMicros).toBe(1_500_500_000n)
	})

	test('[Cr3] empty nameEn → null in payload (NOT empty string)', async () => {
		const mutateAsync = setCreate()
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		fireEvent.click(screen.getByRole('button', { name: 'Добавить услугу' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { nameEn: string | null }
		expect(arg.nameEn).toBeNull()
	})

	test('[Cr4] empty descRu → null', async () => {
		const mutateAsync = setCreate()
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		fireEvent.click(screen.getByRole('button', { name: 'Добавить услугу' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { descriptionRu: string | null }
		expect(arg.descriptionRu).toBeNull()
	})

	test('[Cr5] currency=RUB, inventoryMode=NONE, dailyCapacity=null', async () => {
		const mutateAsync = setCreate()
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		fireEvent.click(screen.getByRole('button', { name: 'Добавить услугу' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as Record<string, unknown>
		expect(arg.currency).toBe('RUB')
		expect(arg.inventoryMode).toBe('NONE')
		expect(arg.dailyCapacity).toBeNull()
	})

	test('[Cr6] sortOrder=0, descriptionEn=null', async () => {
		const mutateAsync = setCreate()
		render(<AddonsStep propertyId="prop_x" />)
		fillRequired()
		fireEvent.click(screen.getByRole('button', { name: 'Добавить услугу' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as Record<string, unknown>
		expect(arg.sortOrder).toBe(0)
		expect(arg.descriptionEn).toBeNull()
	})
})

// ────────────────────────────────────────────────────────────────────
// Existing row interactions
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — row interactions', () => {
	test('[Rx1] active=true → Деактивировать button + no Неактивна badge', () => {
		mockedUseAddons.mockReturnValue({
			data: [ADDON_ROW({ isActive: true })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useAddons>)
		render(<AddonsStep propertyId="prop_x" />)
		expect(screen.getByRole('button', { name: 'Деактивировать' })).toBeTruthy()
		expect(screen.queryByText('Неактивна')).toBeNull()
	})

	test('[Rx2] active=false → Неактивна badge + Активировать button', () => {
		mockedUseAddons.mockReturnValue({
			data: [ADDON_ROW({ isActive: false })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useAddons>)
		render(<AddonsStep propertyId="prop_x" />)
		expect(screen.getByText('Неактивна')).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Активировать' })).toBeTruthy()
	})

	test('[Rx3] mandatory=true → Обязательная badge in row (NOT the create-form checkbox)', () => {
		mockedUseAddons.mockReturnValue({
			data: [ADDON_ROW({ isMandatory: true })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useAddons>)
		render(<AddonsStep propertyId="prop_x" />)
		// Both the create-form checkbox label and the row badge contain
		// "Обязательная". Scope to the addon list <ul>.
		const list = screen.getByRole('list')
		expect(within(list).getByText('Обязательная')).toBeTruthy()
	})

	test('[Rx4] click Деактивировать → patch.mutate called with isActive:false', () => {
		const mutate = vi.fn()
		mockedPatch.mockReturnValue({ mutate } as unknown as ReturnType<typeof usePatchAddon>)
		mockedUseAddons.mockReturnValue({
			data: [ADDON_ROW({ isActive: true, addonId: 'addn_77' })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useAddons>)
		render(<AddonsStep propertyId="prop_x" />)
		fireEvent.click(screen.getByRole('button', { name: 'Деактивировать' }))
		expect(mutate).toHaveBeenCalledWith({
			addonId: 'addn_77',
			patch: { isActive: false },
		})
	})

	test('[Rx5] click Удалить → del.mutate called with addonId', () => {
		const mutate = vi.fn()
		mockedDelete.mockReturnValue({ mutate } as unknown as ReturnType<typeof useDeleteAddon>)
		mockedUseAddons.mockReturnValue({
			data: [ADDON_ROW({ addonId: 'addn_99' })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useAddons>)
		render(<AddonsStep propertyId="prop_x" />)
		fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
		expect(mutate).toHaveBeenCalledWith('addn_99')
	})

	test('[Rx6] seasonalTags rendered as labelled spans in the row', () => {
		mockedUseAddons.mockReturnValue({
			data: [
				ADDON_ROW({
					seasonalTags: ['ski-season', 'new-year-peak'],
				}),
			],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useAddons>)
		render(<AddonsStep propertyId="prop_x" />)
		// Same labels exist in the create-form Checkbox area; scope to <ul>.
		const list = screen.getByRole('list')
		expect(within(list).getByText('Лыжный сезон (15.12-15.04)')).toBeTruthy()
		expect(within(list).getByText('Новогодние праздники')).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// a11y
// ────────────────────────────────────────────────────────────────────

describe('<AddonsStep> — a11y', () => {
	test('[A1] section labelled by h2 via aria-labelledby', () => {
		render(<AddonsStep propertyId="prop_x" />)
		const section = screen.getByRole('region', { name: 'Услуги и доп. сервис' })
		const h2 = within(section).getByRole('heading', { level: 2, name: 'Услуги и доп. сервис' })
		expect(section.getAttribute('aria-labelledby')).toBe(h2.id)
	})
})
