/**
 * `<AddonCard>` — strict adversarial tests (M9.widget.3).
 *
 * Test matrix per `feedback_strict_tests.md` + Round 2 compliance verified:
 *   ─── Opt-in canon (ЗоЗПП ст. 16 ч. 3.1) ────────────────────
 *     [AC1] qty=0 by default → no «selected» visual state (data-selected="false")
 *     [AC2] qty>0 → data-selected="true"
 *
 *   ─── Pricing display (ст. 10 ЗоЗПП) ─────────────────────────
 *     [AC3] Renders unit-price gross (с НДС) — НЕ net
 *     [AC4] Renders «в т.ч. НДС 22%» note when vatBps=2200
 *     [AC5] No NDS note when vatBps=0
 *     [AC6] Total gross shown when qty > 0
 *     [AC7] No total when qty = 0
 *
 *   ─── Cancellation disclosure (ПП РФ №1912) ──────────────────
 *     [AC8] «Бесплатная отмена до [checkIn]» rendered с corret date
 *
 *   ─── Quantity stepper interaction ────────────────────────────
 *     [AC9] Click + button → onChangeQuantity(qty + 1)
 *     [AC10] Click − button → onChangeQuantity(qty - 1)
 *     [AC11] − disabled at min (qty=0) — adversarial bound check
 *     [AC12] + disabled at max (e.g. PER_STAY max=5)
 *     [AC13] Native input change → onChangeQuantity called
 *
 *   ─── Pricing unit labels ─────────────────────────────────────
 *     [AC14] PER_NIGHT_PER_PERSON shows «/ гость / ночь»
 *     [AC15] PER_HOUR shows «/ час»
 *
 *   ─── A11y ────────────────────────────────────────────────────
 *     [AC16] aria-label on +/- buttons references addon name
 *     [AC17] Native input has aria-label
 *
 *   ─── Adversarial ─────────────────────────────────────────────
 *     [AC18] No «Recommended» / «AI-suggested» badges (38-ФЗ ст. 5)
 *     [AC19] qty=0 displays «0» в input (NOT empty / NOT hidden)
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PublicWidgetAddon } from '../lib/widget-api.ts'
import { AddonCard } from './addon-card.tsx'

afterEach(() => cleanup())

const breakfast: PublicWidgetAddon = {
	addonId: 'addn_brk',
	code: 'BREAKFAST',
	category: 'FOOD_AND_BEVERAGES',
	nameRu: 'Завтрак-буфет',
	nameEn: null,
	descriptionRu: 'Шведский стол с морепродуктами Чёрного моря.',
	descriptionEn: null,
	pricingUnit: 'PER_NIGHT_PER_PERSON',
	priceKopecks: 150_000, // 1500 ₽
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
}

const spa: PublicWidgetAddon = {
	...breakfast,
	addonId: 'addn_spa',
	code: 'SPA',
	category: 'WELLNESS',
	nameRu: 'СПА',
	pricingUnit: 'PER_HOUR',
	priceKopecks: 300_000,
}

const ctx = { nights: 5, persons: 2 }
const checkIn = '2026-06-15'

describe('<AddonCard> — opt-in canon ЗоЗПП ст. 16 ч. 3.1', () => {
	test('[AC1] qty=0 default → data-selected=false', () => {
		render(
			<AddonCard
				addon={breakfast}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		const card = screen.getByTestId('addon-card-BREAKFAST')
		expect(card.getAttribute('data-selected')).toBe('false')
	})

	test('[AC2] qty>0 → data-selected=true', () => {
		render(
			<AddonCard
				addon={breakfast}
				quantity={2}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		const card = screen.getByTestId('addon-card-BREAKFAST')
		expect(card.getAttribute('data-selected')).toBe('true')
	})
})

describe('<AddonCard> — pricing display (ст. 10 ЗоЗПП)', () => {
	test('[AC3] renders unit-price GROSS (с НДС), not net', () => {
		// breakfast: 150_000 net × (12200/10000) = 183_000 gross per unit (qty=1, 1 ночь, 1 гость).
		// PER_NIGHT_PER_PERSON: net at qty=1 = 150_000 × 1 × nights(5) = 750_000;
		// gross = floor(750_000 × 12200 / 10000) = 915_000.
		// formatRub(915_000) = "9 150 ₽" (NBSP separators per Intl.NumberFormat ru-RU)
		render(
			<AddonCard
				addon={breakfast}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		// `\s` matches NBSP (U+00A0) — Intl.NumberFormat ru-RU uses NBSP between groups.
		expect(screen.getByText(/9\s150/)).toBeTruthy()
	})

	test('[AC4] renders «в т.ч. НДС 22%» when vatBps=2200', () => {
		render(
			<AddonCard
				addon={breakfast}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		expect(screen.getByText(/в т\.ч\. НДС 22%/i)).toBeTruthy()
	})

	test('[AC5] no NDS note when vatBps=0', () => {
		const addon0: PublicWidgetAddon = { ...breakfast, vatBps: 0 }
		render(
			<AddonCard
				addon={addon0}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		expect(screen.queryByText(/в т\.ч\. НДС/)).toBeNull()
	})

	test('[AC6] total gross shown when qty>0 (testid present)', () => {
		render(
			<AddonCard
				addon={transfer}
				quantity={2}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		// transfer PER_STAY × qty=2: net 500_000, gross floor(610_000) = 610_000 → "6 100 ₽"
		// `\s` matches NBSP separators emitted by Intl.NumberFormat.
		const total = screen.getByTestId('addon-TRANSFER-total')
		expect(total.textContent).toMatch(/6\s100/)
	})

	test('[AC7] no total when qty=0 (no testid)', () => {
		render(
			<AddonCard
				addon={transfer}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		expect(screen.queryByTestId('addon-TRANSFER-total')).toBeNull()
	})
})

describe('<AddonCard> — cancellation disclosure (ПП РФ №1912)', () => {
	test('[AC8] «Бесплатная отмена до [checkIn]» rendered с корректной датой', () => {
		render(
			<AddonCard
				addon={breakfast}
				quantity={0}
				context={ctx}
				checkInIso="2026-06-15"
				onChangeQuantity={vi.fn()}
			/>,
		)
		expect(screen.getByText(/Бесплатная отмена до 15 июня 2026/)).toBeTruthy()
	})
})

describe('<AddonCard> — quantity stepper', () => {
	test('[AC9] click + → onChangeQuantity(qty + 1)', () => {
		const onChange = vi.fn()
		render(
			<AddonCard
				addon={transfer}
				quantity={1}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={onChange}
			/>,
		)
		fireEvent.click(screen.getByTestId('addon-TRANSFER-inc'))
		expect(onChange).toHaveBeenCalledWith(2)
	})

	test('[AC10] click − → onChangeQuantity(qty - 1)', () => {
		const onChange = vi.fn()
		render(
			<AddonCard
				addon={transfer}
				quantity={3}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={onChange}
			/>,
		)
		fireEvent.click(screen.getByTestId('addon-TRANSFER-dec'))
		expect(onChange).toHaveBeenCalledWith(2)
	})

	test('[AC11] − disabled at min (qty=0)', () => {
		render(
			<AddonCard
				addon={transfer}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		const dec = screen.getByTestId('addon-TRANSFER-dec') as HTMLButtonElement
		expect(dec.disabled).toBe(true)
	})

	test('[AC12] + disabled at max (PER_STAY max=5)', () => {
		render(
			<AddonCard
				addon={transfer}
				quantity={5}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		const inc = screen.getByTestId('addon-TRANSFER-inc') as HTMLButtonElement
		expect(inc.disabled).toBe(true)
	})

	test('[AC13] native input change → onChangeQuantity called', () => {
		const onChange = vi.fn()
		render(
			<AddonCard
				addon={transfer}
				quantity={1}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={onChange}
			/>,
		)
		const input = screen.getByTestId('addon-TRANSFER-qty') as HTMLInputElement
		fireEvent.change(input, { target: { value: '3' } })
		expect(onChange).toHaveBeenCalledWith(3)
	})
})

describe('<AddonCard> — pricing unit labels', () => {
	test('[AC14] PER_NIGHT_PER_PERSON shows «/ гость / ночь»', () => {
		render(
			<AddonCard
				addon={breakfast}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		expect(screen.getByText(/\/ гость \/ ночь/)).toBeTruthy()
	})

	test('[AC15] PER_HOUR shows «/ час»', () => {
		render(
			<AddonCard
				addon={spa}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		expect(screen.getByText(/\/ час/)).toBeTruthy()
	})
})

describe('<AddonCard> — a11y', () => {
	test('[AC16] aria-label on +/- buttons references addon name', () => {
		render(
			<AddonCard
				addon={breakfast}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		const inc = screen.getByTestId('addon-BREAKFAST-inc')
		expect(inc.getAttribute('aria-label')).toMatch(/Завтрак-буфет/)
		const dec = screen.getByTestId('addon-BREAKFAST-dec')
		expect(dec.getAttribute('aria-label')).toMatch(/Завтрак-буфет/)
	})

	test('[AC17] native input has aria-label', () => {
		render(
			<AddonCard
				addon={breakfast}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		const input = screen.getByTestId('addon-BREAKFAST-qty')
		expect(input.getAttribute('aria-label')).toMatch(/Завтрак-буфет/)
	})
})

describe('<AddonCard> — adversarial', () => {
	test('[AC18] no «Recommended» / «AI» / «Часто выбирают» badges (38-ФЗ ст. 5 risk)', () => {
		render(
			<AddonCard
				addon={breakfast}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		expect(screen.queryByText(/Рекоменд/i)).toBeNull()
		expect(screen.queryByText(/AI/i)).toBeNull()
		expect(screen.queryByText(/Часто выбирают/i)).toBeNull()
	})

	test('[AC19] qty=0 displays «0» в input (НЕ empty / hidden)', () => {
		render(
			<AddonCard
				addon={breakfast}
				quantity={0}
				context={ctx}
				checkInIso={checkIn}
				onChangeQuantity={vi.fn()}
			/>,
		)
		const input = screen.getByTestId('addon-BREAKFAST-qty') as HTMLInputElement
		expect(input.value).toBe('0')
	})
})
