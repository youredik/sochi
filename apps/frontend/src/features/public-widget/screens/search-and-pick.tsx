/**
 * `<SearchAndPick>` — Screen 1 of public booking widget.
 *
 * Composition over coupling: pure component, props-only. Routes/wrappers
 * connect URL search params (canonical 2026 — TanStack Router) → props →
 * TanStack Query → render.
 *
 * Layout (per plan §M9.widget.2 + Apaleo IBE v2 / Hostaway 2026 canon):
 *   - Mobile (≤md): vertical stack — search bar → rate cards → bottom-sticky summary
 *   - Desktop (md+): grid — left col (search bar + rate cards), right col (sticky summary)
 *
 * Picks default rate plan (BAR Flex / isDefault=true) when first rendered →
 * sticky summary populates с pricing, Continue CTA enabled.
 */
import { useEffect, useState } from 'react'
import { DateRangePicker } from '../components/date-range-picker.tsx'
import { GuestSelector } from '../components/guest-selector.tsx'
import { RateCard } from '../components/rate-card.tsx'
import { StickySummary } from '../components/sticky-summary.tsx'
import { useAvailability } from '../hooks/use-availability.ts'
import type { PublicRateOption, PublicRoomType } from '../lib/widget-api.ts'
import { WidgetApiInputError } from '../lib/widget-api.ts'

export interface SearchAndPickProps {
	readonly tenantSlug: string
	readonly propertyId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly adults: number
	readonly childrenCount: number
	readonly onSearchChange: (next: {
		checkIn: string
		checkOut: string
		adults: number
		childrenCount: number
	}) => void
	readonly onContinue: (selection: {
		roomTypeId: string
		ratePlanId: string
		totalKopecks: number
	}) => void
	readonly onNotFound?: () => void
}

