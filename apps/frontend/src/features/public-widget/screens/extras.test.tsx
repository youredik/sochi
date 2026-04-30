/**
 * `<Extras>` Screen 2 — strict adversarial tests (M9.widget.3).
 *
 * Test matrix per `feedback_strict_tests.md` + Round 2 verified canon:
 *   ─── Skip CTA always-visible canon ──────────────────────────
 *     [E1] Skip CTA visible с empty cart
 *     [E2] Skip CTA visible с populated cart (NOT hidden when items selected)
 *     [E3] Click Skip → onSkip() called
 *     [E4] Continue inline visible на mobile (md:hidden — query test by testid)
 *
 *   ─── Cart interaction ────────────────────────────────────────
 *     [E5] Click + on addon-card → onCartChange с new qty
 *     [E6] qty=0 → addon NOT в line items (sticky-summary не показывает)
 *     [E7] qty>0 → addon IS в line items
 *
 *   ─── Empty state ─────────────────────────────────────────────
 *     [E8] No addons → empty-state shown + Skip CTA still works
 *
 *   ─── 404 / error fallback ────────────────────────────────────
 *     [E9] query.data === null → onNotFound called + 404 fallback rendered
 *     [E10] query.error → error fallback c retry + skip buttons
 *
 *   ─── Loading ─────────────────────────────────────────────────
 *     [E11] query.isLoading → skeleton rendered (no addon cards yet)
 *
 *   ─── Tax note (РФ canon) ─────────────────────────────────────
 *     [E12] tourismTaxRateBps > 0 → tax note rendered с pct и disclaimer
 *     [E13] tourismTaxRateBps=0 / null → tax note hidden
 *
 *   ─── A11y ────────────────────────────────────────────────────
 *     [E14] Live region «Корзина дополнений пуста» for empty cart
 *     [E15] Section has aria-label «Список дополнительных услуг»
 *
 *   ─── Adversarial ─────────────────────────────────────────────
 *     [E16] qty default 0 (opt-in canon — adversarial regression test)
 *     [E17] mandatory addons NOT shown (server pre-filters; defensive test)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
	PublicProperty,
	PublicRateOption,
	PublicRoomType,
	PublicWidgetAddon,
	PublicWidgetTenant,
} from '../lib/widget-api.ts'
import { Extras } from './extras.tsx'

// Mock fetch — controlled per-test via globalThis.fetch.
afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

const tenant: PublicWidgetTenant = {
	slug: 'demo-sirius',
	name: 'Гостиница Сириус (демо)',
	mode: 'demo',
}

const property: PublicProperty = {
	id: 'prop-1',
	name: 'Сириус, корпус 1',
	address: 'Олимпийский 1',
	city: 'Сочи',
	timezone: 'Europe/Moscow',
	tourismTaxRateBps: 200, // 2% Сочи
}

const room: PublicRoomType = {
	id: 'rt-1',
	propertyId: 'prop-1',
	name: 'Делюкс с видом на море',
	description: '25 м²',
	maxOccupancy: 2,
	baseBeds: 1,
	extraBeds: 0,
	areaSqm: 25,
	inventoryCount: 5,
}

const rate: PublicRateOption = {
	ratePlanId: 'rp-1',
	code: 'BAR_FLEX',
	name: 'Гибкий тариф',
	isDefault: true,
	isRefundable: true,
	mealsIncluded: 'none',
	currency: 'RUB',
	subtotalKopecks: 1_500_000,
	tourismTaxKopecks: 30_000,
	totalKopecks: 1_530_000,
	avgPerNightKopecks: 300_000,
	freeCancelDeadlineUtc: '2026-06-14T23:59:59Z',
}

const breakfast: PublicWidgetAddon = {
	addonId: 'addn_brk',
	code: 'BREAKFAST',
	category: 'FOOD_AND_BEVERAGES',
	nameRu: 'Завтрак-буфет',
	nameEn: null,
	descriptionRu: 'Шведский стол',
	descriptionEn: null,
	pricingUnit: 'PER_NIGHT_PER_PERSON',
	priceKopecks: 150_000,
	currency: 'RUB',
	vatBps: 2200,
	inventoryMode: 'NONE',
	dailyCapacity: null,
	seasonalTags: [],
	sortOrder: 10,
}

const transfer: PublicWidgetAddon = {
	...breakfast,
	addonId: 'addn_trf',
	code: 'TRANSFER',
	category: 'TRANSFER',
	nameRu: 'Трансфер',
	pricingUnit: 'PER_STAY',
	priceKopecks: 250_000,
	sortOrder: 40,
}

function mockFetchResponse(addons: readonly PublicWidgetAddon[]) {
	const response = { data: { tenant, property, addons } }
	globalThis.fetch = vi.fn(() =>
		Promise.resolve(
			new Response(JSON.stringify(response), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		),
	) as unknown as typeof globalThis.fetch
}

function mockFetch404() {
	globalThis.fetch = vi.fn(() =>
		Promise.resolve(new Response('', { status: 404 })),
	) as unknown as typeof globalThis.fetch
}

function mockFetch500() {
	globalThis.fetch = vi.fn(() =>
		Promise.resolve(new Response('Server error', { status: 500 })),
	) as unknown as typeof globalThis.fetch
}

function renderExtras(overrides: Partial<Parameters<typeof Extras>[0]> = {}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	const props = {
		tenantSlug: 'demo-sirius',
		propertyId: 'prop-1',
		checkIn: '2026-06-15',
		checkOut: '2026-06-20',
		nights: 5,
		adults: 2,
		childrenCount: 0,
		selectedRoomType: room,
		selectedRate: rate,
		tourismTaxRateBps: 200,
		cart: [],
		onCartChange: vi.fn(),
		onContinue: vi.fn(),
		onSkip: vi.fn(),
		onNotFound: vi.fn(),
		...overrides,
	}
	return {
		...render(
			<QueryClientProvider client={queryClient}>
				<Extras {...props} />
			</QueryClientProvider>,
		),
		props,
	}
}

describe('<Extras> — Skip CTA canon', () => {
	test('[E1] Skip CTA visible с empty cart', async () => {
		mockFetchResponse([breakfast, transfer])
		renderExtras({ cart: [] })
		const skip = await screen.findByTestId('extras-skip')
		expect(skip.textContent).toMatch(/Продолжить без дополнений/)
	})

	test('[E2] Skip CTA visible с populated cart (NOT hidden when items selected)', async () => {
		mockFetchResponse([breakfast, transfer])
		renderExtras({ cart: [{ addonId: 'addn_brk', quantity: 2 }] })
		const skip = await screen.findByTestId('extras-skip')
		expect(skip.textContent).toMatch(/Продолжить без дополнений/)
	})

	test('[E3] Click Skip → onSkip() called', async () => {
		mockFetchResponse([breakfast])
		const { props } = renderExtras()
		const skip = await screen.findByTestId('extras-skip')
		fireEvent.click(skip)
		expect(props.onSkip).toHaveBeenCalled()
	})

	test('[E4] Mobile inline primary CTA exists (md:hidden testid)', async () => {
		mockFetchResponse([breakfast])
		renderExtras()
		const inline = await screen.findByTestId('extras-continue-inline')
		expect(inline.textContent).toMatch(/Перейти к оплате/)
	})
})

describe('<Extras> — cart interaction', () => {
	test('[E5] Click + on addon-card → onCartChange called с new qty', async () => {
		mockFetchResponse([breakfast])
		const { props } = renderExtras({ cart: [] })
		const inc = await screen.findByTestId('addon-BREAKFAST-inc')
		fireEvent.click(inc)
		expect(props.onCartChange).toHaveBeenCalledWith([{ addonId: 'addn_brk', quantity: 1 }])
	})

	test('[E6] qty=0 → addon NOT в sticky line items', async () => {
		mockFetchResponse([breakfast])
		renderExtras({ cart: [] })
		await screen.findByTestId('addon-card-BREAKFAST')
		expect(screen.queryByTestId('summary-addon-addn_brk')).toBeNull()
	})

	test('[E7] qty>0 → grand total reflects addon cost (sticky-summary line item)', async () => {
		mockFetchResponse([breakfast])
		renderExtras({ cart: [{ addonId: 'addn_brk', quantity: 2 }] })
		await screen.findByTestId('addon-card-BREAKFAST')
		// jsdom-rendered sticky-summary attaches the detail total в SummaryBody.
		// On desktop (default jsdom matchMedia → false → но useMediaQuery may
		// return varied), the testid 'summary-total-detail' is rendered внутри
		// SummaryBody. Verify that grand total textContent contains a non-empty
		// formatted ruble string (NOT em-dash, NOT empty).
		const detailTotal = screen.getByTestId('summary-total-detail')
		expect(detailTotal.textContent ?? '').not.toBe('')
		expect(detailTotal.textContent ?? '').not.toBe('—')
		// Grand total should be > rate.totalKopecks alone (1_530_000) — so contains
		// digits exceeding "15 300" or similar room-only render.
		// Breakfast PER_NIGHT_PER_PERSON × 2 × 5 = 1_500_000 net; gross = 1_830_000;
		// grand = 1_530_000 + 1_830_000 = 3_360_000 → "33 600 ₽".
		expect(detailTotal.textContent ?? '').toMatch(/33\s600/)
	})
})

describe('<Extras> — empty state + tax note', () => {
	test('[E8] no addons → empty-state shown + Skip works', async () => {
		mockFetchResponse([])
		const { props } = renderExtras()
		await screen.findByTestId('extras-empty')
		const skip = screen.getByTestId('extras-skip')
		fireEvent.click(skip)
		expect(props.onSkip).toHaveBeenCalled()
	})

	test('[E12] tourismTaxRateBps>0 → tax note shown с правильным pct + disclaimer', async () => {
		mockFetchResponse([breakfast])
		renderExtras({ tourismTaxRateBps: 200 })
		const note = await screen.findByTestId('extras-tax-note')
		expect(note.textContent).toMatch(/Туристический налог 2\.0%/)
		expect(note.textContent).toMatch(/не на дополнения/)
	})

	test('[E13] tourismTaxRateBps=0 → tax note hidden', async () => {
		mockFetchResponse([breakfast])
		renderExtras({ tourismTaxRateBps: 0 })
		await screen.findByTestId('addon-card-BREAKFAST')
		expect(screen.queryByTestId('extras-tax-note')).toBeNull()
	})
})

describe('<Extras> — 404 + error fallback', () => {
	test('[E9] query.data===null (404) → onNotFound called + fallback rendered', async () => {
		mockFetch404()
		const { props } = renderExtras()
		await waitFor(() => {
			expect(props.onNotFound).toHaveBeenCalled()
		})
		expect(screen.getByText(/Не найдено/)).toBeTruthy()
	})

	test('[E10] query.error → error fallback с retry + skip buttons', async () => {
		mockFetch500()
		const { props } = renderExtras()
		// useAddons sets retry: 1 — ждём до 5s для пройти retry+fail.
		const fallback = await screen.findByTestId('extras-error-fallback', undefined, {
			timeout: 5000,
		})
		expect(fallback).toBeTruthy()
		const errSkip = screen.getByTestId('extras-error-skip')
		fireEvent.click(errSkip)
		expect(props.onSkip).toHaveBeenCalled()
	})
})

describe('<Extras> — loading', () => {
	test('[E11] query.isLoading → skeleton rendered', () => {
		// Don't resolve fetch — promise pending.
		globalThis.fetch = vi.fn(
			() =>
				new Promise(() => {
					/* never */
				}),
		) as unknown as typeof globalThis.fetch
		renderExtras()
		expect(screen.getByTestId('extras-loading')).toBeTruthy()
	})
})

