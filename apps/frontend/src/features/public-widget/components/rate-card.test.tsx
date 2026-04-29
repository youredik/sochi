/**
 * `<RateCard>` — strict adversarial tests.
 *
 * Test matrix:
 *   ─── Sellable + rate options ──────────────────────────────
 *     [R1] Renders roomType name as h3
 *     [R2] Both rate options visible (BAR_FLEX + BAR_NR)
 *     [R3] Default rate has «Рекомендуем» badge
 *     [R4] Cheapest non-default rate has «Дешевле» badge
 *     [R5] Selected rate has data-selected="true"
 *     [R6] Click on rate calls onSelectRate с ratePlanId
 *     [R7] Free-cancel deadline shown for refundable, "Невозвратный" для NR
 *     [R8] Inventory low (≤3) badge shown
 *     [R9] Inventory > 3 → no badge
 *
 *   ─── Unsellable ────────────────────────────────────────────
 *     [U1] sellable=false → unsellable-badge shown, no rate options
 *     [U2] reason="sold_out" → "Нет доступных номеров" message
 *     [U3] reason="missing_availability" → "Нет данных о доступности"
 *
 *   ─── Adversarial ───────────────────────────────────────────
 *     [A1] roomType description rendered
 *     [A2] maxOccupancy badge shown
 *     [A3] No photo seeded → SVG placeholder rendered (no broken img)
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
	PublicAvailabilityOffering,
	PublicRateOption,
	PublicRoomType,
} from '../lib/widget-api.ts'
import { RateCard } from './rate-card.tsx'

afterEach(() => cleanup())

const room: PublicRoomType = {
	id: 'rt-1',
	propertyId: 'p-1',
	name: 'Deluxe Sea View',
	description: '25 м², балкон с видом на море',
	maxOccupancy: 2,
	baseBeds: 1,
	extraBeds: 0,
	areaSqm: 25,
	inventoryCount: 5,
}

const flex: PublicRateOption = {
	ratePlanId: 'rp-flex',
	code: 'BAR_FLEX',
	name: 'Гибкий тариф',
	isDefault: true,
	isRefundable: true,
	mealsIncluded: 'breakfast',
	currency: 'RUB',
	subtotalKopecks: 4_000_000,
	tourismTaxKopecks: 80_000,
	totalKopecks: 4_080_000,
	avgPerNightKopecks: 800_000,
	freeCancelDeadlineUtc: '2026-05-31T11:00:00.000Z',
}

const nr: PublicRateOption = {
	ratePlanId: 'rp-nr',
	code: 'BAR_NR',
	name: 'Невозвратный',
	isDefault: false,
	isRefundable: false,
	mealsIncluded: 'none',
	currency: 'RUB',
	subtotalKopecks: 3_600_000,
	tourismTaxKopecks: 72_000,
	totalKopecks: 3_672_000,
	avgPerNightKopecks: 720_000,
	freeCancelDeadlineUtc: null,
}

const sellableOffering: PublicAvailabilityOffering = {
	roomType: room,
	sellable: true,
	unsellableReason: null,
	inventoryRemaining: 5,
	rateOptions: [flex, nr],
}

describe('<RateCard>', () => {
	test('[R1] Room name renders as h3', () => {
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Deluxe Sea View')
	})

	test('[R2] Both rate options visible', () => {
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByTestId('rate-option-BAR_FLEX')).toBeTruthy()
		expect(screen.getByTestId('rate-option-BAR_NR')).toBeTruthy()
	})

	test('[R3] Default rate gets «Рекомендуем» badge', () => {
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		const flexOption = screen.getByTestId('rate-option-BAR_FLEX')
		expect(flexOption.textContent).toContain('Рекомендуем')
	})

	test('[R4] Cheapest non-default has «Дешевле» badge (NR is cheaper than Flex)', () => {
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		const nrOption = screen.getByTestId('rate-option-BAR_NR')
		expect(nrOption.textContent).toContain('Дешевле')
	})

	test('[R5] Selected rate has data-selected="true"', () => {
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId="rp-flex"
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		const flexOption = screen.getByTestId('rate-option-BAR_FLEX')
		expect(flexOption.getAttribute('data-selected')).toBe('true')
		expect(flexOption.getAttribute('aria-pressed')).toBe('true')
	})

	test('[R6] Click rate calls onSelectRate с ratePlanId', () => {
		const onSelect = vi.fn()
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={onSelect}
				nights={5}
			/>,
		)
		fireEvent.click(screen.getByTestId('rate-option-BAR_NR'))
		expect(onSelect).toHaveBeenCalledWith('rp-nr')
	})

	test('[R7] Refundable rate shows cancel deadline; NR shows "Невозвратный"', () => {
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByTestId('rate-option-BAR_FLEX').textContent).toContain('Бесплатная отмена')
		expect(screen.getByTestId('rate-option-BAR_NR').textContent).toContain('Невозвратный')
	})

	test('[R8] inventoryRemaining ≤3 shows low-stock badge', () => {
		render(
			<RateCard
				offering={{ ...sellableOffering, inventoryRemaining: 2 }}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByTestId('inventory-low').textContent).toContain('Осталось 2')
	})

	test('[R9] inventoryRemaining > 3 → no badge', () => {
		render(
			<RateCard
				offering={{ ...sellableOffering, inventoryRemaining: 5 }}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.queryByTestId('inventory-low')).toBeNull()
	})

	test('[U1] sellable=false → unsellable badge, no rate options', () => {
		const unsellable: PublicAvailabilityOffering = {
			roomType: room,
			sellable: false,
			unsellableReason: 'sold_out',
			inventoryRemaining: 0,
			rateOptions: [],
		}
		render(
			<RateCard
				offering={unsellable}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByTestId('unsellable-badge')).toBeTruthy()
		expect(screen.queryByTestId('rate-option-BAR_FLEX')).toBeNull()
	})

	test('[U2] reason=sold_out → message "Нет доступных номеров"', () => {
		const offering: PublicAvailabilityOffering = {
			roomType: room,
			sellable: false,
			unsellableReason: 'sold_out',
			inventoryRemaining: 0,
			rateOptions: [],
		}
		render(
			<RateCard
				offering={offering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByTestId('unsellable-badge').textContent).toContain('Нет доступных номеров')
	})

	test('[U3] reason=missing_availability → "Нет данных о доступности"', () => {
		const offering: PublicAvailabilityOffering = {
			roomType: room,
			sellable: false,
			unsellableReason: 'missing_availability',
			inventoryRemaining: 0,
			rateOptions: [],
		}
		render(
			<RateCard
				offering={offering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByTestId('unsellable-badge').textContent).toContain('Нет данных')
	})

	test('[A1] description rendered as paragraph', () => {
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByText(/балкон с видом на море/)).toBeTruthy()
	})

	test('[A2] maxOccupancy badge shown', () => {
		const { container } = render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(container.textContent).toContain('до 2')
	})

	test('[A3] No photo → SVG placeholder, no broken img', () => {
		const { container } = render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(container.querySelector('img')).toBeNull()
		expect(container.querySelector('svg')).toBeTruthy()
	})

	test('[A4] Total price exact RU money formatting (4 080 000 коп = 40 800 ₽)', () => {
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByTestId('rate-option-BAR_FLEX').textContent).toMatch(/40\s?800/)
	})

	test('[A5] Per-night avg shown с RU plural for nights count', () => {
		render(
			<RateCard
				offering={sellableOffering}
				photos={[]}
				selectedRatePlanId={null}
				onSelectRate={() => {}}
				nights={5}
			/>,
		)
		expect(screen.getByTestId('rate-option-BAR_FLEX').textContent).toMatch(/5 ночей/)
	})
})
