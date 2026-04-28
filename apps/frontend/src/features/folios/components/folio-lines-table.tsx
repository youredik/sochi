/**
 * `<FolioLinesTable>` — табличка начислений (folioLine) на вкладке Lines.
 *
 * Вынесен из folio route в отдельный файл per shadcn 4.5 + Fast Refresh
 * канон (lint/style/useComponentExportOnlyModules — route файл должен
 * экспортировать только Route).
 */
import type { FolioLine } from '@horeca/shared'
import { ListIcon } from 'lucide-react'
import { EmptyState } from '../../../components/empty-state.tsx'
import { Money } from '../../../components/money.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { formatDateShort } from '../../../lib/format-ru.ts'

export function FolioLinesTable({ lines }: { lines: FolioLine[] }) {
	if (lines.length === 0) {
		return (
			<EmptyState
				icon={ListIcon}
				title="Начислений нет"
				description="Строки фолио появятся после ночного прогона аудита либо при ручном posting."
			/>
		)
	}
	return (
		<div className="overflow-x-auto rounded-md border">
			<table className="w-full text-sm">
				<thead className="bg-muted/50">
					<tr className="text-left">
						<th className="p-2 font-medium">Дата</th>
						<th className="p-2 font-medium">Категория</th>
						<th className="p-2 font-medium">Описание</th>
						<th className="p-2 text-right font-medium">Сумма</th>
						<th className="p-2 font-medium">Статус</th>
					</tr>
				</thead>
				<tbody>
					{lines.map((line) => (
						<tr key={line.id} className="border-t">
							<td className="p-2 whitespace-nowrap">
								<time dateTime={line.postedAt ?? line.createdAt}>
									{formatDateShort(line.postedAt ?? line.createdAt)}
								</time>
							</td>
							<td className="p-2">{categoryLabel(line.category)}</td>
							<td className="p-2">{line.description}</td>
							<td className="p-2 text-right tabular-nums">
								<Money kopecks={BigInt(line.amountMinor)} />
							</td>
							<td className="p-2">
								<LineStatusBadge status={line.lineStatus} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

function categoryLabel(category: string): string {
	switch (category) {
		case 'accommodation':
			return 'Проживание'
		case 'tourismTax':
			return 'Туристический сбор'
		case 'fnb':
			return 'F&B'
		case 'minibar':
			return 'Мини-бар'
		case 'spa':
			return 'СПА'
		case 'parking':
			return 'Парковка'
		case 'laundry':
			return 'Прачечная'
		case 'phone':
			return 'Телефон'
		case 'misc':
			return 'Прочее'
		case 'cancellationFee':
			return 'Штраф за отмену'
		case 'noShowFee':
			return 'Штраф за неявку'
		default:
			return category
	}
}

function LineStatusBadge({ status }: { status: string }) {
	switch (status) {
		case 'posted':
			return <Badge variant="outline">Проведено</Badge>
		case 'draft':
			return <Badge variant="secondary">Черновик</Badge>
		case 'void':
			return (
				<Badge variant="outline" className="line-through">
					Сторно
				</Badge>
			)
		default:
			return <Badge variant="outline">{status}</Badge>
	}
}
