/**
 * `<AddonCard>` — single addon (extra) с quantity stepper.
 *
 * Per `plans/m9_widget_canonical.md` §3 Round 2 canon:
 *   - Opt-in mandate (ЗоЗПП ст. 16 ч. 3.1, 69-ФЗ от 07.04.2025): default qty=0,
 *     UI render unchecked / no «selected» visual state without explicit user action.
 *   - VAT 22% display required (ст. 10 ЗоЗПП): «в т.ч. НДС 22%» line.
 *   - Cancellation disclosure (ПП РФ №1912 от 27.11.2025): «Бесплатная отмена до
 *     [checkIn]» — addon refund-window aligned with room (default safe).
 *   - Native `<input type="number">` styled + custom +/- buttons (Round 2 verified
 *     APG canon — text field is tab stop, +/- arrow keys via browser native).
 *   - Touch target 44×44 CSS px (Apple HIG 2026 — Round 2 verified).
 *   - NO «AI-suggested» / «Recommended» badges (38-ФЗ ст. 5 risk без factual basis).
 */
import { Bath, Briefcase, Car, Clock, Coffee, Minus, Plus, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import {
	type AddonPricingContext,
	addonGrossKopecks,
	addonQtyBounds,
	addonVatKopecks,
} from '../lib/addon-pricing.ts'
import type { AddonCategory, AddonPricingUnit, PublicWidgetAddon } from '../lib/widget-api.ts'
import { formatRub } from '../lib/widget-format.ts'

export interface AddonCardProps {
	readonly addon: PublicWidgetAddon
	readonly quantity: number
	readonly context: AddonPricingContext
	readonly checkInIso: string
	readonly onChangeQuantity: (qty: number) => void
}

export function AddonCard({
	addon,
	quantity,
	context,
	checkInIso,
	onChangeQuantity,
}: AddonCardProps) {
	const bounds = addonQtyBounds(addon.pricingUnit, context)

	// Unit-price (per qty=1) gross/vat для UI display ("1 500 ₽ / гость / ночь, в т.ч. НДС").
	const unitGross = addonGrossKopecks(
		addon.pricingUnit,
		addon.priceKopecks,
		1,
		addon.vatBps,
		context,
	)
	const unitVat = addonVatKopecks(addon.pricingUnit, addon.priceKopecks, 1, addon.vatBps, context)

	// Total gross при выбранной qty (отдельная строка — what guest will pay).
	const totalGross =
		quantity > 0
			? addonGrossKopecks(addon.pricingUnit, addon.priceKopecks, quantity, addon.vatBps, context)
			: 0

	const isSelected = quantity > 0
	const cardId = `addon-${addon.addonId}`
	const stepperLabelId = `${cardId}-qty-label`

	const decrement = () => {
		if (quantity > bounds.min) onChangeQuantity(quantity - 1)
	}
	const increment = () => {
		if (quantity < bounds.max) onChangeQuantity(quantity + 1)
	}

	return (
		<article
			data-testid={`addon-card-${addon.code}`}
			data-selected={isSelected}
			aria-labelledby={`${cardId}-name`}
			className={`overflow-hidden rounded-xl border bg-card p-4 shadow-sm transition md:p-5 ${
				isSelected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
			}`}
		>
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start">
				<CategoryIcon category={addon.category} />
				<div className="flex-1 min-w-0">
					<h3 id={`${cardId}-name`} className="text-base font-semibold leading-tight">
						{addon.nameRu}
					</h3>
					{addon.descriptionRu ? (
						<p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
							{addon.descriptionRu}
						</p>
					) : null}
					<div className="mt-3 flex flex-col gap-1 text-sm">
						<span className="flex flex-wrap items-baseline gap-x-1.5">
							<span className="font-semibold tabular-nums">{formatRub(unitGross)}</span>
							<span className="text-xs text-muted-foreground">
								{pricingUnitLabel(addon.pricingUnit)}
							</span>
						</span>
						{unitVat > 0 ? (
							<span className="text-xs text-muted-foreground">
								в т.ч. НДС {(addon.vatBps / 100).toFixed(0)}%
							</span>
						) : null}
						<CancellationNote checkInIso={checkInIso} />
					</div>
				</div>
				<div className="flex flex-row items-center gap-2 sm:flex-col sm:items-end sm:gap-1.5">
					<span id={stepperLabelId} className="text-xs text-muted-foreground">
						{bounds.label}
					</span>
					<fieldset
						className="inline-flex items-center gap-1 rounded-lg border bg-background p-1"
						aria-labelledby={stepperLabelId}
					>
						<button
							type="button"
							onClick={decrement}
							disabled={quantity <= bounds.min}
							aria-label={`Уменьшить количество ${addon.nameRu}`}
							data-testid={`addon-${addon.code}-dec`}
							className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
						>
							<Minus className="size-4" aria-hidden />
						</button>
						<input
							type="number"
							inputMode="numeric"
							min={bounds.min}
							max={bounds.max}
							step={bounds.step}
							value={quantity}
							onChange={(e) => {
								const next = Number.parseInt(e.target.value, 10)
								if (!Number.isFinite(next)) return
								if (next < bounds.min || next > bounds.max) return
								onChangeQuantity(next)
							}}
							data-testid={`addon-${addon.code}-qty`}
							aria-label={`${bounds.label} — ${addon.nameRu}`}
							className="w-10 bg-transparent text-center text-base font-semibold tabular-nums [appearance:textfield] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
						/>
						<button
							type="button"
							onClick={increment}
							disabled={quantity >= bounds.max}
							aria-label={`Увеличить количество ${addon.nameRu}`}
							data-testid={`addon-${addon.code}-inc`}
							className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
						>
							<Plus className="size-4" aria-hidden />
						</button>
					</fieldset>
					{isSelected ? (
						<span
							data-testid={`addon-${addon.code}-total`}
							className="text-sm font-semibold tabular-nums text-primary"
						>
							{formatRub(totalGross)}
						</span>
					) : null}
				</div>
			</div>
		</article>
	)
}

function CategoryIcon({ category }: { category: AddonCategory }): ReactNode {
	const Icon = iconForCategory(category)
	return (
		<div
			aria-hidden
			className="flex size-12 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
		>
			<Icon className="size-6" />
		</div>
	)
}

function iconForCategory(category: AddonCategory) {
	switch (category) {
		case 'FOOD_AND_BEVERAGES':
			return Coffee
		case 'TRANSFER':
			return Car
		case 'PARKING':
			return Car
		case 'WELLNESS':
			return Bath
		case 'LATE_CHECK_OUT':
		case 'EARLY_CHECK_IN':
			return Clock
		case 'ACTIVITIES':
			return Sparkles
		default:
			return Briefcase
	}
}

function pricingUnitLabel(unit: AddonPricingUnit): string {
	switch (unit) {
		case 'PER_STAY':
			return '/ услуга'
		case 'PER_PERSON':
			return '/ гость'
		case 'PER_NIGHT':
			return '/ ночь'
		case 'PER_NIGHT_PER_PERSON':
			return '/ гость / ночь'
		case 'PER_HOUR':
			return '/ час'
		case 'PERCENT_OF_ROOM_RATE':
			return ''
	}
}

function CancellationNote({ checkInIso }: { checkInIso: string }) {
	const formatted = formatRuDate(checkInIso)
	return (
		<span className="text-xs text-emerald-700 dark:text-emerald-400">
			Бесплатная отмена до {formatted}
		</span>
	)
}

function formatRuDate(iso: string): string {
	// `iso` = YYYY-MM-DD, render '7 мая 2026' format.
	const [yearStr, monthStr, dayStr] = iso.split('-')
	const year = Number.parseInt(yearStr ?? '', 10)
	const month = Number.parseInt(monthStr ?? '', 10)
	const day = Number.parseInt(dayStr ?? '', 10)
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
		return iso
	}
	const months = [
		'',
		'января',
		'февраля',
		'марта',
		'апреля',
		'мая',
		'июня',
		'июля',
		'августа',
		'сентября',
		'октября',
		'ноября',
		'декабря',
	]
	const monthName = months[month] ?? ''
	return `${day} ${monthName} ${year}`
}
