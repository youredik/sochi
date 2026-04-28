/**
 * Migration registrations admin table — TanStack Table 8.21 sortable.
 *
 * Per `project_m8_a_6_ui_canonical.md`:
 *   - Columns: Created / Booking / Guest / Stay / Channel / Status / Polled
 *   - Click row → URL ?id=mreg_xxx → drill-down Sheet
 *   - Status badge с EPGU_STATUS_LABELS_RU mapping
 *
 * a11y per `project_axe_a11y_gate.md`:
 *   - <table> с <caption className="sr-only">
 *   - <th scope="col">
 *   - tabular-nums для dates / counts
 */
import type { MigrationRegistration } from '@horeca/shared'
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, FileTextIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState } from '../../../components/empty-state.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { formatDateShort } from '../../../lib/format-ru.ts'
import { CHANNEL_LABEL_RU, statusBadgeFor } from '../lib/migration-status-labels.ts'

export function MigrationRegistrationsTable({
	items,
	onRowClick,
}: {
	items: MigrationRegistration[]
	onRowClick: (id: string) => void
}) {
	const columns = useMemo<ColumnDef<MigrationRegistration>[]>(
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
				id: 'bookingId',
				header: 'Бронь',
				accessorFn: (r) => r.bookingId,
				cell: (ctx) => <span className="font-mono text-xs">{ctx.row.original.bookingId}</span>,
				enableSorting: false,
			},
			{
				id: 'guestId',
				header: 'Гость',
				accessorFn: (r) => r.guestId,
				cell: (ctx) => <span className="font-mono text-xs">{ctx.row.original.guestId}</span>,
				enableSorting: false,
			},
			{
				id: 'stay',
				header: 'Пребывание',
				accessorFn: (r) => `${r.arrivalDate} → ${r.departureDate}`,
				cell: (ctx) => (
					<span className="tabular-nums text-sm">
						{ctx.row.original.arrivalDate} → {ctx.row.original.departureDate}
					</span>
				),
				enableSorting: false,
			},
			{
				id: 'channel',
				header: 'Канал',
				accessorFn: (r) => r.epguChannel,
				cell: (ctx) => (
					<Badge variant="outline" className="font-normal">
						{CHANNEL_LABEL_RU[ctx.row.original.epguChannel] ?? ctx.row.original.epguChannel}
					</Badge>
				),
				enableSorting: false,
			},
			{
				id: 'status',
				header: 'Статус',
				accessorFn: (r) => r.statusCode,
				cell: (ctx) => {
					const conf = statusBadgeFor(ctx.row.original.statusCode)
					return (
						<Badge variant={conf.variant}>
							{conf.icon ? <span aria-hidden="true">{conf.icon} </span> : null}
							{conf.label}
						</Badge>
					)
				},
				sortingFn: (a, b) => a.original.statusCode - b.original.statusCode,
			},
			{
				id: 'lastPolledAt',
				header: 'Опрошено',
				accessorFn: (r) => r.lastPolledAt ?? '',
				cell: (ctx) => {
					const t = ctx.row.original.lastPolledAt
					return (
						<span className="text-xs text-muted-foreground tabular-nums">
							{t ? formatDateShort(t) : '—'}
						</span>
					)
				},
				enableSorting: false,
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
			<EmptyState
				icon={FileTextIcon}
				title="Нет регистраций"
				description="Миграционный учёт создаётся автоматически при заселении гостя — заявки появятся здесь после первого check-in."
			/>
		)
	}

	return (
		<div className="rounded-md border overflow-x-auto">
			<table className="w-full caption-bottom text-sm">
				<caption className="sr-only">
					Список регистраций миграционного учёта (ЕПГУ Скала). Сортируется по дате создания.
				</caption>
				<thead className="[&_tr]:border-b bg-muted/50">
					{table.getHeaderGroups().map((hg) => (
						<tr key={hg.id} className="border-b">
							{hg.headers.map((header) => {
								const sort = header.column.getIsSorted()
								const canSort = header.column.getCanSort()
								return (
									<th
										key={header.id}
										scope="col"
										className="h-10 px-3 text-left align-middle font-medium text-muted-foreground"
									>
										{canSort ? (
											<button
												type="button"
												onClick={header.column.getToggleSortingHandler()}
												className="inline-flex items-center gap-1 hover:text-foreground"
												aria-label={`Сортировать ${typeof header.column.columnDef.header === 'string' ? header.column.columnDef.header : ''}`}
											>
												{flexRender(header.column.columnDef.header, header.getContext())}
												{sort === 'asc' ? (
													<ArrowUp className="h-3 w-3" aria-hidden="true" />
												) : sort === 'desc' ? (
													<ArrowDown className="h-3 w-3" aria-hidden="true" />
												) : (
													<ArrowUpDown className="h-3 w-3 opacity-50" aria-hidden="true" />
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
							onClick={() => onRowClick(row.original.id)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault()
									onRowClick(row.original.id)
								}
							}}
							tabIndex={0}
							className="border-b transition-colors hover:bg-muted/50 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
							aria-label={`Открыть детали регистрации ${row.original.id}`}
						>
							{row.getVisibleCells().map((cell) => (
								<td key={cell.id} className="p-3 align-middle">
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
