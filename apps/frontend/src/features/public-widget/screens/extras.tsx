/**
 * `<Extras>` — Screen 2 of public booking widget (M9.widget.3).
 *
 * Per `plans/m9_widget_canonical.md` §3 + Round 2 RU compliance verified:
 *   - Opt-in mandate (ЗоЗПП ст. 16 ч. 3.1, 69-ФЗ от 07.04.2025) — все
 *     checkboxes по default unchecked, qty=0.
 *   - Skip CTA «Продолжить без дополнений» — secondary/ghost, ALWAYS visible
 *     (Baymard 2026 + UX anti-pattern «avoid cross-sells in pay step»).
 *   - Primary CTA «Перейти к оплате» — always enabled (skip = empty cart).
 *   - VAT 22% display per addon (ст. 10 ЗоЗПП — обязательная цена с НДС).
 *   - Cancellation disclosure per addon (ПП РФ №1912 от 27.11.2025).
 *   - Cart serialized в TanStack Router search params (canonical M9.widget.2 pattern).
 *
 * Composition over coupling: pure component, props-only. Route wrapper threads
 * URL search params + booking-context (room/rate selection from Screen 1).
 */

import { Sparkles } from 'lucide-react'
import { useMemo } from 'react'
import { AddonCard } from '../components/addon-card.tsx'
import { type AddonLineItem, StickySummary } from '../components/sticky-summary.tsx'
import { useAddons } from '../hooks/use-addons.ts'
import {
	type AddonCartEntry,
	addonGrossKopecks,
	cartGrossTotalKopecks,
	getCartQuantity,
	setCartQuantity,
} from '../lib/addon-pricing.ts'
import type { PublicRateOption, PublicRoomType } from '../lib/widget-api.ts'

export interface ExtrasProps {
	readonly tenantSlug: string
	readonly propertyId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly nights: number
	readonly adults: number
	readonly childrenCount: number
	readonly selectedRoomType: PublicRoomType
	readonly selectedRate: PublicRateOption
	readonly tourismTaxRateBps: number | null
	readonly cart: readonly AddonCartEntry[]
	readonly onCartChange: (cart: readonly AddonCartEntry[]) => void
	readonly onContinue: () => void
	readonly onSkip: () => void
	readonly onNotFound?: () => void
}

