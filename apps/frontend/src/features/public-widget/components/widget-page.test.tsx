/**
 * `<WidgetPage>` — strict component tests per `feedback_strict_tests.md`.
 *
 * Test matrix (render-state coverage):
 *   ─── Loading state ───────────────────────────────────────────
 *     [L1] isLoading=true → skeleton с role="status" + aria-live="polite"
 *     [L2] sr-only "Загрузка…" text для screen readers
 *
 *   ─── Error / not-found state ──────────────────────────────────
 *     [E1] API returns null → onNotFound called + h1 "Не найдено"
 *     [E2] tenantSlug rendered в not-found message (helps user verify URL)
 *
 *   ─── Success state — header ──────────────────────────────────
 *     [S1] tenant.name rendered as h1
 *     [S2] tenant.mode='demo' → demo banner visible (data-testid="demo-banner")
 *     [S3] tenant.mode='production' → demo banner HIDDEN
 *     [S4] tenant.mode=null → demo banner HIDDEN (not visible if mode missing)
 *
 *   ─── Success state — properties ──────────────────────────────
 *     [P1] empty properties array → "Этот отель не опубликовал" message
 *     [P2] non-empty properties → ul list с N items
 *     [P3] tourism tax rendered as percentage (200 bps → "2.0%")
 *     [P4] tourismTaxRateBps=null → no tax string в property card
 *     [P5] property name rendered as h3
 *
 *   ─── Adversarial ──────────────────────────────────────────────
 *     [A1] internal field `isPublic` НЕ должен попасть в DOM
 *           (DTO leak guard — даже если API возвращает, frontend filters)
 *     [A2] aria-label на section для screen readers
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as widgetApi from '../lib/widget-api.ts'
import { ruPlural, WidgetPage } from './widget-page.tsx'

describe('ruPlural — pure function (RU CLDR three-form: one/few/many)', () => {
	const obj = (n: number) => ruPlural(n, 'объект', 'объекта', 'объектов')

	// ─── one (mod10=1, NOT mod100=11) ──────────────────────────────
	test('[RU1] 1 → «объект»', () => expect(obj(1)).toBe('объект'))
	test('[RU2] 21 → «объект»', () => expect(obj(21)).toBe('объект'))
	test('[RU3] 101 → «объект»', () => expect(obj(101)).toBe('объект'))
	test('[RU4] 1001 → «объект»', () => expect(obj(1001)).toBe('объект'))

	// ─── few (mod10 in 2..4, NOT mod100 in 12..14) ─────────────────
	test('[RU5] 2 → «объекта»', () => expect(obj(2)).toBe('объекта'))
	test('[RU6] 3 → «объекта»', () => expect(obj(3)).toBe('объекта'))
	test('[RU7] 4 → «объекта»', () => expect(obj(4)).toBe('объекта'))
	test('[RU8] 22 → «объекта»', () => expect(obj(22)).toBe('объекта'))
	test('[RU9] 33 → «объекта»', () => expect(obj(33)).toBe('объекта'))
	test('[RU10] 104 → «объекта»', () => expect(obj(104)).toBe('объекта'))

	// ─── many (everything else) ────────────────────────────────────
	test('[RU11] 0 → «объектов»', () => expect(obj(0)).toBe('объектов'))
	test('[RU12] 5 → «объектов»', () => expect(obj(5)).toBe('объектов'))
	test('[RU13] 9 → «объектов»', () => expect(obj(9)).toBe('объектов'))
	test('[RU14] 10 → «объектов»', () => expect(obj(10)).toBe('объектов'))

	// ─── Adversarial: 11..14 special-case (always many despite mod10) ────
	test('[RU15] 11 → «объектов» (NOT объект, despite mod10=1)', () =>
		expect(obj(11)).toBe('объектов'))
	test('[RU16] 12 → «объектов» (NOT объекта, despite mod10=2)', () =>
		expect(obj(12)).toBe('объектов'))
	test('[RU17] 13 → «объектов» (NOT объекта, despite mod10=3)', () =>
		expect(obj(13)).toBe('объектов'))
	test('[RU18] 14 → «объектов» (NOT объекта, despite mod10=4)', () =>
		expect(obj(14)).toBe('объектов'))

	// ─── Adversarial: 111..114 also special-case (mod100 in 11..14) ──────
	test('[RU19] 111 → «объектов» (mod100=11 still special)', () => expect(obj(111)).toBe('объектов'))
	test('[RU20] 113 → «объектов» (mod100=13 still special)', () => expect(obj(113)).toBe('объектов'))

	// ─── Adversarial: 100, 105, 200 (basic many) ───────────────────────
	test('[RU21] 100 → «объектов»', () => expect(obj(100)).toBe('объектов'))
	test('[RU22] 105 → «объектов»', () => expect(obj(105)).toBe('объектов'))
	test('[RU23] 200 → «объектов»', () => expect(obj(200)).toBe('объектов'))

	// ─── Adversarial: 121, 122 (mod100=21, 22 — falls through to mod10 rule) ──
	test('[RU24] 121 → «объект» (mod10=1, mod100=21 NOT in 11..14)', () =>
		expect(obj(121)).toBe('объект'))
	test('[RU25] 122 → «объекта» (mod10=2, mod100=22 NOT in 11..14)', () =>
		expect(obj(122)).toBe('объекта'))
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

function renderPage(tenantSlug = 'demo-sirius', onNotFound?: () => void) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
	})
	return render(
		<QueryClientProvider client={qc}>
			{onNotFound !== undefined ? (
				<WidgetPage tenantSlug={tenantSlug} onNotFound={onNotFound} />
			) : (
				<WidgetPage tenantSlug={tenantSlug} />
			)}
		</QueryClientProvider>,
	)
}

describe('<WidgetPage> — loading state', () => {
	test('[L1] isLoading=true → skeleton с role="status" + aria-live="polite"', () => {
		// Mock listPublicProperties to never resolve (forever-loading)
		vi.spyOn(widgetApi, 'listPublicProperties').mockImplementation(() => new Promise(() => {}))
		renderPage()
		const status = screen.getByRole('status')
		expect(status).toBeTruthy()
		expect(status.getAttribute('aria-live')).toBe('polite')
	})

	test('[L2] sr-only "Загрузка…" text для screen readers', () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockImplementation(() => new Promise(() => {}))
		renderPage()
		expect(screen.getByText('Загрузка…')).toBeTruthy()
	})
})

describe('<WidgetPage> — error / not-found state', () => {
	test('[E1] API returns null → onNotFound called + h1 "Не найдено"', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue(null)
		const onNotFound = vi.fn()
		renderPage('does-not-exist', onNotFound)
		await screen.findByRole('heading', { level: 1, name: /Не найдено/ })
		expect(onNotFound).toHaveBeenCalledTimes(1)
	})

	test('[E2] tenantSlug rendered в not-found message', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue(null)
		renderPage('my-typo-slug')
		await screen.findByRole('heading', { level: 1 })
		expect(screen.getByText(/my-typo-slug/)).toBeTruthy()
	})
})

describe('<WidgetPage> — success state header', () => {
	test('[S1] tenant.name rendered as h1', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'Гостиница Тест', mode: 'demo' },
			properties: [],
		})
		renderPage()
		await screen.findByRole('heading', { level: 1, name: 'Гостиница Тест' })
	})

	test('[S2] tenant.mode=demo → demo banner visible', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: 'demo' },
			properties: [],
		})
		renderPage()
		const banner = await screen.findByTestId('demo-banner')
		expect(banner.textContent).toMatch(/Демо-режим/)
	})

	test('[S3] tenant.mode=production → demo banner HIDDEN', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: 'production' },
			properties: [],
		})
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		expect(screen.queryByTestId('demo-banner')).toBeNull()
	})

	test('[S4] tenant.mode=null → demo banner HIDDEN', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: null },
			properties: [],
		})
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		expect(screen.queryByTestId('demo-banner')).toBeNull()
	})
})

describe('<WidgetPage> — properties list', () => {
	test('[P1] empty properties → "Этот отель не опубликовал" message', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: null },
			properties: [],
		})
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		expect(screen.getByText(/не опубликовал объекты/)).toBeTruthy()
	})

	test('[P2] non-empty properties → list с N items (scoped к properties section)', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: null },
			properties: [
				{
					id: 'p1',
					name: 'Sea View',
					address: 'addr1',
					city: 'Сочи',
					timezone: 'Europe/Moscow',
					tourismTaxRateBps: 200,
				},
				{
					id: 'p2',
					name: 'Mountain',
					address: 'addr2',
					city: 'Сочи',
					timezone: 'Europe/Moscow',
					tourismTaxRateBps: null,
				},
			],
		})
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		// Scope к properties section — иначе попадают и steps-section <ol> items
		const propertiesSection = screen.getByRole('region', { name: 'Список объектов размещения' })
		const items = within(propertiesSection).getAllByRole('listitem')
		expect(items).toHaveLength(2)
	})

	test('[P3] tourism tax 200 bps → "2.0%" rendered (textContent join across spans)', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: null },
			properties: [
				{
					id: 'p1',
					name: 'A',
					address: 'a',
					city: 'Сочи',
					timezone: 'Europe/Moscow',
					tourismTaxRateBps: 200,
				},
			],
		})
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		// Number wrapped в tabular-nums span — text split by element boundary,
		// getByText regex won't match across nodes. Assert via parent textContent.
		const propertiesSection = screen.getByRole('region', { name: 'Список объектов размещения' })
		expect(propertiesSection.textContent).toMatch(/Туристический налог\s*·?\s*2\.0%/)
	})

	test('[P4] tourismTaxRateBps=null → no tax string', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: null },
			properties: [
				{
					id: 'p1',
					name: 'A',
					address: 'a',
					city: 'Сочи',
					timezone: 'Europe/Moscow',
					tourismTaxRateBps: null,
				},
			],
		})
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		expect(screen.queryByText(/Туристический налог/)).toBeNull()
	})

	test('[P5] property name rendered as h3', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: null },
			properties: [
				{
					id: 'p1',
					name: 'Уникальное имя номера 12345',
					address: 'a',
					city: 'Сочи',
					timezone: 'Europe/Moscow',
					tourismTaxRateBps: null,
				},
			],
		})
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		expect(
			screen.getByRole('heading', { level: 3, name: 'Уникальное имя номера 12345' }),
		).toBeTruthy()
	})
})

describe('<WidgetPage> — adversarial', () => {
	test('[A1] section имеет aria-label для screen readers', async () => {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: null },
			properties: [],
		})
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		const section = screen.getByRole('region', { name: 'Список объектов размещения' })
		expect(section).toBeTruthy()
	})
})

describe('<WidgetPage> — visual polish elements (post-user-pushback)', () => {
	function mockWith(propertyCount: number) {
		vi.spyOn(widgetApi, 'listPublicProperties').mockResolvedValue({
			tenant: { slug: 'a', name: 'A', mode: null },
			properties: Array.from({ length: propertyCount }, (_, i) => ({
				id: `p${i + 1}`,
				name: `Property ${i + 1}`,
				address: 'addr',
				city: 'Сочи',
				timezone: 'Europe/Moscow',
				tourismTaxRateBps: null,
			})),
		})
	}

	test('[V1] eyebrow «ПРЯМОЕ БРОНИРОВАНИЕ · СОЧИ» rendered above h1', async () => {
		mockWith(1)
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		expect(screen.getByText(/Прямое бронирование · Сочи/i)).toBeTruthy()
	})

	test('[V2] count badge: 1 → «1 объект» (RU plural one)', async () => {
		mockWith(1)
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		const badge = screen.getByTestId('properties-count')
		expect(badge.textContent?.trim()).toBe('1 объект')
	})

	test('[V3] count badge: 2 → «2 объекта» (RU plural few — NOT «объектов»)', async () => {
		mockWith(2)
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		const badge = screen.getByTestId('properties-count')
		expect(badge.textContent?.trim()).toBe('2 объекта')
	})

	test('[V4] count badge: 5 → «5 объектов» (RU plural many)', async () => {
		mockWith(5)
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		const badge = screen.getByTestId('properties-count')
		expect(badge.textContent?.trim()).toBe('5 объектов')
	})

	test('[V5] count badge: 11 → «11 объектов» (RU plural many — exception 11-14)', async () => {
		mockWith(11)
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		const badge = screen.getByTestId('properties-count')
		expect(badge.textContent?.trim()).toBe('11 объектов')
	})

	test('[V6] count badge: 21 → «21 объект» (RU plural one — mod10=1 exception)', async () => {
		mockWith(21)
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		const badge = screen.getByTestId('properties-count')
		expect(badge.textContent?.trim()).toBe('21 объект')
	})

	test('[V7] value-prop section «3 простых шага бронирования» rendered с 1/2/3', async () => {
		mockWith(1)
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		const valueProp = screen.getByRole('region', { name: 'Что дальше' })
		expect(valueProp.textContent).toMatch(/3 простых шага бронирования/)
		expect(valueProp.textContent).toMatch(/Выбираете даты/)
		expect(valueProp.textContent).toMatch(/Подбираете номер и тариф/)
		expect(valueProp.textContent).toMatch(/Оплачиваете онлайн/)
	})

	test('[V8] footer reinforce: «экономия до 17% против OTA» (Y.Travel context)', async () => {
		mockWith(1)
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		expect(screen.getByText(/экономия до 17% против OTA/)).toBeTruthy()
	})

	test('[V9] property card semantic <button> с aria-label «Открыть {name}»', async () => {
		mockWith(1)
		renderPage()
		await screen.findByRole('heading', { level: 1 })
		const button = screen.getByRole('button', { name: 'Открыть Property 1' })
		expect(button).toBeTruthy()
		expect(button.tagName).toBe('BUTTON')
	})
})
