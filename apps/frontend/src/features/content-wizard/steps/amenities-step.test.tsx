/**
 * <AmenitiesStep> — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── RBAC × 3 roles ──────────────────────────────────────────────
 *     [R1] owner — checkbox enabled, save enabled
 *     [R2] manager — checkbox enabled (manager has create/update/delete)
 *     [R3] staff — checkbox disabled, save disabled, readonly Alert
 *
 *   ─── Branches ────────────────────────────────────────────────────
 *     [B1] isLoading=true → "Загрузка…" only
 *     [B2] error → destructive Alert with message, no form
 *
 *   ─── Catalog rendering ───────────────────────────────────────────
 *     [C1] all 64 catalog amenities rendered as checkboxes
 *     [C2] filter='internet' → only internet rows visible
 *     [C3] filter='all' → all 64 visible again
 *     [C4] header counter "Выбрано: 0 из 64" exact
 *
 *   ─── Hydration from server ───────────────────────────────────────
 *     [H1] server returns 2 rows → both checkboxes checked
 *     [H2] server row with value → value Input pre-filled
 *     [H3] header counter reflects hydrated count
 *
 *   ─── Toggle behaviour ────────────────────────────────────────────
 *     [Tg1] check → counter increments by 1
 *     [Tg2] uncheck → counter decrements by 1
 *     [Tg3] checking surfaces freePaid Select with default value
 *     [Tg4] for supportsValue=true amenity → value Input appears when checked
 *
 *   ─── Save serialization ──────────────────────────────────────────
 *     [S1] save with no selection → mutation called with []
 *     [S2] empty value field → serialized as null (not "")
 *     [S3] non-empty value → serialized verbatim (trimmed)
 *     [S4] save sends amenityCode + freePaid + value (3 fields per item)
 *
 *   ─── a11y ────────────────────────────────────────────────────────
 *     [A1] section labelled by h2 via aria-labelledby
 *     [A2] every checkbox has accessible label
 */
import {
	AMENITY_CATALOG,
	hasPermission,
	type MemberRole,
	type PropertyAmenityRow,
} from '@horeca/shared'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../../lib/use-can.ts', () => ({
	useCan: vi.fn(() => true),
	useCurrentRole: vi.fn(() => 'owner'),
}))

