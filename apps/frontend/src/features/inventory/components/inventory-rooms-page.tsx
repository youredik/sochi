/**
 * `<InventoryRoomsPage>` — admin surface for managing room categories (RoomType)
 * + individual rooms. Phase II + II.bis of inventory-admin shipping.
 *
 * Sections:
 *   - Header «Категории номеров» + «+ Категория» CTA.
 *   - Cards per RoomType: name + «N номеров, до K гостей» + actions
 *     (Pencil = edit, Trash = delete-confirm, «+ Номера» = bulk-add rooms).
 *   - Empty state: «У вас нет категорий — создайте первую».
 *
 * Per-room management (rename, disable individual rooms 101..110) deferred
 * к its own sub-phase per `[[no_halfway]]` — SMB operators rarely need
 * per-room edits, bulk-add covers 80% of intent.
 */
import { useQuery } from '@tanstack/react-query'
import type { RoomType } from '@horeca/shared'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../../components/ui/button.tsx'
import { roomTypesQueryOptions, useDeleteRoomType } from '../hooks/use-room-types.ts'
import { roomsQueryOptions } from '../hooks/use-rooms.ts'
import { CategoryFormSheet } from './category-form-sheet.tsx'
import { ConfirmDialog } from './confirm-dialog.tsx'
import { RoomsBulkAddSheet } from './rooms-bulk-add-sheet.tsx'

export interface InventoryRoomsPageProps {
	readonly propertyId: string
}

export function InventoryRoomsPage({ propertyId }: InventoryRoomsPageProps) {
	const roomTypesQuery = useQuery(roomTypesQueryOptions(propertyId))
	const roomsQuery = useQuery(roomsQueryOptions(propertyId))
	const deleteRoomType = useDeleteRoomType(propertyId)

	const [createOpen, setCreateOpen] = useState(false)
	const [editTarget, setEditTarget] = useState<RoomType | null>(null)
	const [deleteTarget, setDeleteTarget] = useState<RoomType | null>(null)
	const [bulkAddFor, setBulkAddFor] = useState<RoomType | null>(null)

	const roomCountByType = new Map<string, number>()
	for (const room of roomsQuery.data ?? []) {
		roomCountByType.set(room.roomTypeId, (roomCountByType.get(room.roomTypeId) ?? 0) + 1)
	}

	const isLoading = roomTypesQuery.isPending || roomsQuery.isPending
	const error = roomTypesQuery.error ?? roomsQuery.error
	const roomTypes = roomTypesQuery.data ?? []

	async function handleConfirmDelete() {
		if (!deleteTarget) return
		try {
			await deleteRoomType.mutateAsync({ id: deleteTarget.id })
			toast.success(`Категория «${deleteTarget.name}» удалена`)
			setDeleteTarget(null)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Не удалось удалить категорию')
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-4">
				<h2 className="text-lg font-medium">Категории номеров</h2>
				<Button onClick={() => setCreateOpen(true)} size="sm">
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
								className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
							>
								<div className="min-w-0">
									<p className="font-medium">{rt.name}</p>
									<p className="text-xs text-muted-foreground">
										{roomCount} {pluralRu(roomCount, 'номер', 'номера', 'номеров')} · до{' '}
										{rt.maxOccupancy} {pluralRu(rt.maxOccupancy, 'гостя', 'гостей', 'гостей')}
									</p>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setEditTarget(rt)}
										aria-label={`Изменить категорию «${rt.name}»`}
									>
										<Pencil className="size-4" aria-hidden="true" />
										Изменить
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setBulkAddFor(rt)}
										aria-label={`Добавить номера в категорию «${rt.name}»`}
									>
										<Plus className="size-4" aria-hidden="true" />
										Номера
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setDeleteTarget(rt)}
										aria-label={`Удалить категорию «${rt.name}»`}
										className="text-destructive hover:bg-destructive/10"
									>
										<Trash2 className="size-4" aria-hidden="true" />
									</Button>
								</div>
							</li>
						)
					})}
				</ul>
			)}

			<CategoryFormSheet open={createOpen} onOpenChange={setCreateOpen} propertyId={propertyId} />
			<CategoryFormSheet
				open={editTarget !== null}
				onOpenChange={(open) => {
					if (!open) setEditTarget(null)
				}}
				propertyId={propertyId}
				existing={editTarget}
			/>
			<RoomsBulkAddSheet
				open={bulkAddFor !== null}
				onOpenChange={(open) => {
					if (!open) setBulkAddFor(null)
				}}
				propertyId={propertyId}
				roomType={bulkAddFor}
			/>
			{deleteTarget ? (
				<ConfirmDialog
					open
					onOpenChange={(open) => {
						if (!open) setDeleteTarget(null)
					}}
					title={`Удалить «${deleteTarget.name}»?`}
					description={`В категории ${roomCountByType.get(deleteTarget.id) ?? 0} ${pluralRu(roomCountByType.get(deleteTarget.id) ?? 0, 'номер', 'номера', 'номеров')}. Удаление невозможно отменить.`}
					confirmLabel="Удалить категорию"
					onConfirm={handleConfirmDelete}
					isPending={deleteRoomType.isPending}
				/>
			) : null}
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