export function Extras({
	tenantSlug,
	propertyId,
	checkIn,
	checkOut,
	nights,
	adults,
	childrenCount,
	selectedRoomType,
	selectedRate,
	tourismTaxRateBps,
	cart,
	onCartChange,
	onContinue,
	onSkip,
	onNotFound,
}: ExtrasProps) {
	const persons = adults + childrenCount
	const ctx = useMemo(() => ({ nights, persons }), [nights, persons])

	const query = useAddons(tenantSlug, propertyId)

	// `addonsById` memoized — computed BEFORE early returns to preserve hook
	// order (React rules-of-hooks: «Rendered more hooks than during the previous
	// render» bug otherwise — caught by E2E senior-pass).
	const addonsById = useMemo(() => {
		const list = query.data?.addons ?? []
		return new Map(list.map((a) => [a.addonId, a]))
	}, [query.data?.addons])

	// Network / server error fallback (non-404). Check FIRST — иначе query.error
	// + query.data===undefined уйдёт в loading skeleton навсегда.
	if (query.error) {
		return (
			<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
				<div
					role="alert"
					data-testid="extras-error-fallback"
					className="rounded-lg border border-destructive/50 bg-destructive/5 p-4"
				>
					<p className="font-medium">Не удалось загрузить дополнения</p>
					<p className="mt-1 text-sm text-muted-foreground">
						Попробуйте обновить страницу или продолжить без дополнений.
					</p>
					<div className="mt-3 flex flex-wrap gap-2">
						<button
							type="button"
							onClick={() => query.refetch()}
							className="rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
						>
							Попробовать ещё раз
						</button>
						<button
							type="button"
							onClick={onSkip}
							data-testid="extras-error-skip"
							className="rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
						>
							Продолжить без дополнений
						</button>
					</div>
				</div>
			</main>
		)
	}

	// Loading skeleton (after error check).
	if (query.isLoading || query.data === undefined) {
		return (
			<main
				className="mx-auto grid min-h-svh max-w-6xl gap-4 p-4 sm:p-6 md:grid-cols-[1fr_320px] md:p-8"
				lang="ru"
			>
				<div className="space-y-4" data-testid="extras-loading">
					<div
						role="status"
						aria-live="polite"
						className="h-8 w-2/3 animate-pulse rounded-md bg-muted"
					/>
					<div className="h-32 w-full animate-pulse rounded-xl bg-muted" />
					<div className="h-32 w-full animate-pulse rounded-xl bg-muted" />
					<div className="h-32 w-full animate-pulse rounded-xl bg-muted" />
				</div>
				<div className="hidden h-72 w-full animate-pulse rounded-xl bg-muted md:block" />
			</main>
		)
	}

	// 404 — tenant or property missing. Bubble up to route-level notFound.
	if (query.data === null) {
		if (onNotFound) onNotFound()
		return (
			<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
				<h1 className="text-2xl font-semibold">Не найдено</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					Это размещение недоступно для онлайн-бронирования.
				</p>
			</main>
		)
	}

	const { tenant, property, addons } = query.data
	const hasAddons = addons.length > 0

	// Build line items для sticky-summary только из selected (qty > 0) addons.
	// `addonsById` memoized выше (stable — обязательно before early returns
	// per React rules-of-hooks; senior-pass catch).
	const lineItems: AddonLineItem[] = []
	for (const entry of cart) {
		if (entry.quantity <= 0) continue
		const a = addonsById.get(entry.addonId)
		if (!a) continue
		const grossKopecks = addonGrossKopecks(
			a.pricingUnit,
			a.priceKopecks,
			entry.quantity,
			a.vatBps,
			ctx,
		)
		lineItems.push({
			addonId: a.addonId,
			nameRu: a.nameRu,
			quantity: entry.quantity,
			grossKopecks,
		})
	}

	const cartTotalGross = cartGrossTotalKopecks(cart, addons, ctx)

	const handleQtyChange = (addonId: string, qty: number) => {
		const next = setCartQuantity(cart, addonId, qty)
		onCartChange(next)
	}

	return (
		<div
			className="min-h-svh bg-gradient-to-b from-primary/5 via-background to-background"
			lang="ru"
		>
			{/* pb-32 на mobile — safe-padding под bottom-fixed sticky bar */}
			<main className="mx-auto max-w-6xl px-4 pt-6 pb-32 sm:px-6 md:py-10 md:pb-10">
				<header className="mb-6 md:mb-8">
					<p className="text-xs font-medium uppercase tracking-wider text-primary">
						{tenant.name} · Шаг 2 из 4
					</p>
					<h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">
						Дополнительные услуги
					</h1>
					<p className="mt-2 text-sm text-muted-foreground md:text-base">
						{property.name} · {selectedRoomType.name} · {selectedRate.name}
					</p>
				</header>

				<div className="grid gap-6 md:grid-cols-[1fr_320px]">
					<section
						aria-label="Список дополнительных услуг"
						data-testid="extras-list"
						className="flex flex-col gap-4"
					>
						{hasAddons ? (
							addons.map((addon) => (
								<AddonCard
									key={addon.addonId}
									addon={addon}
									quantity={getCartQuantity(cart, addon.addonId)}
									context={ctx}
									checkInIso={checkIn}
									onChangeQuantity={(qty) => handleQtyChange(addon.addonId, qty)}
								/>
							))
						) : (
							<EmptyState />
						)}

						<div
							className="mt-2 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"
							data-testid="extras-cta-row"
						>
							{/* Skip CTA — secondary/ghost, ALWAYS visible (Baymard 2026 canon).
							 *  ПРИМЕЧАНИЕ: skip == proceed-with-empty-cart, NOT abandon. */}
							<button
								type="button"
								onClick={onSkip}
								data-testid="extras-skip"
								className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
							>
								Продолжить без дополнений
							</button>
							{/* Mobile-only inline primary (desktop has it через sticky summary). */}
							<button
								type="button"
								onClick={onContinue}
								data-testid="extras-continue-inline"
								className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden forced-colors:bg-[ButtonText] forced-colors:text-[ButtonFace]"
							>
								Перейти к оплате
							</button>
						</div>

						<TaxNote tourismTaxRateBps={tourismTaxRateBps} />
					</section>

					<StickySummary
						checkIn={checkIn}
						checkOut={checkOut}
						nights={nights}
						adults={adults}
						childrenCount={childrenCount}
						selectedRoomType={selectedRoomType}
						selectedRate={selectedRate}
						tourismTaxRateBps={tourismTaxRateBps}
						addonLineItems={lineItems}
						continueLabel="Перейти к оплате"
						onContinue={onContinue}
					/>
				</div>

				{/* Live region: announces cart total updates для screen-reader. */}
				<div role="status" aria-live="polite" className="sr-only">
					{cartTotalGross > 0
						? `Дополнения добавлены: ${(cartTotalGross / 100).toFixed(0)} рублей`
						: 'Корзина дополнений пуста'}
				</div>
			</main>
		</div>
	)
}

function EmptyState() {
	return (
		<div
			data-testid="extras-empty"
			className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/30 p-8 text-center"
		>
			<Sparkles className="size-10 text-muted-foreground" aria-hidden />
			<p className="text-base font-medium">Дополнений пока нет</p>
			<p className="max-w-sm text-sm text-muted-foreground">
				Это размещение не предлагает дополнительных услуг при бронировании. Можно перейти к оплате
				напрямую.
			</p>
		</div>
	)
}

function TaxNote({ tourismTaxRateBps }: { tourismTaxRateBps: number | null }) {
	if (tourismTaxRateBps === null || tourismTaxRateBps === 0) return null
	const pct = (tourismTaxRateBps / 100).toFixed(1)
	return (
		<p data-testid="extras-tax-note" className="text-xs text-muted-foreground">
			Туристический налог {pct}% начисляется на стоимость проживания (не на дополнения) согласно ст.
			418.4 НК РФ.
		</p>
	)
}
