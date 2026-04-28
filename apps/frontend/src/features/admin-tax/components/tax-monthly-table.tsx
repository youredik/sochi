/**
 * Monthly breakdown table — рассчитан под поле `005` декларации КНД 1153008
 * (memory `project_ru_tax_form_2026q1.md`). Один ряд на месяц внутри
 * выбранного периода.
 *
 * Hand-composed `<table>` (НЕ shadcn DataTable) per receivables canon —
 * у нас фиксированное число строк (≤3 для квартала), сортировка не нужна.
 */
import { CalendarRangeIcon } from 'lucide-react'
import { EmptyState } from '../../../components/empty-state.tsx'
import { Money } from '../../../components/money.tsx'
import { formatMonthRu } from '../lib/format-month.ts'
import { microsToKopecks } from '../lib/micros-to-kopecks.ts'
import type { TourismTaxOrgReportMonthly } from '../types.ts'

export function TaxMonthlyTable({ monthly }: { monthly: TourismTaxOrgReportMonthly[] }) {
	if (monthly.length === 0) {
		return (
			<EmptyState
				icon={CalendarRangeIcon}
				title="Начислений нет"
				description="За выбранный период туристический налог не начислялся — попробуйте расширить диапазон."
				className="py-6"
			/>
		)
	}
	return (
		<div className="overflow-x-auto rounded-md border">
			<table className="w-full text-sm">
				<caption className="sr-only">
					Помесячная разбивка туристического налога — для строки 005 декларации КНД 1153008.
				</caption>
				<thead className="bg-muted/50">
					<tr className="text-left">
						<th scope="col" className="p-2 font-medium">
							Месяц
						</th>
						<th scope="col" className="p-2 font-medium text-right">
							Бронирований
						</th>
						<th scope="col" className="p-2 font-medium text-right">
							Ночей
						</th>
						<th scope="col" className="p-2 font-medium text-right">
							Налоговая база
						</th>
						<th scope="col" className="p-2 font-medium text-right">
							Налог
						</th>
					</tr>
				</thead>
				<tbody>
					{monthly.map((m) => (
						<tr key={m.month} className="border-t">
							<td className="p-2 font-medium tabular-nums">{formatMonthRu(m.month)}</td>
							<td className="p-2 text-right tabular-nums">{m.bookingsCount}</td>
							<td className="p-2 text-right tabular-nums">{m.totalNights}</td>
							<td className="p-2 text-right tabular-nums">
								<Money kopecks={microsToKopecks(m.accommodationBaseMicros)} />
							</td>
							<td className="p-2 text-right tabular-nums">
								<Money kopecks={microsToKopecks(m.tourismTaxMicros)} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
