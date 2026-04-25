/**
 * KPI cards + aging breakdown — переиспользуемые presentational компоненты
 * для receivables dashboard. Извлечены в отдельный файл per Fast Refresh канон.
 */
import type { ReactNode } from 'react'
import { Money } from '../../../components/money.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card.tsx'
import type { ReceivablesSummary } from '../lib/aging-buckets.ts'

export function KpiCards({ summary }: { summary: ReceivablesSummary }) {
	return (
		<dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<KpiCard label="К получению" value={<Money kopecks={summary.totalOutstandingMinor} />} />
			<KpiCard
				label="Открытых счетов"
				value={<span className="text-2xl font-bold tabular-nums">{summary.totalCount}</span>}
			/>
			<KpiCard
				label="Просрочено (>7 дн.)"
				value={
					<span
						className={`text-2xl font-bold tabular-nums ${
							summary.overdueCount > 0 ? 'text-destructive' : ''
						}`}
					>
						{summary.overdueCount}
					</span>
				}
			/>
			<KpiCard
				label="Средний возраст"
				value={
					<span className="text-2xl font-bold tabular-nums">
						{summary.averageDaysOutstanding} {pluralRuDays(summary.averageDaysOutstanding)}
					</span>
				}
			/>
		</dl>
	)
}

export function AgingBreakdownCard({ summary }: { summary: ReceivablesSummary }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Разрез по возрасту</CardTitle>
			</CardHeader>
			<CardContent>
				<dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
					<AgingSlice label="0–7 дн." slice={summary.buckets.current} />
					<AgingSlice label="8–30 дн." slice={summary.buckets['8to30']} />
					<AgingSlice label="31–60 дн." slice={summary.buckets['31to60']} />
					<AgingSlice label=">60 дн." slice={summary.buckets.over60} />
				</dl>
			</CardContent>
		</Card>
	)
}

function KpiCard({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="rounded-md border bg-card p-4">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="mt-1 text-2xl font-bold tabular-nums">{value}</dd>
		</div>
	)
}

function AgingSlice({
	label,
	slice,
}: {
	label: string
	slice: { count: number; amountMinor: bigint }
}) {
	return (
		<div>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="font-medium tabular-nums">
				{slice.count} · <Money kopecks={slice.amountMinor} />
			</dd>
		</div>
	)
}

/**
 * `1 день / 2 дня / 5 дней` — RU plural agreement для "days".
 * Локальная копия (не импортируется из format-ru.ts чтобы избежать coupling
 * этого presentational модуля к money helper'ам).
 */
function pluralRuDays(n: number): string {
	const mod10 = n % 10
	const mod100 = n % 100
	if (mod10 === 1 && mod100 !== 11) return 'день'
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня'
	return 'дней'
}
