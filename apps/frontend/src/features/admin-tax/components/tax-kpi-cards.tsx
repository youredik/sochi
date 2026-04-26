/**
 * KPI cards — top-row dashboard summary для tourism-tax report.
 *
 * 4 metrics: bookings, nights, налоговая база, налог. Money отображается
 * через `<Money>` (NBSP grouping + sr-only pronunciation per memory
 * `project_m6_7_frontend_research.md`).
 *
 * Semantic markup `<dl>` + `<dt>`/`<dd>` per receivables canon (axe-clean).
 */
import { Money } from '../../../components/money.tsx'
import { microsToKopecks } from '../lib/micros-to-kopecks.ts'
import type { TourismTaxOrgReportKpi } from '../types.ts'

export function TaxKpiCards({ kpi }: { kpi: TourismTaxOrgReportKpi }) {
	return (
		<dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<KpiCard
				label="Бронирований"
				value={<span className="tabular-nums">{kpi.bookingsCount}</span>}
			/>
			<KpiCard label="Ночей" value={<span className="tabular-nums">{kpi.totalNights}</span>} />
			<KpiCard
				label="Налоговая база"
				value={<Money kopecks={microsToKopecks(kpi.accommodationBaseMicros)} />}
			/>
			<KpiCard
				label="Туристический налог"
				value={<Money kopecks={microsToKopecks(kpi.tourismTaxMicros)} />}
			/>
		</dl>
	)
}

function KpiCard({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="rounded-md border bg-card p-4">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="mt-1 text-2xl font-bold tabular-nums">{value}</dd>
		</div>
	)
}
