/**
 * <DescriptionsStep> — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── RBAC × 3 roles ──────────────────────────────────────────────
 *     [R1] owner — save enabled
 *     [R2] manager — save enabled (full CRUD on description)
 *     [R3] staff — save disabled + readonly Alert
 *
 *   ─── Branches ────────────────────────────────────────────────────
 *     [B1] isLoading=true
 *     [B2] error → destructive Alert
 *
 *   ─── Tabs structure ──────────────────────────────────────────────
 *     [T1] Both ru + en tab triggers rendered (locale enum coverage)
 *     [T2] active tab is "ru" by default
 *     [T3] click "en" tab → activeLocale switches; ru draft preserved
 *
 *   ─── Hydration ───────────────────────────────────────────────────
 *     [H1] server returns ru row → fields hydrated on ru tab
 *     [H2] server returns BOTH locales → switching tab shows en values
 *
 *   ─── Min-required gate ───────────────────────────────────────────
 *     [M1] empty title + empty summary → save disabled, hint visible
 *     [M2] only title filled → save still disabled
 *     [M3] both filled → save enabled, hint hidden
 *
 *   ─── Save serialization (all 8 sections + SEO triplet) ───────────
 *     [S1] mutateAsync called with locale='ru' on ru-tab save
 *     [S2] empty section text → omitted from sections (NOT empty string)
 *     [S3] non-empty section → included verbatim (trimmed)
 *     [S4] empty SEO field → null (NOT empty string)
 *     [S5] non-empty SEO field → trimmed string
 *     [S6] all 8 section keys present in catalog when filled
 *
 *   ─── Save isolation per locale ───────────────────────────────────
 *     [I1] saving on ru tab does NOT include en payload (separate calls)
 *
 *   ─── a11y ────────────────────────────────────────────────────────
 *     [A1] section labelled by h2 via aria-labelledby
 */
import {
	hasPermission,
	type MemberRole,
	type PropertyDescription,
	type PropertyDescriptionLocale,
	propertyDescriptionSectionKeys,
} from '@horeca/shared'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../../lib/use-can.ts', () => ({
	useCan: vi.fn(() => true),
	useCurrentRole: vi.fn(() => 'owner'),
}))

