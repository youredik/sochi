/**
 * <MediaStep> — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── RBAC × 3 roles ──────────────────────────────────────────────
 *     [R1] owner — file input enabled, no readonly Alert
 *     [R2] manager — file input enabled (manager has CRUD on media)
 *     [R3] staff — readonly Alert + file input disabled
 *
 *   ─── Branches ────────────────────────────────────────────────────
 *     [B1] isLoading=true → "Загрузка…"
 *     [B2] error → destructive Alert
 *
 *   ─── Empty / list rendering ──────────────────────────────────────
 *     [L1] empty list → "Пока нет фото." + counter "Загружено: 0 файлов"
 *     [L2] one media → counter "1 файл" (RU plural quirk)
 *     [L3] three media → counter "3 файлов"
 *
 *   ─── Preflight (client-side fail-fast) ───────────────────────────
 *     [P1] empty file → "Файл пуст" alert; pendingFile NOT set
 *     [P2] file too large (>50MB) → "Файл больше 50 МБ" alert
 *     [P3] disallowed MIME (text/plain) → exact alert mentioning MIME
 *     [P4] valid JPEG → no clientError, file panel visible (altRu input)
 *
 *   ─── altRu invariant ─────────────────────────────────────────────
 *     [Alt1] empty altRu → upload button disabled
 *     [Alt2] whitespace-only altRu → upload button disabled
 *     [Alt3] non-empty altRu → upload button enabled
 *
 *   ─── Upload mutation contract ────────────────────────────────────
 *     [U1] upload click sends file + altRu (trimmed)
 *     [U2] altEn empty → mutation gets vars WITHOUT altEn key
 *     [U3] altEn provided → mutation gets vars WITH altEn key
 *
 *   ─── Existing media row interactions ─────────────────────────────
 *     [M1] derivedReady=true → "Обработано" badge visible
 *     [M2] derivedReady=false → "В обработке" badge visible
 *     [M3] isHero=true → "Hero" badge visible, "Сделать hero" button NOT shown
 *     [M4] isHero=false → "Сделать hero" button visible
 *     [M5] isHero=false + altRu="" → setHero button disabled (invariant guard)
 *     [M6] isHero=false + altRu="X" → setHero button enabled
 *     [M7] alt edited → "Сохранить alt" button enabled (altDirty)
 *     [M8] alt unchanged → "Сохранить alt" button disabled
 *
 *   ─── a11y ────────────────────────────────────────────────────────
 *     [A1] section labelled by h2 via aria-labelledby
 */
import { hasPermission, type MemberRole, type PropertyMedia } from '@horeca/shared'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../../lib/use-can.ts', () => ({
	useCan: vi.fn(() => true),
	useCurrentRole: vi.fn(() => 'owner'),
}))

vi.mock('../hooks/use-media.ts', () => ({
	useMediaList: vi.fn(() => ({ data: [], isLoading: false, error: null })),
	useUploadMedia: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
	usePatchMedia: vi.fn(() => ({ mutate: vi.fn() })),
	useDeleteMedia: vi.fn(() => ({ mutate: vi.fn() })),
	useSetHero: vi.fn(() => ({ mutate: vi.fn() })),
}))

import { useCan } from '../../../lib/use-can.ts'
import {
	useDeleteMedia,
	useMediaList,
	usePatchMedia,
	useSetHero,
	useUploadMedia,
} from '../hooks/use-media.ts'
import { MediaStep } from './media-step.tsx'

const mockedUseCan = vi.mocked(useCan)
const mockedUseList = vi.mocked(useMediaList)
const mockedUpload = vi.mocked(useUploadMedia)
const mockedPatch = vi.mocked(usePatchMedia)
const mockedDelete = vi.mocked(useDeleteMedia)
const mockedSetHero = vi.mocked(useSetHero)

