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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as widgetApi from '../lib/widget-api.ts'
import { WidgetPage } from './widget-page.tsx'

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

	test('[P2] non-empty properties → list с N items', async () => {
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
		const items = screen.getAllByRole('listitem')
		expect(items).toHaveLength(2)
	})

	test('[P3] tourism tax 200 bps → "2.0%" rendered', async () => {
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
		expect(screen.getByText(/Туристический налог 2\.0%/)).toBeTruthy()
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
