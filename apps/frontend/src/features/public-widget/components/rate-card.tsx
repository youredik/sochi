/**
 * `<RateCard>` — single roomType с inline rate-plan options.
 *
 * Per plan §M9.widget.2 + Mews/Apaleo IBE v2 canon: rate options inline
 * (NOT tab-switch). BAR Flex highlighted с «Рекомендуем» (choice arch.).
 * BAR NR shows Δ savings vs Flex.
 *
 * Photos: М9.widget.8 polish (no photos seeded в M9.widget.2 demo). Component
 * graceful w/ 0 photos — placeholder gradient в hero slot.
 */
import { Check, Coffee, ShieldCheck, Users } from 'lucide-react'
import { ruPlural } from '../lib/ru-plural.ts'
import type {
	PublicAvailabilityOffering,
	PublicPropertyPhoto,
	PublicRateOption,
	SellableReason,
} from '../lib/widget-api.ts'
import { formatMeals, formatMoscowDateTime, formatRub } from '../lib/widget-format.ts'

export interface RateCardProps {
	readonly offering: PublicAvailabilityOffering
	readonly photos: readonly PublicPropertyPhoto[]
	readonly selectedRatePlanId: string | null
	readonly onSelectRate: (ratePlanId: string) => void
	readonly nights: number
}

export function RateCard({
	offering,
	photos,
	selectedRatePlanId,
	onSelectRate,
	nights,
}: RateCardProps) {
	const { roomType } = offering
	const heroPhoto = photos.find((p) => p.roomTypeId === roomType.id && p.isHero) ?? null
	const cheapestRate = offering.rateOptions.reduce<PublicRateOption | null>((min, r) => {
		if (!min) return r
		return r.totalKopecks < min.totalKopecks ? r : min
	}, null)

	return (
		<article
			data-testid={`rate-card-${roomType.id}`}
			aria-labelledby={`rt-name-${roomType.id}`}
			className="overflow-hidden rounded-xl border bg-card shadow-sm transition hover:shadow-md"
		>
			<div className="grid md:grid-cols-[280px_1fr]">
				<HeroPhoto
					photo={heroPhoto}
					alt={roomType.name}
					sellable={offering.sellable}
					inventoryRemaining={offering.inventoryRemaining}
				/>

				<div className="flex flex-col p-4 md:p-5">
					<div className="flex items-baseline justify-between gap-3">
						<h3 id={`rt-name-${roomType.id}`} className="text-lg font-semibold tracking-tight">
							{roomType.name}
						</h3>
						<span className="flex flex-shrink-0 items-center gap-1 text-xs text-muted-foreground">
							<Users className="size-3.5" aria-hidden />
							<span className="tabular-nums">до {roomType.maxOccupancy}</span>
						</span>
					</div>
					{roomType.description ? (
						<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
							{roomType.description}
						</p>
					) : null}

					{!offering.sellable ? (
						<UnsellableBadge reason={offering.unsellableReason} />
					) : (
						<div className="mt-4 space-y-3">
							{offering.rateOptions.map((rate) => (
								<RateOption
									key={rate.ratePlanId}
									rate={rate}
									isSelected={rate.ratePlanId === selectedRatePlanId}
									cheapest={cheapestRate?.ratePlanId === rate.ratePlanId}
									onSelect={() => onSelectRate(rate.ratePlanId)}
									nights={nights}
								/>
							))}
						</div>
					)}
				</div>
			</div>
		</article>
	)
}