beforeEach(() => {
	mockedUseCan.mockImplementation(() => true)
	mockedUseList.mockReturnValue({
		data: [],
		isLoading: false,
		error: null,
	} as unknown as ReturnType<typeof useMediaList>)
	const stubMut = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
	mockedUpload.mockReturnValue(stubMut as unknown as ReturnType<typeof useUploadMedia>)
	mockedPatch.mockReturnValue(stubMut as unknown as ReturnType<typeof usePatchMedia>)
	mockedDelete.mockReturnValue(stubMut as unknown as ReturnType<typeof useDeleteMedia>)
	mockedSetHero.mockReturnValue(stubMut as unknown as ReturnType<typeof useSetHero>)
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

function setRole(role: MemberRole) {
	mockedUseCan.mockImplementation((perms) => hasPermission(role, perms))
}

const ROW = (overrides: Partial<PropertyMedia> = {}): PropertyMedia => ({
	tenantId: 'org-test',
	propertyId: 'prop_x',
	roomTypeId: null,
	mediaId: 'med_1',
	kind: 'photo',
	originalKey: 'media-original/org-test/prop_x/med_1.jpg',
	mimeType: 'image/jpeg',
	widthPx: 1920,
	heightPx: 1080,
	fileSizeBytes: 500_000n,
	exifStripped: true,
	derivedReady: true,
	sortOrder: 0,
	isHero: false,
	altRu: 'Вид на море',
	altEn: null,
	captionRu: null,
	captionEn: null,
	createdAt: '2026-04-27T00:00:00.000Z',
	updatedAt: '2026-04-27T00:00:00.000Z',
	...overrides,
})

function fileWithSize(name: string, type: string, sizeBytes: number): File {
	const blob = new Blob([new Uint8Array(sizeBytes)], { type })
	return new File([blob], name, { type })
}

// ────────────────────────────────────────────────────────────────────
// RBAC matrix
// ────────────────────────────────────────────────────────────────────

describe('<MediaStep> — RBAC matrix', () => {
	test('[R1] owner — file input enabled, no readonly Alert', () => {
		setRole('owner')
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.queryByText('Только просмотр')).toBeNull()
		expect((screen.getByLabelText('Выбрать файл') as HTMLInputElement).disabled).toBe(false)
	})

	test('[R2] manager — file input enabled (manager has CRUD on media)', () => {
		setRole('manager')
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.queryByText('Только просмотр')).toBeNull()
		expect((screen.getByLabelText('Выбрать файл') as HTMLInputElement).disabled).toBe(false)
	})

	test('[R3] staff — readonly Alert + file input disabled', () => {
		setRole('staff')
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByText('Только просмотр')).toBeTruthy()
		expect((screen.getByLabelText('Выбрать файл') as HTMLInputElement).disabled).toBe(true)
	})
})

// ────────────────────────────────────────────────────────────────────
// Branches
// ────────────────────────────────────────────────────────────────────

