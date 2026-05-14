/**
 * `<InventoryRatePlansPage>` — admin surface for managing rate plans.
 * Phase III + III.bis of inventory-admin shipping (edit + delete added).
 *
 * Sections:
 *   - Header «Тарифные планы» + «+ Тариф» CTA.
 *   - Cards per RatePlan grouped by RoomType: name + code badge + flags +
 *     row actions (Pencil = edit, Trash = delete-confirm).
 *   - Empty state: «У вас нет тарифов — создайте первый» (also covers
 *     «нет категорий» с redirect hint к страница «Номера и категории»).
 */
import { useQuery } from '@tanstack/react-query'
import type { MealsIncluded, RatePlan } from '@horeca/shared'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { ratePlansQueryOptions, useDeleteRatePlan } from '../hooks/use-rate-plans.ts'
import { roomTypesQueryOptions } from '../hooks/use-room-types.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { RatePlanFormSheet } from './rate-plan-form-sheet.tsx'

const MEAL_LABELS_SHORT: Record<MealsIncluded, string> = {
	none: 'Без питания',
	breakfast: 'Завтрак',
	halfBoard: 'Полупансион',
	fullBoard: 'Полный пансион',
	allInclusive: 'All incl.',
}

export interface InventoryRatePlansPageProps {
	readonly propertyId: string
}

export function InventoryRatePlansPage({ propertyId }: InventoryRatePlansPageProps) {
	const ratePlansQuery = useQuery(ratePlansQueryOptions(propertyId))
	const roomTypesQuery = useQuery(roomTypesQueryOptions(propertyId))
	const deletePlan = useDeleteRatePlan(propertyId)

	const [createOpen, setCreateOpen] = useState(false)
	const [editTarget, setEditTarget] = useState<RatePlan | null>(null)
	const [deleteTarget, setDeleteTarget] = useState<RatePlan | null>(null)

	const isLoading = ratePlansQuery.isPending || roomTypesQuery.isPending
	const error = ratePlansQuery.error ?? roomTypesQuery.error
	const ratePlans = ratePlansQuery.data ?? []
	const roomTypes = roomTypesQuery.data ?? []
	const roomTypeNameById = new Map(roomTypes.map((rt) => [rt.id, rt.name] as const))

	const grouped = new Map<string, typeof ratePlans>()
	for (const plan of ratePlans) {
		const list = grouped.get(plan.roomTypeId) ?? []
		list.push(plan)
		grouped.set(plan.roomTypeId, list)
	}

	async function handleConfirmDelete() {
		if (!deleteTarget) return
		try {
			await deletePlan.mutateAsync({ id: deleteTarget.id })
			toast.success(`Тариф «${deleteTarget.name}» удалён`)
			setDeleteTarget(null)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Не удалось удалить тариф')
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-4">
				<h2 className="text-lg font-medium">Тарифные планы</h2>
				<Button onClick={() => setCreateOpen(true)} size="sm" disabled={roomTypes.length === 0}>
					<Plus className="size-4" aria-hidden="true" />
					Тариф
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
					Не удалось загрузить тарифы: {error.message}
				</div>
			) : roomTypes.length === 0 ? (
				<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					Сначала создайте хотя бы одну категорию номеров — на странице «Номера и категории».
				</div>
			) : ratePlans.length === 0 ? (
				<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					У вас пока нет тарифов. Создайте первый — например, «Базовый» или «Невозвратный».
				</div>
			) : (
				<div className="space-y-6">
					{Array.from(grouped.entries()).map(([roomTypeId, plans]) => (
						<section key={roomTypeId} className="space-y-2">
							<h3 className="text-sm font-medium text-muted-foreground">
								{roomTypeNameById.get(roomTypeId) ?? 'Без категории'}
							</h3>
							<ul className="grid gap-2">
								{plans.map((plan) => (
									<li
										key={plan.id}
										className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3"
									>
										<div className="min-w-0 flex-1">
											<p className="font-medium">{plan.name}</p>
											<p className="text-xs text-muted-foreground">
												{plan.isRefundable
													? `Возврат за ${plan.cancellationHours ?? 0} ч`
													: 'Невозвратный'}
												{' · '}
												{MEAL_LABELS_SHORT[plan.mealsIncluded]}
												{' · '}
												от {plan.minStay} {plan.minStay === 1 ? 'ночи' : 'ночей'}
											</p>
										</div>
										<Badge variant="outline" className="font-mono uppercase">
											{plan.code}
										</Badge>
										{plan.isDefault ? <Badge>По умолчанию</Badge> : null}
										<div className="flex items-center gap-1">
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setEditTarget(plan)}
												aria-label={`Изменить тариф «${plan.name}»`}
											>
												<Pencil className="size-4" aria-hidden="true" />
												Изменить
											</Button>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setDeleteTarget(plan)}
												aria-label={`Удалить тариф «${plan.name}»`}
												className="text-destructive hover:bg-destructive/10"
											>
												<Trash2 className="size-4" aria-hidden="true" />
											</Button>
										</div>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			)}

			<RatePlanFormSheet
				open={createOpen}
				onOpenChange={setCreateOpen}
				propertyId={propertyId}
				roomTypes={roomTypes}
			/>
			<RatePlanFormSheet
				open={editTarget !== null}
				onOpenChange={(open) => {
					if (!open) setEditTarget(null)
				}}
				propertyId={propertyId}
				roomTypes={roomTypes}
				existing={editTarget}
			/>
			{deleteTarget ? (
				<ConfirmDialog
					open
					onOpenChange={(open) => {
						if (!open) setDeleteTarget(null)
					}}
					title={`Удалить «${deleteTarget.name}»?`}
					description={`Тариф «${deleteTarget.name}» (${deleteTarget.code}) будет удалён вместе со всеми ценами по нему. Это действие невозможно отменить.`}
					confirmLabel="Удалить тариф"
					onConfirm={handleConfirmDelete}
					isPending={deletePlan.isPending}
				/>
			) : null}
		</div>
	)
}