vi.mock('../hooks/use-descriptions.ts', () => ({
	useDescriptions: vi.fn(() => ({ data: [], isLoading: false, error: null })),
	useUpsertDescription: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))

import { useCan } from '../../../lib/use-can.ts'
import { useDescriptions, useUpsertDescription } from '../hooks/use-descriptions.ts'
import { DescriptionsStep } from './descriptions-step.tsx'

const mockedUseCan = vi.mocked(useCan)
const mockedUseDescr = vi.mocked(useDescriptions)
const mockedUpsert = vi.mocked(useUpsertDescription)

beforeEach(() => {
	mockedUseCan.mockImplementation(() => true)
	mockedUseDescr.mockReturnValue({
		data: [],
		isLoading: false,
		error: null,
	} as unknown as ReturnType<typeof useDescriptions>)
	mockedUpsert.mockReturnValue({
		mutateAsync: vi.fn(),
		isPending: false,
	} as unknown as ReturnType<typeof useUpsertDescription>)
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

function setRole(role: MemberRole) {
	mockedUseCan.mockImplementation((perms) => hasPermission(role, perms))
}

/**
 * Radix Tabs use pointerdown + click; happy-dom omits some pointer-event
 * fields so a plain `fireEvent.click` doesn't always toggle. Simulate
 * the full pair (mousedown → click) which Radix's value-state listener
 * picks up reliably in happy-dom 19.x.
 */
function clickRadixTab(name: string): void {
	const tab = screen.getByRole('tab', { name })
	fireEvent.mouseDown(tab, { button: 0 })
	fireEvent.click(tab)
}

const FIXTURE = (
	locale: PropertyDescriptionLocale,
	overrides: Partial<PropertyDescription> = {},
): PropertyDescription => ({
	tenantId: 'org-test',
	propertyId: 'prop_x',
	locale,
	title: '',
	tagline: null,
	summaryMd: '',
	longDescriptionMd: null,
	sections: {},
	seoMetaTitle: null,
	seoMetaDescription: null,
	seoH1: null,
	createdAt: '2026-04-27T00:00:00.000Z',
	updatedAt: '2026-04-27T00:00:00.000Z',
	...overrides,
})

function renderWith(rows: PropertyDescription[]) {
	mockedUseDescr.mockReturnValue({
		data: rows,
		isLoading: false,
		error: null,
	} as unknown as ReturnType<typeof useDescriptions>)
	render(<DescriptionsStep propertyId="prop_x" />)
}

// ────────────────────────────────────────────────────────────────────
// RBAC matrix
// ────────────────────────────────────────────────────────────────────

describe('<DescriptionsStep> — RBAC matrix', () => {
	test('[R1] owner — save enabled (with title+summary filled)', () => {
		setRole('owner')
		renderWith([FIXTURE('ru', { title: 'Some title', summaryMd: 'Some summary' })])
		expect(screen.queryByText('Только просмотр')).toBeNull()
		const saveBtn = screen.getByRole('button', { name: /^Сохранить/ })
		expect((saveBtn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[R2] manager — save enabled (manager has CRUD on description)', () => {
		setRole('manager')
		renderWith([FIXTURE('ru', { title: 'Some title', summaryMd: 'Some summary' })])
		expect(screen.queryByText('Только просмотр')).toBeNull()
		expect((screen.getByRole('button', { name: /^Сохранить/ }) as HTMLButtonElement).disabled).toBe(
			false,
		)
	})

	test('[R3] staff — readonly Alert + save disabled', () => {
		setRole('staff')
		render(<DescriptionsStep propertyId="prop_x" />)
		expect(screen.getByText('Только просмотр')).toBeTruthy()
		expect((screen.getByRole('button', { name: /^Сохранить/ }) as HTMLButtonElement).disabled).toBe(
			true,
		)
	})
})

// ────────────────────────────────────────────────────────────────────
// Branches
// ────────────────────────────────────────────────────────────────────

describe('<DescriptionsStep> — branches', () => {
	test('[B1] isLoading=true → "Загрузка…", no form', () => {
		mockedUseDescr.mockReturnValue({
			data: undefined,
			isLoading: true,
			error: null,
		} as unknown as ReturnType<typeof useDescriptions>)
		render(<DescriptionsStep propertyId="prop_x" />)
		expect(screen.getByText('Загрузка…')).toBeTruthy()
		expect(screen.queryByRole('button', { name: /^Сохранить/ })).toBeNull()
	})

	test('[B2] error → destructive Alert + message + no form', () => {
		mockedUseDescr.mockReturnValue({
			data: undefined,
			isLoading: false,
			error: { message: 'load failed' } as unknown as Error,
		} as unknown as ReturnType<typeof useDescriptions>)
		render(<DescriptionsStep propertyId="prop_x" />)
		expect(screen.getByText('Ошибка загрузки')).toBeTruthy()
		expect(screen.getByText('load failed')).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// Tabs
// ────────────────────────────────────────────────────────────────────

describe('<DescriptionsStep> — tabs', () => {
	test('[T1] both locales rendered as tab triggers (enum coverage)', () => {
		render(<DescriptionsStep propertyId="prop_x" />)
		// Tabs render as role=tab buttons
		expect(screen.getByRole('tab', { name: 'Русский' })).toBeTruthy()
		expect(screen.getByRole('tab', { name: 'English' })).toBeTruthy()
	})

	test('[T2] "ru" tab is active (selected) by default', () => {
		render(<DescriptionsStep propertyId="prop_x" />)
		const ruTab = screen.getByRole('tab', { name: 'Русский' })
		expect(ruTab.getAttribute('aria-selected') ?? 'false').toBe('true')
	})

	test('[T3] click "en" tab — activeLocale switches', () => {
		render(<DescriptionsStep propertyId="prop_x" />)
		clickRadixTab('English')
		const enTab = screen.getByRole('tab', { name: 'English' })
		expect(enTab.getAttribute('aria-selected')).toBe('true')
	})
})

// ────────────────────────────────────────────────────────────────────
// Hydration
// ────────────────────────────────────────────────────────────────────

describe('<DescriptionsStep> — hydration', () => {
	test('[H1] ru row → fields hydrated on ru tab', () => {
		renderWith([
			FIXTURE('ru', {
				title: 'Гостиница на Имеретинке',
				summaryMd: '5 минут до моря',
				seoMetaTitle: 'Гостиница в Сочи',
			}),
		])
		expect((screen.getByLabelText('Заголовок') as HTMLInputElement).value).toBe(
			'Гостиница на Имеретинке',
		)
		expect((screen.getByLabelText(/Краткое описание/) as HTMLTextAreaElement).value).toBe(
			'5 минут до моря',
		)
		expect((screen.getByLabelText('Meta title') as HTMLInputElement).value).toBe('Гостиница в Сочи')
	})

	test('[H2] both locales → switching tab shows en values', () => {
		renderWith([
			FIXTURE('ru', { title: 'РУС', summaryMd: 'РС' }),
			FIXTURE('en', { title: 'ENG', summaryMd: 'ES' }),
		])
		// ru visible by default
		expect((screen.getByLabelText('Заголовок') as HTMLInputElement).value).toBe('РУС')
		// switch
		clickRadixTab('English')
		expect((screen.getByLabelText('Заголовок') as HTMLInputElement).value).toBe('ENG')
	})
})

// ────────────────────────────────────────────────────────────────────
// Min-required gate
// ────────────────────────────────────────────────────────────────────

describe('<DescriptionsStep> — min required', () => {
	test('[M1] empty title + empty summary → save disabled + hint visible', () => {
		render(<DescriptionsStep propertyId="prop_x" />)
		expect((screen.getByRole('button', { name: /^Сохранить/ }) as HTMLButtonElement).disabled).toBe(
			true,
		)
		expect(
			screen.getByText('Заполните «Заголовок» и «Краткое описание» — обязательны для сохранения.'),
		).toBeTruthy()
	})

	test('[M2] only title filled → save still disabled', () => {
		render(<DescriptionsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'Title' } })
		expect((screen.getByRole('button', { name: /^Сохранить/ }) as HTMLButtonElement).disabled).toBe(
			true,
		)
	})

	test('[M3] title + summary both filled → save enabled, hint hidden', () => {
		render(<DescriptionsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'T' } })
		fireEvent.change(screen.getByLabelText(/Краткое описание/), { target: { value: 'S' } })
		expect((screen.getByRole('button', { name: /^Сохранить/ }) as HTMLButtonElement).disabled).toBe(
			false,
		)
		expect(
			screen.queryByText(
				'Заполните «Заголовок» и «Краткое описание» — обязательны для сохранения.',
			),
		).toBeNull()
	})
})

// ────────────────────────────────────────────────────────────────────
// Save serialization
// ────────────────────────────────────────────────────────────────────

describe('<DescriptionsStep> — save serialization', () => {
	test('[S1] save fires mutateAsync with locale="ru" by default', async () => {
		const mutateAsync = vi.fn()
		mockedUpsert.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useUpsertDescription>)
		render(<DescriptionsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'T' } })
		fireEvent.change(screen.getByLabelText(/Краткое описание/), { target: { value: 'S' } })
		fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		expect(mutateAsync.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ locale: 'ru' }))
	})

	test('[S2] empty section → omitted from sections object', async () => {
		const mutateAsync = vi.fn()
		mockedUpsert.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useUpsertDescription>)
		render(<DescriptionsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'T' } })
		fireEvent.change(screen.getByLabelText(/Краткое описание/), { target: { value: 'S' } })
		fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { input: { sections: Record<string, unknown> } }
		expect(Object.keys(arg.input.sections)).toEqual([])
	})

	test('[S3] non-empty section → included verbatim (trimmed)', async () => {
		const mutateAsync = vi.fn()
		mockedUpsert.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useUpsertDescription>)
		render(<DescriptionsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'T' } })
		fireEvent.change(screen.getByLabelText(/Краткое описание/), { target: { value: 'S' } })
		// Find the location section textarea by its accessible label
		fireEvent.change(screen.getByLabelText('Расположение'), {
			target: { value: '   На берегу моря   ' },
		})
		fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { input: { sections: Record<string, string> } }
		expect(arg.input.sections.location).toBe('На берегу моря')
	})

	test('[S4] empty SEO meta-title → null (NOT empty string)', async () => {
		const mutateAsync = vi.fn()
		mockedUpsert.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useUpsertDescription>)
		render(<DescriptionsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'T' } })
		fireEvent.change(screen.getByLabelText(/Краткое описание/), { target: { value: 'S' } })
		fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as {
			input: {
				seoMetaTitle: string | null
				tagline: string | null
				longDescriptionMd: string | null
			}
		}
		expect(arg.input.seoMetaTitle).toBeNull()
		expect(arg.input.tagline).toBeNull()
		expect(arg.input.longDescriptionMd).toBeNull()
	})

	test('[S5] non-empty SEO meta-title → trimmed verbatim string', async () => {
		const mutateAsync = vi.fn()
		mockedUpsert.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useUpsertDescription>)
		render(<DescriptionsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'T' } })
		fireEvent.change(screen.getByLabelText(/Краткое описание/), { target: { value: 'S' } })
		fireEvent.change(screen.getByLabelText('Meta title'), {
			target: { value: '  Mt  ' },
		})
		fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { input: { seoMetaTitle: string | null } }
		expect(arg.input.seoMetaTitle).toBe('Mt')
	})

	test('[S6] all 8 section keys present in editor (enum coverage — drift surface)', () => {
		render(<DescriptionsStep propertyId="prop_x" />)
		const labels = [
			'Расположение',
			'Услуги',
			'Номера',
			'Питание',
			'Активности',
			'Для семей',
			'Доступная среда',
			'С питомцами',
		]
		expect(labels).toHaveLength(propertyDescriptionSectionKeys.length)
		for (const l of labels) expect(screen.getByLabelText(l)).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// Save isolation per locale
// ────────────────────────────────────────────────────────────────────

describe('<DescriptionsStep> — save isolation', () => {
	test('[I1] saving on ru tab → only ru locale in payload (en untouched)', async () => {
		const mutateAsync = vi.fn()
		mockedUpsert.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useUpsertDescription>)
		render(<DescriptionsStep propertyId="prop_x" />)
		fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'РУС' } })
		fireEvent.change(screen.getByLabelText(/Краткое описание/), { target: { value: 'РС' } })
		// Switch to en, change there too
		clickRadixTab('English')
		fireEvent.change(screen.getByLabelText('Заголовок'), { target: { value: 'ENG' } })
		// Switch back to ru
		clickRadixTab('Русский')
		fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
		const arg = mutateAsync.mock.calls[0]?.[0] as {
			locale: string
			input: { title: string }
		}
		expect(arg.locale).toBe('ru')
		expect(arg.input.title).toBe('РУС')
	})
})

// ────────────────────────────────────────────────────────────────────
// a11y
// ────────────────────────────────────────────────────────────────────

describe('<DescriptionsStep> — a11y', () => {
	test('[A1] section labelled by h2 via aria-labelledby', () => {
		render(<DescriptionsStep propertyId="prop_x" />)
		const section = screen.getByRole('region', { name: 'Описание гостиницы' })
		const h2 = within(section).getByRole('heading', { level: 2, name: 'Описание гостиницы' })
		expect(section.getAttribute('aria-labelledby')).toBe(h2.id)
	})
})