export function SearchAndPick({
	tenantSlug,
	propertyId,
	checkIn,
	checkOut,
	adults,
	childrenCount,
	onSearchChange,
	onContinue,
	onNotFound,
}: SearchAndPickProps) {
	const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<string | null>(null)
	const [selectedRatePlanId, setSelectedRatePlanId] = useState<string | null>(null)

	const query = useAvailability({
		tenantSlug,
		propertyId,
		checkIn,
		checkOut,
		adults,
		children: childrenCount,
	})

	// Auto-select first sellable offering + default ratePlan когда results arrive.
	// useEffect (NOT useMemo) — setState side-effect canon (React docs: useMemo
	// для derivation only, useEffect для effects).
	useEffect(() => {
		if (!query.data) return
		if (selectedRoomTypeId !== null) return
		const first = query.data.offerings.find((o) => o.sellable && o.rateOptions.length > 0)
		if (!first) return
		const defaultRate = first.rateOptions.find((r) => r.isDefault) ?? first.rateOptions[0] ?? null
		setSelectedRoomTypeId(first.roomType.id)
		if (defaultRate) setSelectedRatePlanId(defaultRate.ratePlanId)
	}, [query.data, selectedRoomTypeId])

	// Notify route wrapper когда API returns 404 — useEffect (NOT during render).
	// Route's TanStack Router `notFound()` handler renders dedicated not-found UI;
	// rendering fallback here protects если onNotFound пропущен.
	useEffect(() => {
		if (query.data === null && onNotFound) onNotFound()
	}, [query.data, onNotFound])

	if (query.data === null) {
		return (
			<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
				<h1 className="text-2xl font-semibold">Не найдено</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					Это размещение недоступно для онлайн-бронирования.
				</p>
			</main>
		)
	}

	if (query.error instanceof WidgetApiInputError) {
		return (
			<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
				<div
					role="alert"
					className="rounded-lg border border-amber-500/50 bg-amber-50 p-4 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
				>
					<p className="font-medium">Проверьте параметры поиска</p>
					<p className="mt-1 text-sm">{query.error.reason}</p>
				</div>
			</main>
		)
	}

	// Catch-all server/network error (non-404, non-422) → user-actionable fallback
	// instead of infinite skeleton (real UX bug caught в senior-pass v2).
	if (query.error) {
		return (
			<main className="mx-auto max-w-3xl p-4 sm:p-6 md:p-8" lang="ru">
				<div
					role="alert"
					data-testid="widget-error-fallback"
					className="rounded-lg border border-destructive/50 bg-destructive/5 p-4"
				>
					<p className="font-medium">Не удалось загрузить варианты размещения</p>
					<p className="mt-1 text-sm text-muted-foreground">
						Проверьте интернет-соединение и обновите страницу. Если проблема повторится, свяжитесь с
						отелем напрямую.
					</p>
					<button
						type="button"
						onClick={() => query.refetch()}
						className="mt-3 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
					>
						Попробовать ещё раз
					</button>
				</div>
			</main>
		)
	}

	if (query.isLoading || !query.data) {
		return (
			<main
				className="mx-auto grid min-h-svh max-w-6xl gap-4 p-4 sm:p-6 md:grid-cols-[1fr_320px] md:p-8"
				lang="ru"
			>
				<div className="space-y-4">
					<div
						role="status"
						aria-live="polite"
						className="h-14 w-full animate-pulse rounded-lg bg-muted"
					/>
					<div className="h-72 w-full animate-pulse rounded-xl bg-muted" />
					<div className="h-72 w-full animate-pulse rounded-xl bg-muted" />
				</div>
				<div className="hidden h-72 w-full animate-pulse rounded-xl bg-muted md:block" />
			</main>
		)
	}

	const { offerings, photos, property, tenant, nights } = query.data
	const selectedOffering = offerings.find((o) => o.roomType.id === selectedRoomTypeId) ?? null
	const selectedRoomType: PublicRoomType | null = selectedOffering?.roomType ?? null
	const selectedRate: PublicRateOption | null =
		selectedOffering?.rateOptions.find((r) => r.ratePlanId === selectedRatePlanId) ?? null

	return (
		<div
			className="min-h-svh bg-gradient-to-b from-primary/5 via-background to-background"
			lang="ru"
		>
			{/* pb-32 на mobile — safe-padding под bottom-fixed Vaul peek bar (~80px + safe-area). md+: 0. */}
			<main className="mx-auto max-w-6xl px-4 pt-6 pb-32 sm:px-6 md:py-10 md:pb-10">
				<header className="mb-6 md:mb-8">
					<p className="text-xs font-medium uppercase tracking-wider text-primary">
						{tenant.name} · Прямое бронирование
					</p>
					<h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">
						{property.name}
					</h1>
					<p className="mt-1 text-sm text-muted-foreground">{property.address}</p>
				</header>

				<section
					aria-label="Параметры поиска"
					data-testid="search-bar"
					className="mb-6 rounded-xl border bg-card p-3 shadow-sm md:p-4"
				>
					<div className="grid gap-3 sm:grid-cols-2">
						<DateRangePicker
							checkIn={checkIn}
							checkOut={checkOut}
							onChange={(next) => onSearchChange({ ...next, adults, childrenCount })}
						/>
						<GuestSelector
							adults={adults}
							childrenCount={childrenCount}
							onChange={(next) => onSearchChange({ checkIn, checkOut, ...next })}
						/>
					</div>
				</section>

				<div className="grid gap-6 md:grid-cols-[1fr_320px]">
					<section aria-label="Доступные номера" className="space-y-4" data-testid="rate-list">
						{offerings.length === 0 ? (
							<p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
								Нет номеров, соответствующих количеству гостей. Попробуйте изменить параметры.
							</p>
						) : (
							offerings.map((o) => (
								<RateCard
									key={o.roomType.id}
									offering={o}
									photos={photos}
									selectedRatePlanId={
										o.roomType.id === selectedRoomTypeId ? selectedRatePlanId : null
									}
									onSelectRate={(ratePlanId) => {
										setSelectedRoomTypeId(o.roomType.id)
										setSelectedRatePlanId(ratePlanId)
									}}
									nights={nights}
								/>
							))
						)}
					</section>

					<StickySummary
						checkIn={checkIn}
						checkOut={checkOut}
						nights={query.data.nights}
						adults={adults}
						childrenCount={childrenCount}
						selectedRoomType={selectedRoomType}
						selectedRate={selectedRate}
						tourismTaxRateBps={property.tourismTaxRateBps}
						continueLabel="Перейти к выбору дополнений"
						onContinue={() => {
							if (!selectedRoomType || !selectedRate) return
							onContinue({
								roomTypeId: selectedRoomType.id,
								ratePlanId: selectedRate.ratePlanId,
								totalKopecks: selectedRate.totalKopecks,
							})
						}}
					/>
				</div>
			</main>
		</div>
	)
}
