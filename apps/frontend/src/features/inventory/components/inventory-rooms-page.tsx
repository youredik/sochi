/**
 * `<InventoryRoomsPage>` — admin surface for managing room categories (RoomType)
 * + individual rooms. Phase II of inventory-admin shipping.
 *
 * Sections:
 *   - Header «Категории номеров» + «+ Категория» CTA.
 *   - Cards per RoomType: name + «N номеров, до K гостей» + «+ Номера» CTA.
 *   - Empty state: «У вас нет категорий — создайте первую».
 *
 * Edit / delete UX deferred к Phase II.bis (per `[[no_halfway]]` keep
 * atomic). Read + create unlocks 80% of the operator value (most-common
 * post-onboarding tasks: add new category, add new rooms when a floor opens).
 *
 * Mobile: cards stack 1-column; CTA buttons full-width.
 */
import { useQuery } from '@tanstack/react-query'
import type { RoomType } from '@horeca/shared'
import { Loader2, Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../../components/ui/button.tsx'
import { roomTypesQueryOptions } from '../hooks/use-room-types.ts'
import { roomsQueryOptions } from '../hooks/use-rooms.ts'
import { CategoryFormSheet } from './category-form-sheet.tsx'
import { RoomsBulkAddSheet } from './rooms-bulk-add-sheet.tsx'

export interface InventoryRoomsPageProps {
	readonly propertyId: string
}

export function InventoryRoomsPage({ propertyId }: InventoryRoomsPageProps) {
	const roomTypesQuery = useQuery(roomTypesQueryOptions(propertyId))
	const roomsQuery = useQuery(roomsQueryOptions(propertyId))

	const [categorySheetOpen, setCategorySheetOpen] = useState(false)
	const [bulkAddFor, setBulkAddFor] = useState<RoomType | null>(null)

	const roomCountByType = new Map<string, number>()
	for (const room of roomsQuery.data ?? []) {
		roomCountByType.set(room.roomTypeId, (roomCountByType.get(room.roomTypeId) ?? 0) + 1)
	}

	const isLoading = roomTypesQuery.isPending || roomsQuery.isPending
	const error = roomTypesQuery.error ?? roomsQuery.error
	const roomTypes = roomTypesQuery.data ?? []

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-4">
				<h2 className="text-lg font-medium">Категории номеров</h2>
				<Button onClick={() => setCategorySheetOpen(true)} size="sm">
					<Plus className="size-4" aria-hidden="true" />
					Категория
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
					Не удалось загрузить инвентарь: {error.message}
				</div>
			) : roomTypes.length === 0 ? (
				<div className="rounded-lg border border-dashed p-8 text-center">
					<p className="text-sm text-muted-foreground">
						У вас пока нет категорий номеров. Создайте первую — например, «Стандартный».
					</p>
				</div>
			) : (
				<ul className="grid gap-3">
					{roomTypes.map((rt) => {
						const roomCount = roomCountByType.get(rt.id) ?? 0
						return (
							<li
								key={rt.id}
								className="flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3"
							>
								<div className="min-w-0">
									<p className="font-medium">{rt.name}</p>
									<p className="text-xs text-muted-foreground">
										{roomCount} {pluralRu(roomCount, 'номер', 'номера', 'номеров')} · до{' '}
										{rt.maxOccupancy} {pluralRu(rt.maxOccupancy, 'гостя', 'гостей', 'гостей')}
									</p>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setBulkAddFor(rt)}
									aria-label={`Добавить номера в категорию «${rt.name}»`}
								>
									<Plus className="size-4" aria-hidden="true" />
									Номера
								</Button>
							</li>
						)
					})}
				</ul>
			)}

			<CategoryFormSheet
				open={categorySheetOpen}
				onOpenChange={setCategorySheetOpen}
				propertyId={propertyId}
			/>
			<RoomsBulkAddSheet
				open={bulkAddFor !== null}
				onOpenChange={(open) => {
					if (!open) setBulkAddFor(null)
				}}
				propertyId={propertyId}
				roomType={bulkAddFor}
			/>
		</div>
	)
}

/** Tiny RU plural helper: (1 номер, 2 номера, 5 номеров). */
function pluralRu(n: number, one: string, few: string, many: string): string {
	const mod10 = n % 10
	const mod100 = n % 100
	if (mod10 === 1 && mod100 !== 11) return one
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
	return many
}
