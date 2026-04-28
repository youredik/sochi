/**
 * `<ReceivablesTable>` — sortable таблица дебиторских счетов.
 *
 * Per memory `project_m6_7_frontend_research.md`:
 *   - **TanStack Table 8.21** (hand-composed — НЕ shadcn DataTable шаблон,
 *     который пока не покрывает Tanstack Table в 4.5).
 *   - 7 колонок: createdAt(asc default) / bookingId / balance / daysOpen /
 *     bucket / status / action.
 *   - Только sortable: createdAt, balance, daysOpen — остальные enableSorting=false.
 *   - Per-row link на folio screen (passes search={tab:'lines'} для
 *     validateSearch invariant).
 *
 * Вынесен из receivables route в отдельный файл per Fast Refresh канон
 * (lint/style/useComponentExportOnlyModules).
 */
import type { Folio } from '@horeca/shared'
import { Link } from '@tanstack/react-router'
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, ReceiptIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState } from '../../../components/empty-state.tsx'
import { Money } from '../../../components/money.tsx'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { formatDateShort } from '../../../lib/format-ru.ts'
import { FolioStatusBadge } from '../../folios/components/folio-status-badge.tsx'
import { type AgingBucket, bucketForDays, daysBetween } from '../lib/aging-buckets.ts'

interface ReceivableRow {
	folio: Folio
	daysOpen: number
	bucket: AgingBucket
}

export function ReceivablesTable({
	folios,
	now,
	orgSlug,
}: {
	folios: Folio[]
	now: Date
	orgSlug: string
}) {
	const rows = useMemo<ReceivableRow[]>(
		() =>
			folios.map((folio) => {
				const days = Math.max(0, daysBetween(folio.createdAt, now))
				return { folio, daysOpen: days, bucket: bucketForDays(days) }
			}),
		[folios, now],
	)

	const columns = useMemo<ColumnDef<ReceivableRow>[]>(
		() => [
			{
				id: 'createdAt',
				header: 'Дата открытия',
				accessorFn: (r) => r.folio.createdAt,
				cell: (ctx) => (
					<time dateTime={ctx.row.original.folio.createdAt}>
						{formatDateShort(ctx.row.original.folio.createdAt)}
					</time>
				),
				sortingFn: (a, b) =>
					new Date(a.original.folio.createdAt).getTime() -
					new Date(b.original.folio.createdAt).getTime(),
			},
			{
				id: 'bookingId',
				header: 'Бронь',
				cell: (ctx) => (
					<span className="font-mono text-xs">{ctx.row.original.folio.bookingId.slice(-8)}</span>
				),
				enableSorting: false,
			},
			{
				id: 'balance',
				header: 'Баланс',
				accessorFn: (r) => BigInt(r.folio.balanceMinor),
				cell: (ctx) => (
					<div className="text-right tabular-nums">
						<Money kopecks={BigInt(ctx.row.original.folio.balanceMinor)} />
					</div>
				),
				sortingFn: (a, b) => {
					const av = BigInt(a.original.folio.balanceMinor)
					const bv = BigInt(b.original.folio.balanceMinor)
					return av < bv ? -1 : av > bv ? 1 : 0
				},
			},
			{
				id: 'daysOpen',
				header: 'Дней',
				accessorFn: (r) => r.daysOpen,
				cell: (ctx) => <span className="text-right tabular-nums">{ctx.row.original.daysOpen}</span>,
				sortingFn: (a, b) => a.original.daysOpen - b.original.daysOpen,
			},
			{
				id: 'bucket',
				header: 'Возраст',
				accessorFn: (r) => r.bucket,
				cell: (ctx) => <BucketBadge bucket={ctx.row.original.bucket} />,
				enableSorting: false,
			},
			{
				id: 'status',
				header: 'Статус',
				accessorFn: (r) => r.folio.status,
				cell: (ctx) => <FolioStatusBadge status={ctx.row.original.folio.status} />,
				enableSorting: false,
			},
			{
				id: 'action',
				header: () => <span className="sr-only">Действие</span>,
				cell: (ctx) => (
					<div className="text-right">
						<Button asChild size="sm" variant="outline">
							<Link
								to="/o/$orgSlug/bookings/$bookingId/folios/$folioId"
								params={{
									orgSlug,
									bookingId: ctx.row.original.folio.bookingId,
									folioId: ctx.row.original.folio.id,
								}}
								search={{ tab: 'lines' as const }}
							>
								Открыть
							</Link>
						</Button>
					</div>
				),
				enableSorting: false,
			},
		],
		[orgSlug],
	)

	const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: false }])

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
			<EmptyState
				icon={ReceiptIcon}
				title="Нет открытых счетов"
				description="Все счета закрыты или ещё не выставлены — проверьте новые бронирования и статусы фолио."
			/>
		)
	}

	return (
		<div className="overflow-x-auto rounded-md border">
			<table className="w-full text-sm">
				<caption className="sr-only">
					Дебиторская задолженность по счетам. Колонки сортируемы.
				</caption>
				<thead className="bg-muted/50">
					{table.getHeaderGroups().map((headerGroup) => (
						<tr key={headerGroup.id} className="text-left">
							{headerGroup.headers.map((header) => {
								const sort = header.column.getIsSorted()
								const canSort = header.column.getCanSort()
								return (
									<th key={header.id} scope="col" className="p-2 font-medium">
										{canSort ? (
											<button
												type="button"
												onClick={header.column.getToggleSortingHandler()}
												className="inline-flex items-center gap-1 hover:text-foreground"
												aria-label={`Сортировать по ${typeof header.column.columnDef.header === 'string' ? header.column.columnDef.header : header.id}`}
											>
												{flexRender(header.column.columnDef.header, header.getContext())}
												{sort === 'asc' ? (
													<ArrowUp className="size-3" />
												) : sort === 'desc' ? (
													<ArrowDown className="size-3" />
												) : (
													<ArrowUpDown className="size-3 opacity-50" />
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

function BucketBadge({ bucket }: { bucket: AgingBucket }) {
	switch (bucket) {
		case 'current':
			return <Badge variant="outline">Текущая</Badge>
		case '8to30':
			return <Badge variant="secondary">8–30 дн.</Badge>
		case '31to60':
			return <Badge variant="secondary">31–60 дн.</Badge>
		case 'over60':
			return <Badge variant="destructive">{'>60 дн.'}</Badge>
	}
}
