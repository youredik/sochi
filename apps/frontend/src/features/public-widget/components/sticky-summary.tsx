/**
 * `<StickySummary>` — desktop right-rail / mobile bottom-fixed summary с
 * pricing breakdown + free-cancel deadline + Continue CTA.
 *
 * Plan §M9.widget.2: «desktop right-sticky / mobile bottom-fixed via Vaul».
 *   - Desktop ≥md: right-column sticky aside
 *   - Mobile: collapsed Vaul drawer (peek bar with total + Continue CTA),
 *     tap to expand for full breakdown. Pattern: Hostaway 2026 + Mews
 *     Distributor canon — keeps decision-making 1-tap distance даже на small
 *     viewport, без crowding rate cards.
 *
 * Сочи-specific: тур.налог 2% rendered как separate line для transparency
 * перед оплатой (РФ canon — backend keeps его embedded в чеке per ЮKassa
 * correction memory).
 */
import { ArrowRight, ChevronUp, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
	Drawer,
	DrawerContent,
	DrawerHeader,
	DrawerTitle,
	DrawerTrigger,
} from '@/components/ui/drawer'
import { useMediaQuery } from '@/lib/use-media-query'
import { ruPlural } from '../lib/ru-plural.ts'
import type { PublicRateOption, PublicRoomType } from '../lib/widget-api.ts'
import { formatDateRange, formatMoscowDateTime, formatRub } from '../lib/widget-format.ts'

export interface StickySummaryProps {
	readonly checkIn: string
	readonly checkOut: string
	readonly nights: number
	readonly adults: number
	readonly childrenCount: number
	readonly selectedRoomType: PublicRoomType | null
	readonly selectedRate: PublicRateOption | null
	readonly tourismTaxRateBps: number | null
	readonly onContinue: () => void
}

export function StickySummary({
	checkIn,
	checkOut,
	nights,
	adults,
	childrenCount,
	selectedRoomType,
	selectedRate,
	tourismTaxRateBps,
	onContinue,
}: StickySummaryProps) {
	const isDesktop = useMediaQuery('(min-width: 768px)')
	const [drawerOpen, setDrawerOpen] = useState(false)

	const totalGuests = adults + childrenCount
	const guestsLabel = `${adults}${childrenCount > 0 ? ` + ${childrenCount}` : ''} ${ruPlural(totalGuests, 'гость', 'гостя', 'гостей')}`
	const taxPct = tourismTaxRateBps !== null ? (tourismTaxRateBps / 100).toFixed(1) : null
	const isReady = selectedRoomType !== null && selectedRate !== null

	const summaryBody = (
		<SummaryBody
			checkIn={checkIn}
			checkOut={checkOut}
			nights={nights}
			guestsLabel={guestsLabel}
			selectedRoomType={selectedRoomType}
			selectedRate={selectedRate}
			taxPct={taxPct}
			isReady={isReady}
			onContinue={onContinue}
		/>
	)

	if (isDesktop) {
		return (
			<aside
				data-testid="sticky-summary"
				aria-label="Сводка бронирования"
				className="sticky top-6 rounded-xl border bg-card p-6 shadow-sm"
			>
				{summaryBody}
			</aside>
		)
	}

	// Mobile: bottom-fixed peek bar + Vaul drawer для full breakdown.
	// pb-[env(safe-area-inset-bottom)] — iOS notch / home-indicator canon (2024+).
	return (
		<Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
			<div
				data-testid="sticky-summary"
				className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-[0_-4px_20px_rgba(0,0,0,0.08)] supports-[backdrop-filter]:backdrop-blur"
			>
				<div className="mx-auto flex max-w-6xl items-center gap-3">
					<DrawerTrigger asChild>
						<button
							type="button"
							className="flex flex-1 items-center justify-between text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
							aria-label="Развернуть детали стоимости"
							data-testid="summary-peek-trigger"
						>
							<span className="flex flex-col">
								<span className="text-[11px] uppercase tracking-wider text-muted-foreground">
									Итого
								</span>
								<span
									data-testid="summary-total"
									className="text-base font-semibold text-primary tabular-nums"
								>
									{selectedRate ? formatRub(selectedRate.totalKopecks) : '—'}
								</span>
							</span>
							<ChevronUp className="size-4 text-muted-foreground" aria-hidden />
						</button>
					</DrawerTrigger>
					<Button
						type="button"
						size="default"
						disabled={!isReady}
						onClick={onContinue}
						data-testid="summary-continue"
						aria-label={isReady ? 'Перейти к выбору дополнений' : 'Выберите номер'}
						className="forced-colors:bg-[ButtonText] forced-colors:text-[ButtonFace] forced-colors:border-[ButtonText]"
					>
						Продолжить
						<ArrowRight className="ml-1 size-4" aria-hidden />
					</Button>
				</div>
			</div>
			<DrawerContent>
				<DrawerHeader>
					<DrawerTitle>Детали бронирования</DrawerTitle>
				</DrawerHeader>
				<div className="px-4 pb-6">{summaryBody}</div>
			</DrawerContent>
		</Drawer>
	)
}