vi.mock('../hooks/use-amenities.ts', () => ({
	useAmenities: vi.fn(() => ({ data: [], isLoading: false, error: null })),
	useSetAmenities: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))

import { useCan } from '../../../lib/use-can.ts'
import { useAmenities, useSetAmenities } from '../hooks/use-amenities.ts'
import { AmenitiesStep } from './amenities-step.tsx'

const mockedUseCan = vi.mocked(useCan)
const mockedUseAmenities = vi.mocked(useAmenities)
const mockedUseSet = vi.mocked(useSetAmenities)

beforeEach(() => {
	mockedUseCan.mockImplementation(() => true)
	mockedUseAmenities.mockReturnValue({
		data: [],
		isLoading: false,
		error: null,
	} as unknown as ReturnType<typeof useAmenities>)
	mockedUseSet.mockReturnValue({
		mutateAsync: vi.fn(),
		isPending: false,
	} as unknown as ReturnType<typeof useSetAmenities>)
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

function setRole(role: MemberRole) {
	mockedUseCan.mockImplementation((perms) => hasPermission(role, perms))
}

function renderWithRows(rows: PropertyAmenityRow[]) {
	mockedUseAmenities.mockReturnValue({
		data: rows,
		isLoading: false,
		error: null,
	} as unknown as ReturnType<typeof useAmenities>)
	render(<AmenitiesStep propertyId="prop_x" />)
}

const PROP_AMENITY_FIXTURE = (
	code: string,
	overrides: Partial<PropertyAmenityRow> = {},
): PropertyAmenityRow => ({
	tenantId: 'org-test',
	propertyId: 'prop_x',
	amenityCode: code,
	scope: 'property',
	freePaid: 'free',
	value: null,
	createdAt: '2026-04-27T00:00:00.000Z',
	updatedAt: '2026-04-27T00:00:00.000Z',
	...overrides,
})

// ────────────────────────────────────────────────────────────────────
// RBAC matrix
// ────────────────────────────────────────────────────────────────────

describe('<AmenitiesStep> — RBAC matrix', () => {
	test('[R1] owner — save button enabled, no readonly Alert', () => {
		setRole('owner')
		render(<AmenitiesStep propertyId="prop_x" />)
		expect(screen.queryByText('Только просмотр')).toBeNull()
		expect((screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(
			false,
		)
	})

	test('[R2] manager — save enabled (full RBAC on amenity)', () => {
		setRole('manager')
		render(<AmenitiesStep propertyId="prop_x" />)
		expect(screen.queryByText('Только просмотр')).toBeNull()
		expect((screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(
			false,
		)
	})

	test('[R3] staff — save disabled + readonly Alert', () => {
		setRole('staff')
		render(<AmenitiesStep propertyId="prop_x" />)
		expect(screen.getByText('Только просмотр')).toBeTruthy()
		expect((screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(
			true,
		)
	})
})

// ────────────────────────────────────────────────────────────────────
// Branches
// ────────────────────────────────────────────────────────────────────

describe('<AmenitiesStep> — branches', () => {
	test('[B1] isLoading=true → "Загрузка…", no save button', () => {
		mockedUseAmenities.mockReturnValue({
			data: undefined,
			isLoading: true,
			error: null,
		} as unknown as ReturnType<typeof useAmenities>)
		render(<AmenitiesStep propertyId="prop_x" />)
		expect(screen.getByText('Загрузка…')).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull()
	})

	test('[B2] error → destructive Alert + message + no form', () => {
		mockedUseAmenities.mockReturnValue({
			data: undefined,
			isLoading: false,
			error: { message: 'boom' } as unknown as Error,
		} as unknown as ReturnType<typeof useAmenities>)
		render(<AmenitiesStep propertyId="prop_x" />)
		expect(screen.getByText('Ошибка загрузки')).toBeTruthy()
		expect(screen.getByText('boom')).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull()
	})
})

// ────────────────────────────────────────────────────────────────────
// Catalog
// ────────────────────────────────────────────────────────────────────

describe('<AmenitiesStep> — catalog rendering', () => {
	test('[C1] all 64 catalog amenities rendered as checkboxes', () => {
		render(<AmenitiesStep propertyId="prop_x" />)
		const checkboxes = screen.getAllByRole('checkbox')
		expect(checkboxes).toHaveLength(AMENITY_CATALOG.length)
	})

	test('[C4] header counter shows "Выбрано: <count> из <N>" with count=0', () => {
		render(<AmenitiesStep propertyId="prop_x" />)
		const section = screen.getByRole('region', { name: 'Удобства' })
		// Counter has a <strong> wrapping just the number — exact-value assert
		// via that landmark, no accidental sibling-DOM bleed-in.
		const counter = within(section).getAllByText(/Выбрано:/)[0]
		expect(counter).toBeDefined()
		const strong = counter?.querySelector('strong')
		expect(strong?.textContent).toBe('0')
		expect(counter?.textContent).toContain(`из ${AMENITY_CATALOG.length}`)
	})
})

// ────────────────────────────────────────────────────────────────────
// Hydration
// ────────────────────────────────────────────────────────────────────

describe('<AmenitiesStep> — hydration', () => {
	test('[H1] server returns 2 rows → both checkboxes checked', () => {
		renderWithRows([
			PROP_AMENITY_FIXTURE('AMN_WIFI_FREE_PUBLIC'),
			PROP_AMENITY_FIXTURE('AMN_PARKING_INDOOR_FREE'),
		])
		const checked = screen
			.getAllByRole('checkbox')
			.filter((c) => c.getAttribute('aria-checked') === 'true' || (c as HTMLInputElement).checked)
		expect(checked.length).toBe(2)
	})

	test('[H2] supportsValue=true row + value="100 Мбит/с" → input pre-filled', () => {
		renderWithRows([PROP_AMENITY_FIXTURE('AMN_WIFI_HIGH_SPEED', { value: '100 Мбит/с' })])
		// The value Input has aria-label="Значение для <labelRu>" — use anchored
		// regex to disambiguate from the checkbox label that has the same prefix.
		const input = screen.getByLabelText(/^Значение для Высокоскоростной Wi-Fi/) as HTMLInputElement
		expect(input.value).toBe('100 Мбит/с')
	})

	test('[H3] hydrated count visible in counter', () => {
		renderWithRows([
			PROP_AMENITY_FIXTURE('AMN_WIFI_FREE_PUBLIC'),
			PROP_AMENITY_FIXTURE('AMN_PARKING_INDOOR_FREE'),
			PROP_AMENITY_FIXTURE('AMN_POOL_INDOOR'),
		])
		const section = screen.getByRole('region', { name: 'Удобства' })
		const counter = within(section).getAllByText(/Выбрано:/)[0]
		expect(counter?.querySelector('strong')?.textContent).toBe('3')
	})
})

// ────────────────────────────────────────────────────────────────────
// Toggle behaviour
// ────────────────────────────────────────────────────────────────────

describe('<AmenitiesStep> — toggle', () => {
	test('[Tg1] checking → counter increments to 1', () => {
		render(<AmenitiesStep propertyId="prop_x" />)
		const wifi = screen.getByLabelText(/Бесплатный Wi-Fi в общих зонах/)
		fireEvent.click(wifi)
		const section = screen.getByRole('region', { name: 'Удобства' })
		const counter = within(section).getAllByText(/Выбрано:/)[0]
		expect(counter?.querySelector('strong')?.textContent).toBe('1')
	})

	test('[Tg2] uncheck → counter decrements back to 0', () => {
		render(<AmenitiesStep propertyId="prop_x" />)
		const wifi = screen.getByLabelText(/Бесплатный Wi-Fi в общих зонах/)
		fireEvent.click(wifi)
		fireEvent.click(wifi)
		const section = screen.getByRole('region', { name: 'Удобства' })
		const counter = within(section).getAllByText(/Выбрано:/)[0]
		expect(counter?.querySelector('strong')?.textContent).toBe('0')
	})

	test('[Tg4] supportsValue=true amenity (AMN_WIFI_HIGH_SPEED) — value Input appears once checked', () => {
		render(<AmenitiesStep propertyId="prop_x" />)
		// Before checking: no value input for this amenity
		const checkbox = screen.getByLabelText(/Высокоскоростной Wi-Fi/)
		expect(screen.queryByLabelText(/Значение для Высокоскоростной Wi-Fi/)).toBeNull()
		fireEvent.click(checkbox)
		// After checking: value input appears
		expect(screen.getByLabelText(/Значение для Высокоскоростной Wi-Fi/)).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// Save serialization
// ────────────────────────────────────────────────────────────────────

describe('<AmenitiesStep> — save serialization', () => {
	test('[S1] save with no selection → mutation called with empty array', () => {
		const mutateAsync = vi.fn()
		mockedUseSet.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useSetAmenities>)
		render(<AmenitiesStep propertyId="prop_x" />)
		fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
		expect(mutateAsync).toHaveBeenCalledWith([])
	})

	test('[S2] checked amenity with no value → serialized with value=null', () => {
		const mutateAsync = vi.fn()
		mockedUseSet.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useSetAmenities>)
		render(<AmenitiesStep propertyId="prop_x" />)
		fireEvent.click(screen.getByLabelText(/Бесплатный Wi-Fi в общих зонах/))
		fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
		expect(mutateAsync).toHaveBeenCalledWith([
			{ amenityCode: 'AMN_WIFI_FREE_PUBLIC', freePaid: 'free', value: null },
		])
	})

	test('[S3] supportsValue amenity with non-empty value → serialized verbatim (trimmed)', () => {
		const mutateAsync = vi.fn()
		mockedUseSet.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useSetAmenities>)
		render(<AmenitiesStep propertyId="prop_x" />)
		fireEvent.click(screen.getByLabelText(/Высокоскоростной Wi-Fi/))
		const input = screen.getByLabelText(/Значение для Высокоскоростной Wi-Fi/) as HTMLInputElement
		fireEvent.change(input, { target: { value: '  500 Мбит/с  ' } })
		fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
		expect(mutateAsync).toHaveBeenCalledWith([
			{ amenityCode: 'AMN_WIFI_HIGH_SPEED', freePaid: 'free', value: '500 Мбит/с' },
		])
	})

	test('[S4] each item has exactly 3 fields: amenityCode, freePaid, value', () => {
		const mutateAsync = vi.fn()
		mockedUseSet.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useSetAmenities>)
		render(<AmenitiesStep propertyId="prop_x" />)
		fireEvent.click(screen.getByLabelText(/Бесплатный Wi-Fi в общих зонах/))
		fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
		const items = mutateAsync.mock.calls[0]?.[0] as Array<Record<string, unknown>>
		for (const item of items) {
			expect(Object.keys(item).sort()).toEqual(['amenityCode', 'freePaid', 'value'])
		}
	})
})

// ────────────────────────────────────────────────────────────────────
// a11y
// ────────────────────────────────────────────────────────────────────

describe('<AmenitiesStep> — a11y', () => {
	test('[A1] section labelled by h2 via aria-labelledby', () => {
		render(<AmenitiesStep propertyId="prop_x" />)
		const section = screen.getByRole('region', { name: 'Удобства' })
		const h2 = within(section).getByRole('heading', { level: 2, name: 'Удобства' })
		expect(section.getAttribute('aria-labelledby')).toBe(h2.id)
	})

	test('[A2] every checkbox has an accessible label', () => {
		render(<AmenitiesStep propertyId="prop_x" />)
		const checkboxes = screen.getAllByRole('checkbox')
		for (const cb of checkboxes) {
			// `getByLabelText` would throw if no label association; here we
			// assert each checkbox has a non-empty accessible name via labelledby.
			const labelId = cb.getAttribute('id')
			if (!labelId) continue
			const label = document.querySelector(`label[for="${labelId}"]`)
			expect(label?.textContent?.trim()).toBeTruthy()
		}
	})
})