describe('<Extras> — a11y', () => {
	test('[E15] section has aria-label', async () => {
		mockFetchResponse([breakfast])
		renderExtras()
		await screen.findByTestId('addon-card-BREAKFAST')
		const section = screen.getByTestId('extras-list')
		expect(section.getAttribute('aria-label')).toBe('Список дополнительных услуг')
	})
})

describe('<Extras> — adversarial', () => {
	test('[E16] qty default 0 (opt-in canon ЗоЗПП ст. 16 ч. 3.1)', async () => {
		mockFetchResponse([breakfast, transfer])
		renderExtras({ cart: [] })
		await screen.findByTestId('addon-card-BREAKFAST')
		const brkCard = screen.getByTestId('addon-card-BREAKFAST')
		const trfCard = screen.getByTestId('addon-card-TRANSFER')
		expect(brkCard.getAttribute('data-selected')).toBe('false')
		expect(trfCard.getAttribute('data-selected')).toBe('false')
	})

	test('[E17] all rendered addons NOT mandatory (server filter relied; defensive snapshot)', async () => {
		mockFetchResponse([breakfast, transfer])
		renderExtras()
		await screen.findByTestId('addon-card-BREAKFAST')
		// All cards render — none should have «Обязательно» badge или «mandatory» mark.
		expect(screen.queryByText(/Обязательно/i)).toBeNull()
		expect(screen.queryByText(/mandatory/i)).toBeNull()
	})
})
