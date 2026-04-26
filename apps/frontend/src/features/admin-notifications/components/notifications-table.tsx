/**
 * Notifications outbox table — sortable, hand-composed (TanStack Table 8.21
 * pattern from receivables canon).
 *
 * Колонки: Дата / Тип / Получатель / Канал / Статус / Попыток.
 * Click on row → URL search.id = ntf_xxx → drill-down Sheet.
 */
import type { Notification } from '@horeca/shared'
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '../../../components/ui/badge.tsx'
import { formatDateShort } from '../../../lib/format-ru.ts'
import { notificationKindLabel, notificationStatusBadge } from '../lib/notification-labels.ts'

export function NotificationsTable({
	items,
	onRowClick,
}: {
	items: Notification[]
	onRowClick: (id: string) => void
}) {
	const columns = useMemo<ColumnDef<Notification>[]>(
		() => [
			{
				id: 'createdAt',
				header: 'Создано',
				accessorFn: (r) => r.createdAt,
				cell: (ctx) => (
					<time dateTime={ctx.row.original.createdAt} className="tabular-nums">
						{formatDateShort(ctx.row.original.createdAt)}
					</time>
				),
				sortingFn: (a, b) => {
					const av = a.original.createdAt
					const bv = b.original.createdAt
					return av < bv ? -1 : av > bv ? 1 : 0
				},
			},
			{
				id: 'kind',
				header: 'Тип',
				accessorFn: (r) => r.kind,
				cell: (ctx) => <span>{notificationKindLabel(ctx.row.original.kind)}</span>,
				enableSorting: false,
			},
			{
				id: 'recipient',
				header: 'Получатель',
				accessorFn: (r) => r.recipient,
				cell: (ctx) => <span className="font-mono text-xs">{ctx.row.original.recipient}</span>,
				enableSorting: false,
			},
			{
				id: 'channel',
				header: 'Канал',
				accessorFn: (r) => r.channel,
				cell: (ctx) => (
					<Badge variant="outline" className="font-normal">
						{ctx.row.original.channel}
					</Badge>
				),
				enableSorting: false,
			},
			{
				id: 'status',
				header: 'Статус',
				accessorFn: (r) => r.status,
				cell: (ctx) => {
					const conf = notificationStatusBadge(ctx.row.original.status)
					return <Badge variant={conf.variant}>{conf.label}</Badge>
				},
				enableSorting: false,
			},
			{
				id: 'retryCount',
				header: 'Попыток',
				accessorFn: (r) => r.retryCount,
				cell: (ctx) => (
					<span className="text-right tabular-nums">{ctx.row.original.retryCount}</span>
				),
				sortingFn: (a, b) => a.original.retryCount - b.original.retryCount,
			},
		],
		[],
	)

	const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }])

	const table = useReactTable({
		data: items,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
	})

	if (items.length === 0) {
		return (
			<p className="py-8 text-center text-muted-foreground">Уведомлений с такими фильтрами нет.</p>
		)
	}

	return (
		<div className="overflow-x-auto rounded-md border">
			<table className="w-full text-sm">
				<caption className="sr-only">
					История уведомлений outbox. Кликните по строке для деталей.
				</caption>
				<thead className="bg-muted/50">
					{table.getHeaderGroups().map((headerGroup) => (
						<tr key={headerGroup.id} className="text-left">
							{headerGroup.headers.map((header) => {
								const sort = header.column.getIsSorted()
								const canSort = header.column.getCanSort()
								const headerLabel =
									typeof header.column.columnDef.header === 'string'
										? header.column.columnDef.header
										: header.id
								return (
									<th key={header.id} scope="col" className="p-2 font-medium">
										{canSort ? (
											<button
												type="button"
												onClick={header.column.getToggleSortingHandler()}
												className="inline-flex items-center gap-1 hover:text-foreground"
												aria-label={`Сортировать по ${headerLabel}`}
											>
												{flexRender(header.column.columnDef.header, header.getContext())}
												{sort === 'asc' ? (
													<ArrowUp className="size-3" aria-hidden />
												) : sort === 'desc' ? (
													<ArrowDown className="size-3" aria-hidden />
												) : (
													<ArrowUpDown className="size-3 opacity-50" aria-hidden />
												)}
											</button>
										) : (
											flexRender(header.column.columnDef.header, header.getContext())
										)}
									</th>
								)
							})}
						</tr>
					))}
				</thead>
				<tbody>
					{table.getRowModel().rows.map((row) => (
						<tr
							key={row.id}
							className="cursor-pointer border-t hover:bg-muted/30"
							onClick={() => onRowClick(row.original.id)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault()
									onRowClick(row.original.id)
								}
							}}
							tabIndex={0}
							aria-label={`Открыть уведомление ${row.original.id}`}
						>
							{row.getVisibleCells().map((cell) => (
								<td key={cell.id} className="p-2">
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