describe('<MediaStep> — branches', () => {
	test('[B1] isLoading=true → "Загрузка…"', () => {
		mockedUseList.mockReturnValue({
			data: undefined,
			isLoading: true,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByText('Загрузка…')).toBeTruthy()
		expect(screen.queryByLabelText('Выбрать файл')).toBeNull()
	})

	test('[B2] error → destructive Alert + message', () => {
		mockedUseList.mockReturnValue({
			data: undefined,
			isLoading: false,
			error: { message: 'oops' } as unknown as Error,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByText('Ошибка загрузки')).toBeTruthy()
		expect(screen.getByText('oops')).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// List counters (RU plural)
// ────────────────────────────────────────────────────────────────────

describe('<MediaStep> — list rendering', () => {
	test('[L1] empty list → placeholder + "Загружено: 0 файлов"', () => {
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByText('Пока нет фото.')).toBeTruthy()
		expect(screen.getByText(/Загружено: 0 файлов/)).toBeTruthy()
	})

	test('[L2] one media → counter "1 файл" (RU singular)', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1' })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByText('Загружено: 1 файл')).toBeTruthy()
	})

	test('[L3] three media → counter "3 файлов"', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1' }), ROW({ mediaId: 'm2' }), ROW({ mediaId: 'm3' })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByText('Загружено: 3 файлов')).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// Preflight (client-side validation)
// ────────────────────────────────────────────────────────────────────

describe('<MediaStep> — preflight', () => {
	test('[P1] empty file → exact "Файл пуст" alert', () => {
		render(<MediaStep propertyId="prop_x" />)
		const input = screen.getByLabelText('Выбрать файл') as HTMLInputElement
		const empty = fileWithSize('empty.jpg', 'image/jpeg', 0)
		fireEvent.change(input, { target: { files: [empty] } })
		expect(screen.getByText('Файл пуст')).toBeTruthy()
		// File panel should NOT appear
		expect(screen.queryByText(/altRu \(обязательно\)/)).toBeNull()
	})

	test('[P2] >50MB file → exact "Файл больше 50 МБ" alert', () => {
		render(<MediaStep propertyId="prop_x" />)
		const input = screen.getByLabelText('Выбрать файл') as HTMLInputElement
		const huge = fileWithSize('huge.jpg', 'image/jpeg', 50 * 1024 * 1024 + 1)
		fireEvent.change(input, { target: { files: [huge] } })
		expect(screen.getByText('Файл больше 50 МБ')).toBeTruthy()
	})

	test('[P3] disallowed MIME → alert mentions MIME and supported list', () => {
		render(<MediaStep propertyId="prop_x" />)
		const input = screen.getByLabelText('Выбрать файл') as HTMLInputElement
		const txt = fileWithSize('bad.txt', 'text/plain', 1024)
		fireEvent.change(input, { target: { files: [txt] } })
		expect(
			screen.getByText('Неподдерживаемый формат: text/plain. Разрешены JPEG/PNG/HEIC/WebP.'),
		).toBeTruthy()
	})

	test('[P4] valid JPEG → no error, altRu input panel appears', () => {
		render(<MediaStep propertyId="prop_x" />)
		const input = screen.getByLabelText('Выбрать файл') as HTMLInputElement
		const ok = fileWithSize('ok.jpg', 'image/jpeg', 1024)
		fireEvent.change(input, { target: { files: [ok] } })
		expect(screen.queryByText('Не удалось принять файл')).toBeNull()
		expect(screen.getByLabelText('altRu (обязательно)')).toBeTruthy()
		expect(screen.getByLabelText('altEn (опционально)')).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// altRu invariant on upload
// ────────────────────────────────────────────────────────────────────

describe('<MediaStep> — altRu invariant', () => {
	function pickValidFile() {
		render(<MediaStep propertyId="prop_x" />)
		const input = screen.getByLabelText('Выбрать файл') as HTMLInputElement
		const ok = fileWithSize('ok.jpg', 'image/jpeg', 1024)
		fireEvent.change(input, { target: { files: [ok] } })
	}

	test('[Alt1] empty altRu → upload button disabled', () => {
		pickValidFile()
		const btn = screen.getByRole('button', { name: 'Загрузить и обработать' })
		expect((btn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[Alt2] whitespace-only altRu → upload button disabled', () => {
		pickValidFile()
		fireEvent.change(screen.getByLabelText('altRu (обязательно)'), {
			target: { value: '   ' },
		})
		const btn = screen.getByRole('button', { name: 'Загрузить и обработать' })
		expect((btn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[Alt3] non-empty altRu → upload button enabled', () => {
		pickValidFile()
		fireEvent.change(screen.getByLabelText('altRu (обязательно)'), {
			target: { value: 'Море' },
		})
		const btn = screen.getByRole('button', { name: 'Загрузить и обработать' })
		expect((btn as HTMLButtonElement).disabled).toBe(false)
	})
})

// ────────────────────────────────────────────────────────────────────
// Upload mutation contract
// ────────────────────────────────────────────────────────────────────

describe('<MediaStep> — upload mutation', () => {
	function setUpload(): ReturnType<typeof vi.fn> {
		const mutateAsync = vi.fn().mockResolvedValue({})
		mockedUpload.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof useUploadMedia>)
		return mutateAsync
	}

	test('[U1] upload sends file + trimmed altRu', async () => {
		const mutateAsync = setUpload()
		render(<MediaStep propertyId="prop_x" />)
		const input = screen.getByLabelText('Выбрать файл') as HTMLInputElement
		const ok = fileWithSize('ok.jpg', 'image/jpeg', 1024)
		fireEvent.change(input, { target: { files: [ok] } })
		fireEvent.change(screen.getByLabelText('altRu (обязательно)'), {
			target: { value: '  Описание  ' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Загрузить и обработать' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
		const arg = mutateAsync.mock.calls[0]?.[0] as { file: File; altRu: string }
		expect(arg.altRu).toBe('Описание')
		expect(arg.file).toBe(ok)
	})

	test('[U2] altEn empty → vars object has NO altEn key', async () => {
		const mutateAsync = setUpload()
		render(<MediaStep propertyId="prop_x" />)
		const input = screen.getByLabelText('Выбрать файл') as HTMLInputElement
		fireEvent.change(input, {
			target: { files: [fileWithSize('ok.jpg', 'image/jpeg', 1024)] },
		})
		fireEvent.change(screen.getByLabelText('altRu (обязательно)'), {
			target: { value: 'A' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Загрузить и обработать' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as Record<string, unknown>
		expect('altEn' in arg).toBe(false)
	})

	test('[U3] altEn provided → vars include trimmed altEn', async () => {
		const mutateAsync = setUpload()
		render(<MediaStep propertyId="prop_x" />)
		const input = screen.getByLabelText('Выбрать файл') as HTMLInputElement
		fireEvent.change(input, {
			target: { files: [fileWithSize('ok.jpg', 'image/jpeg', 1024)] },
		})
		fireEvent.change(screen.getByLabelText('altRu (обязательно)'), {
			target: { value: 'A' },
		})
		fireEvent.change(screen.getByLabelText('altEn (опционально)'), {
			target: { value: '  Sea view  ' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Загрузить и обработать' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const arg = mutateAsync.mock.calls[0]?.[0] as { altEn: string }
		expect(arg.altEn).toBe('Sea view')
	})
})

// ────────────────────────────────────────────────────────────────────
// Existing media row UI
// ────────────────────────────────────────────────────────────────────

describe('<MediaStep> — media row interactions', () => {
	test('[M1] derivedReady=true → "Обработано" badge', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1', derivedReady: true })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByText('Обработано')).toBeTruthy()
		expect(screen.queryByText('В обработке')).toBeNull()
	})

	test('[M2] derivedReady=false → "В обработке" badge', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1', derivedReady: false })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByText('В обработке')).toBeTruthy()
		expect(screen.queryByText('Обработано')).toBeNull()
	})

	test('[M3] isHero=true → "Hero" badge + NO "Сделать hero" button', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1', isHero: true })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByText('Hero')).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Сделать hero' })).toBeNull()
	})

	test('[M4] isHero=false → "Сделать hero" button visible', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1', isHero: false })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		expect(screen.getByRole('button', { name: 'Сделать hero' })).toBeTruthy()
	})

	test('[M5] isHero=false + altRu="" → setHero button disabled (invariant guard)', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1', isHero: false, altRu: '' })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		const btn = screen.getByRole('button', { name: 'Сделать hero' })
		expect((btn as HTMLButtonElement).disabled).toBe(true)
	})

	test('[M6] isHero=false + altRu="X" → setHero button enabled', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1', isHero: false, altRu: 'Море' })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		const btn = screen.getByRole('button', { name: 'Сделать hero' })
		expect((btn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[M7] alt edited (dirty) → "Сохранить alt" button enabled', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1', altRu: 'Original' })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		// Find the row's altRu input. Since the row's input has no static
		// label text (label says just "altRu"), find via container.
		const labels = screen.getAllByText('altRu')
		// One label inside the row (the row's editable field).
		const inRowLabel = labels.find((l) => l.tagName === 'LABEL')
		const inputId = inRowLabel?.getAttribute('for')
		const input = document.getElementById(inputId!) as HTMLInputElement
		fireEvent.change(input, { target: { value: 'Edited' } })
		const btn = screen.getByRole('button', { name: 'Сохранить alt' })
		expect((btn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[M8] alt unchanged → "Сохранить alt" button disabled', () => {
		mockedUseList.mockReturnValue({
			data: [ROW({ mediaId: 'm1', altRu: 'Original' })],
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useMediaList>)
		render(<MediaStep propertyId="prop_x" />)
		const btn = screen.getByRole('button', { name: 'Сохранить alt' })
		expect((btn as HTMLButtonElement).disabled).toBe(true)
	})
})

// ────────────────────────────────────────────────────────────────────
// a11y
// ────────────────────────────────────────────────────────────────────

describe('<MediaStep> — a11y', () => {
	test('[A1] section labelled by h2 via aria-labelledby', () => {
		render(<MediaStep propertyId="prop_x" />)
		const section = screen.getByRole('region', { name: 'Фото гостиницы' })
		const h2 = within(section).getByRole('heading', { level: 2, name: 'Фото гостиницы' })
		expect(section.getAttribute('aria-labelledby')).toBe(h2.id)
	})
})
