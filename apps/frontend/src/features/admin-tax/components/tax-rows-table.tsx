/**
 * Per-booking rows table — sortable, hand-composed (TanStack Table 8.21
 * pattern from receivables canon).
 *
 * Колонки: Дата заезда (asc default) / Объект / Гость / Ночей / Канал /
 * Статус / Льгота (placeholder до M8) / Налоговая база / Налог.
 *
 * Sorting: только числовые/дата колонки (Дата заезда, Ночей, Налог).
 */
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
import { Money } from '../../../components/money.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { formatDateShort } from '../../../lib/format-ru.ts'
import { channelLabel, statusBadgeConf } from '../lib/booking-labels.ts'
import { microsToKopecks } from '../lib/micros-to-kopecks.ts'
import type { TourismTaxOrgReportRow } from '../types.ts'

export function TaxRowsTable({ rows }: { rows: TourismTaxOrgReportRow[] }) {
	const columns = useMemo<ColumnDef<TourismTaxOrgReportRow>[]>(
		() => [
			{
				id: 'checkIn',
				header: 'Заезд',
				accessorFn: (r) => r.checkIn,
				cell: (ctx) => (
					<time dateTime={ctx.row.original.checkIn} className="tabular-nums">
						{formatDateShort(`${ctx.row.original.checkIn}T00:00:00Z`)}
					</time>
				),
				// Stable sort — return 0 on tie so TanStack Table preserves
				// insertion order для равных дат (multiple bookings per day).
				sortingFn: (a, b) => {
					const av = a.original.checkIn
					const bv = b.original.checkIn
					return av < bv ? -1 : av > bv ? 1 : 0
				},
			},
			{
				id: 'propertyName',
				header: 'Объект',
				accessorFn: (r) => r.propertyName,
				cell: (ctx) => <span>{ctx.row.original.propertyName}</span>,
				enableSorting: false,
			},
			{
				id: 'guestName',
				header: 'Гость',
				accessorFn: (r) => r.guestName,
				cell: (ctx) => <span>{ctx.row.original.guestName}</span>,
				enableSorting: false,
			},
			{
				id: 'nightsCount',
				header: 'Ночей',
				accessorFn: (r) => r.nightsCount,
				cell: (ctx) => (
					<span className="text-right tabular-nums">{ctx.row.original.nightsCount}</span>
				),
				sortingFn: (a, b) => a.original.nightsCount - b.original.nightsCount,
			},
			{
				id: 'channelCode',
				header: 'Канал',
				accessorFn: (r) => r.channelCode,
				cell: (ctx) => <ChannelBadge code={ctx.row.original.channelCode} />,
				enableSorting: false,
			},
			{
				id: 'status',
				header: 'Статус',
				accessorFn: (r) => r.status,
				cell: (ctx) => <StatusBadge status={ctx.row.original.status} />,
				enableSorting: false,
			},
			{
				id: 'exemption',
				header: 'Льгота',
				cell: () => <span className="text-muted-foreground">—</span>,
				enableSorting: false,
			},
			{
				id: 'base',
				header: 'Налоговая база',
				accessorFn: (r) => BigInt(r.accommodationBaseMicros),
				cell: (ctx) => (
					<div className="text-right tabular-nums">
						<Money kopecks={microsToKopecks(ctx.row.original.accommodationBaseMicros)} />
					</div>
				),
				sortingFn: (a, b) => {
					const av = BigInt(a.original.accommodationBaseMicros)
					const bv = BigInt(b.original.accommodationBaseMicros)
					return av < bv ? -1 : av > bv ? 1 : 0
				},
			},
			{
				id: 'tax',
				header: 'Налог',
				accessorFn: (r) => BigInt(r.tourismTaxMicros),
				cell: (ctx) => (
					<div className="text-right tabular-nums">
						<Money kopecks={microsToKopecks(ctx.row.original.tourismTaxMicros)} />
					</div>
				),
				sortingFn: (a, b) => {
					const av = BigInt(a.original.tourismTaxMicros)
					const bv = BigInt(b.original.tourismTaxMicros)
					return av < bv ? -1 : av > bv ? 1 : 0
				},
			},
		],
		[],
	)

	const [sorting, setSorting] = useState<SortingState>([{ id: 'checkIn', desc: false }])

	const table = useReactTable({
		data: rows,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
	})

	if (rows.length === 0) {
		return (
			<p className="py-8 text-center text-muted-foreground">
				За выбранный период бронирований с туристическим налогом нет.
			</p>
		)
	}

	return (
		<div className="overflow-x-auto rounded-md border">
			<table className="w-full text-sm">
				<caption className="sr-only">
					Бронирования с начислениями туристического налога за выбранный период.
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
						<tr key={row.id} className="border-t">
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

function ChannelBadge({ code }: { code: string }) {
	return (
		<Badge variant="outline" className="font-normal">
			{channelLabel(code)}
		</Badge>
	)
}

function StatusBadge({ status }: { status: string }) {
	const conf = statusBadgeConf(status)
	return <Badge variant={conf.variant}>{conf.label}</Badge>
}