function HeroPhoto({
	photo,
	alt,
	sellable,
	inventoryRemaining,
}: {
	photo: PublicPropertyPhoto | null
	alt: string
	sellable: boolean
	inventoryRemaining: number
}) {
	// Mobile aspect 16:9 (compact, ~200px на 360w) — Hostaway 2026 canon.
	// Desktop full-height для grid alignment.
	return (
		<div className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-primary/15 via-primary/5 to-background md:aspect-auto md:h-full">
			{photo ? (
				<img
					src={`/cdn/${photo.originalKey}`}
					alt={photo.altRu || alt}
					loading="lazy"
					className="h-full w-full object-cover"
					width={photo.widthPx}
					height={photo.heightPx}
				/>
			) : (
				<div
					aria-hidden
					className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/20 via-primary/8 to-background"
				>
					<svg
						className="size-12 text-primary/30"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<title>Иконка номера</title>
						<path
							d="M3 21V9a3 3 0 013-3h12a3 3 0 013 3v12M3 21h18M9 14h.01M9 18h.01M15 14h.01M15 18h.01"
							strokeLinecap="round"
						/>
					</svg>
				</div>
			)}
			{sellable && inventoryRemaining > 0 && inventoryRemaining <= 3 ? (
				<span
					data-testid="inventory-low"
					className="absolute left-3 top-3 rounded-full bg-amber-500/95 px-2.5 py-1 text-xs font-medium text-amber-950 shadow-sm"
				>
					Осталось {inventoryRemaining}
				</span>
			) : null}
		</div>
	)
}

function UnsellableBadge({ reason }: { reason: SellableReason | null }) {
	const text = unsellableText(reason)
	return (
		<p
			data-testid="unsellable-badge"
			className="mt-4 inline-flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
		>
			{text}
		</p>
	)
}

function unsellableText(reason: SellableReason | null): string {
	switch (reason) {
		case 'sold_out':
			return 'Нет доступных номеров на эти даты'
		case 'stop_sell':
			return 'Бронирование закрыто отелем'
		case 'closed_to_arrival':
			return 'Заезд в этот день недоступен'
		case 'closed_to_departure':
			return 'Выезд в этот день недоступен'
		case 'missing_availability':
			return 'Нет данных о доступности — попробуйте другие даты'
		case 'no_nights':
			return 'Выберите даты'
		default:
			return 'Недоступно'
	}
}

function RateOption({
	rate,
	isSelected,
	cheapest,
	onSelect,
	nights,
}: {
	rate: PublicRateOption
	isSelected: boolean
	cheapest: boolean
	onSelect: () => void
	nights: number
}) {
	const meals = formatMeals(rate.mealsIncluded)
	return (
		<button
			type="button"
			onClick={onSelect}
			data-testid={`rate-option-${rate.code}`}
			data-selected={isSelected}
			aria-pressed={isSelected}
			className={`flex w-full flex-col gap-2 rounded-lg border p-4 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
				isSelected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
			}`}
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
				<span className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-medium">{rate.name}</span>
					{rate.isDefault ? (
						<span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
							Рекомендуем
						</span>
					) : null}
				</span>
				<span className="flex flex-col items-start sm:items-end">
					<span className="text-base font-semibold tabular-nums">
						{formatRub(rate.totalKopecks)}
					</span>
					<span className="text-xs text-muted-foreground tabular-nums">
						≈ {formatRub(rate.avgPerNightKopecks)} / ночь · {nights}{' '}
						{ruPlural(nights, 'ночь', 'ночи', 'ночей')}
					</span>
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
				{rate.isRefundable && rate.freeCancelDeadlineUtc ? (
					<span className="inline-flex items-center gap-1">
						<ShieldCheck className="size-3.5" aria-hidden />
						Бесплатная отмена до {formatMoscowDateTime(rate.freeCancelDeadlineUtc)}
					</span>
				) : (
					<span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
						<ShieldCheck className="size-3.5" aria-hidden />
						Невозвратный
					</span>
				)}
				{meals ? (
					<span className="inline-flex items-center gap-1">
						<Coffee className="size-3.5" aria-hidden />
						{meals}
					</span>
				) : null}
				{cheapest && rate.code !== 'BAR_FLEX' ? (
					<span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-800 dark:text-emerald-300">
						Дешевле
					</span>
				) : null}
				{isSelected ? (
					<span className="ml-auto inline-flex items-center gap-1 text-primary">
						<Check className="size-3.5" aria-hidden />
						Выбрано
					</span>
				) : null}
			</div>
		</button>
	)
}
