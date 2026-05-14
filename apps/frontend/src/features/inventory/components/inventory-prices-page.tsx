/**
 * `<InventoryPricesPage>` — admin pricing surface. Phase IV of inventory-
 * admin shipping (research 2026-05-14: Bnovo modal-driven canon).
 *
 * Layout:
 *   - Header «Цены и ограничения» + «Изменить цены» CTA.
 *   - Read-only grid: rows = next 90 days, columns = (roomType / ratePlan)
 *     combinations с code in header. Cells show price or «—».
 *   - Sticky date column + first-row header per CSS `position: sticky` —
 *     same APG-grid canon as Шахматка но без booking-bands.
 *
 * Bulk-edit is the ONLY edit affordance in v1 — operator selects date
 * range + day-of-week + rate plans + price. Per-cell click-to-edit deferred
 * к Phase IV.bis (consistent с Bnovo / Cloudbeds where modal is primary).
 *
 * No `react-data-grid` dep: at SMB scale (90 rows × ≤12 cols ≈ 1080 cells)
 * a plain CSS Grid renders без virtualization. Excel-style Cmd+C/V/D
 * power-user shortcuts not needed when modal-driven editing covers 100% of
 * the operator's intent. Defer big lib to когда the workflow demands it.
 */
import type { Rate, RatePlan } from '@horeca/shared'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Loader2, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '../../../components/ui/button.tsx'
import { ratePlansQueryOptions } from '../hooks/use-rate-plans.ts'
import { roomTypesQueryOptions } from '../hooks/use-room-types.ts'
import { isoDateOffset, ratesRangeQueryOptions } from '../hooks/use-rates.ts'
import { BulkEditPricesSheet } from './bulk-edit-prices-sheet.tsx'
import { type SingleRateEditTarget, SingleRateEditSheet } from './single-rate-edit-sheet.tsx'

const WINDOW_DAYS = 90

export interface InventoryPricesPageProps {
	readonly propertyId: string
}

export function InventoryPricesPage({ propertyId }: InventoryPricesPageProps) {
	const roomTypesQuery = useQuery(roomTypesQueryOptions(propertyId))
	const ratePlansQuery = useQuery(ratePlansQueryOptions(propertyId))
	const ratePlans = ratePlansQuery.data ?? []
	const roomTypes = roomTypesQuery.data ?? []

	const [sheetOpen, setSheetOpen] = useState(false)
	const [singleEditTarget, setSingleEditTarget] = useState<SingleRateEditTarget | null>(null)

	const fromDate = useMemo(() => isoDateOffset(0), [])
	const toDate = useMemo(() => isoDateOffset(WINDOW_DAYS - 1), [])
	const dateRow = useMemo(() => {
		const out: string[] = []
		for (let i = 0; i < WINDOW_DAYS; i += 1) out.push(isoDateOffset(i))
		return out
	}, [])

	const rateQueries = useQueries({
		queries: ratePlans.map((plan) => ratesRangeQueryOptions(plan.id, fromDate, toDate)),
	})

	const isLoading =
		roomTypesQuery.isPending || ratePlansQuery.isPending || rateQueries.some((q) => q.isPending)
	const error =
		roomTypesQuery.error ?? ratePlansQuery.error ?? rateQueries.find((q) => q.error)?.error ?? null

	// Map: ratePlanId → date → amount (string).
	const ratesByPlan = useMemo(() => {
		const m = new Map<string, Map<string, string>>()
		ratePlans.forEach((plan, idx) => {
			const list = (rateQueries[idx]?.data ?? []) as Rate[]
			const byDate = new Map(list.map((r) => [r.date, r.amount] as const))
			m.set(plan.id, byDate)
		})
		return m
	}, [ratePlans, rateQueries])

	const roomTypeNameById = new Map(roomTypes.map((rt) => [rt.id, rt.name] as const))
	const roomTypeById = new Map(roomTypes.map((rt) => [rt.id, rt] as const))

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-4">
				<h2 className="text-lg font-medium">Цены и ограничения</h2>
				<Button onClick={() => setSheetOpen(true)} size="sm" disabled={ratePlans.length === 0}>
					<Pencil className="size-4" aria-hidden="true" />
					Изменить цены
				</Button>
			</div>

			{isLoading ? (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					Загружаем…
				</div>
			) : error ? (
				<div
					role="alert"
					className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					Не удалось загрузить цены: {error.message}
				</div>
			) : ratePlans.length === 0 ? (
				<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					Сначала создайте хотя бы один тариф — на странице «Тарифы».
				</div>
			) : (
				<PricesGrid
					ratePlans={ratePlans}
					roomTypeNameById={roomTypeNameById}
					dateRow={dateRow}
					ratesByPlan={ratesByPlan}
					onCellClick={(date, plan) => {
						const rt = roomTypeById.get(plan.roomTypeId)
						if (!rt) return
						setSingleEditTarget({
							date,
							ratePlan: plan,
							roomType: rt,
							currentAmount: ratesByPlan.get(plan.id)?.get(date),
						})
					}}
				/>
			)}

			<BulkEditPricesSheet
				open={sheetOpen}
				onOpenChange={setSheetOpen}
				ratePlans={ratePlans}
				roomTypes={roomTypes}
				existingRates={ratesByPlan}
			/>
			{singleEditTarget ? (
				<SingleRateEditSheet
					key={`${singleEditTarget.ratePlan.id}-${singleEditTarget.date}`}
					open
					onOpenChange={(open) => {
						if (!open) setSingleEditTarget(null)
					}}
					target={singleEditTarget}
				/>
			) : null}
		</div>
	)
}