interface SummaryBodyProps {
	readonly checkIn: string
	readonly checkOut: string
	readonly nights: number
	readonly guestsLabel: string
	readonly selectedRoomType: PublicRoomType | null
	readonly selectedRate: PublicRateOption | null
	readonly taxPct: string | null
	readonly isReady: boolean
	readonly onContinue: () => void
}

function SummaryBody({
	checkIn,
	checkOut,
	nights,
	guestsLabel,
	selectedRoomType,
	selectedRate,
	taxPct,
	isReady,
	onContinue,
}: SummaryBodyProps) {
	return (
		<>
			<header>
				<h2 className="text-base font-semibold">Ваше бронирование</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					{formatDateRange(checkIn, checkOut)} · {nights}{' '}
					{ruPlural(nights, 'ночь', 'ночи', 'ночей')} · {guestsLabel}
				</p>
			</header>

			{selectedRoomType ? (
				<div data-testid="summary-room" className="mt-4 rounded-lg bg-muted/50 p-3">
					<p className="text-sm font-medium">{selectedRoomType.name}</p>
					{selectedRate ? (
						<p className="mt-0.5 text-xs text-muted-foreground">{selectedRate.name}</p>
					) : null}
				</div>
			) : (
				<p className="mt-4 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
					Выберите номер, чтобы увидеть итоговую цену
				</p>
			)}

			{selectedRate ? (
				<>
					<dl data-testid="summary-breakdown" className="mt-4 space-y-2 border-t pt-4 text-sm">
						<div className="flex justify-between">
							<dt className="text-muted-foreground">
								Проживание · {nights} {ruPlural(nights, 'ночь', 'ночи', 'ночей')}
							</dt>
							<dd className="font-medium tabular-nums">
								{formatRub(selectedRate.subtotalKopecks)}
							</dd>
						</div>
						{selectedRate.tourismTaxKopecks > 0 && taxPct ? (
							<div className="flex justify-between">
								<dt className="text-muted-foreground">
									Туристический налог · <span className="tabular-nums">{taxPct}%</span>
								</dt>
								<dd className="font-medium tabular-nums">
									{formatRub(selectedRate.tourismTaxKopecks)}
								</dd>
							</div>
						) : null}
						<div className="flex justify-between border-t pt-2 text-base font-semibold">
							<dt>Итого</dt>
							<dd data-testid="summary-total-detail" className="text-primary tabular-nums">
								{formatRub(selectedRate.totalKopecks)}
							</dd>
						</div>
					</dl>
					{selectedRate.isRefundable && selectedRate.freeCancelDeadlineUtc ? (
						<p
							data-testid="summary-cancel-deadline"
							className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-1 text-xs text-emerald-800 dark:text-emerald-300"
						>
							<ShieldCheck className="size-3.5" aria-hidden />
							Отмена без штрафа до {formatMoscowDateTime(selectedRate.freeCancelDeadlineUtc)}
						</p>
					) : (
						<p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
							Тариф невозвратный — отмена и изменения не разрешены
						</p>
					)}
				</>
			) : null}

			<Button
				type="button"
				size="lg"
				className="mt-5 w-full forced-colors:bg-[ButtonText] forced-colors:text-[ButtonFace] forced-colors:border-[ButtonText]"
				disabled={!isReady}
				onClick={onContinue}
				data-testid="summary-continue-detail"
				aria-label={isReady ? 'Перейти к выбору дополнений' : 'Выберите номер, чтобы продолжить'}
			>
				Продолжить
				<ArrowRight className="ml-1 size-4" aria-hidden />
			</Button>

			<p className="mt-3 text-center text-[11px] text-muted-foreground">
				Прямое бронирование · экономия до 17% против OTA
			</p>
		</>
	)
}