interface PricesGridProps {
	readonly ratePlans: ReadonlyArray<RatePlan>
	readonly roomTypeNameById: ReadonlyMap<string, string>
	readonly dateRow: ReadonlyArray<string>
	readonly ratesByPlan: ReadonlyMap<string, ReadonlyMap<string, string>>
	readonly onCellClick: (date: string, plan: RatePlan) => void
}

function PricesGrid({
	ratePlans,
	roomTypeNameById,
	dateRow,
	ratesByPlan,
	onCellClick,
}: PricesGridProps) {
	return (
		<section
			className="max-h-[60vh] overflow-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label="Сетка цен по дате и тарифу"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1/2.1.3 — axe «scrollable-region-focusable» requires keyboard-accessible scroll containers (Safari rendering); tabIndex={0} ensures keyboard scroll. <section> с aria-label получает implicit role=region.
			tabIndex={0}
		>
			<table className="w-full border-collapse text-sm">
				<thead className="sticky top-0 z-10 bg-card">
					<tr>
						<th className="sticky left-0 z-20 border-b border-r bg-card px-3 py-2 text-left font-medium">
							Дата
						</th>
						{ratePlans.map((plan) => (
							<th
								key={plan.id}
								className="border-b px-3 py-2 text-right font-medium whitespace-nowrap"
							>
								<div className="text-xs text-muted-foreground">
									{roomTypeNameById.get(plan.roomTypeId) ?? '—'}
								</div>
								<div className="font-mono uppercase">{plan.code}</div>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{dateRow.map((iso) => {
						const dow = new Date(`${iso}T00:00:00`).getDay()
						const isWeekend = dow === 0 || dow === 6
						return (
							<tr key={iso} className={isWeekend ? 'bg-muted/40' : undefined}>
								<th
									scope="row"
									className="sticky left-0 z-10 border-r bg-inherit px-3 py-1.5 text-left font-normal whitespace-nowrap"
								>
									{iso}
								</th>
								{ratePlans.map((plan) => {
									const amount = ratesByPlan.get(plan.id)?.get(iso)
									return (
										<td key={plan.id} className="p-0">
											<button
												type="button"
												onClick={() => onCellClick(iso, plan)}
												className="block w-full px-3 py-1.5 text-right tabular-nums hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
												aria-label={`Изменить цену ${iso} · ${plan.code}`}
											>
												{amount ? formatPrice(amount) : '—'}
											</button>
										</td>
									)
								})}
							</tr>
						)
					})}
				</tbody>
			</table>
		</section>
	)
}

function formatPrice(amount: string): string {
	const num = Number(amount)
	if (Number.isNaN(num)) return amount
	return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(num)} ₽`
}
