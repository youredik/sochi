/**
 * `<InventoryRoomsPage>` — admin surface for managing room categories
 * (RoomType) + individual rooms. Phase II + II.bis + II.bis.2.
 *
 * Layout per Bnovo / Mews canon (research 2026-05-14):
 *   - Header «Категории номеров» + «+ Категория» CTA.
 *   - Per-category row with details/summary <details> accordion:
 *     • header: name + «N номеров, до K гостей» + actions (Изменить /
 *       + Номера / Удалить)
 *     • body: list of individual rooms (number + floor + delete button)
 *   - Empty state «У вас нет категорий — создайте первую».
 *
 * Sheets force-remount via `key={target.id}` so TanStack Form picks up
 * fresh `defaultValues` on every open (gotcha caught 2026-05-14: useForm
 * captures defaults at first call; stale form prefill on reopen otherwise).
 *
 * `inventoryCount` field intentionally hidden from admin UX — это
 * planning-only value used by onboarding wizard's bulk-seed flow. Actual
 * room count is derived from `Room` records (см. `useRooms`).
 */
import { useQuery } from '@tanstack/react-query'
import type { Room, RoomType } from '@horeca/shared'
import { ChevronDown, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../../components/ui/button.tsx'
import { roomTypesQueryOptions, useDeleteRoomType } from '../hooks/use-room-types.ts'
import { roomsQueryOptions, useDeleteRoom } from '../hooks/use-rooms.ts'
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
	const deleteRoom = useDeleteRoom(propertyId)

	const [createOpen, setCreateOpen] = useState(false)
	const [editTarget, setEditTarget] = useState<RoomType | null>(null)
	const [deleteTarget, setDeleteTarget] = useState<RoomType | null>(null)
	const [bulkAddFor, setBulkAddFor] = useState<RoomType | null>(null)
	const [deleteRoomTarget, setDeleteRoomTarget] = useState<Room | null>(null)

	const roomsByType = new Map<string, Room[]>()
	for (const room of roomsQuery.data ?? []) {
		const list = roomsByType.get(room.roomTypeId) ?? []
		list.push(room)
		roomsByType.set(room.roomTypeId, list)
	}
	// Sort rooms by number ascending для stable display.
	for (const list of roomsByType.values()) {
		list.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
	}

	const isLoading = roomTypesQuery.isPending || roomsQuery.isPending
	const error = roomTypesQuery.error ?? roomsQuery.error
	const roomTypes = roomTypesQuery.data ?? []

	async function handleConfirmDeleteCategory() {
		if (!deleteTarget) return
		try {
			await deleteRoomType.mutateAsync({ id: deleteTarget.id })
			toast.success(`Категория «${deleteTarget.name}» удалена`)
			setDeleteTarget(null)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Не удалось удалить категорию')
		}
	}

	async function handleConfirmDeleteRoom() {
		if (!deleteRoomTarget) return
		try {
			await deleteRoom.mutateAsync({ id: deleteRoomTarget.id })
			toast.success(`Номер ${deleteRoomTarget.number} удалён`)
			setDeleteRoomTarget(null)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Не удалось удалить номер')
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
					{roomTypes.map((rt) => (
						<CategoryRow
							key={rt.id}
							rt={rt}
							rooms={roomsByType.get(rt.id) ?? []}
							onEdit={() => setEditTarget(rt)}
							onBulkAdd={() => setBulkAddFor(rt)}
							onDelete={() => setDeleteTarget(rt)}
							onDeleteRoom={(room) => setDeleteRoomTarget(room)}
						/>
					))}
				</ul>
			)}

			{createOpen ? (
				<CategoryFormSheet
					key="category-create"
					open
					onOpenChange={setCreateOpen}
					propertyId={propertyId}
				/>
			) : null}
			{editTarget ? (
				<CategoryFormSheet
					key={`category-edit-${editTarget.id}`}
					open
					onOpenChange={(open) => {
						if (!open) setEditTarget(null)
					}}
					propertyId={propertyId}
					existing={editTarget}
				/>
			) : null}
			{bulkAddFor ? (
				<RoomsBulkAddSheet
					key={`bulk-add-${bulkAddFor.id}`}
					open
					onOpenChange={(open) => {
						if (!open) setBulkAddFor(null)
					}}
					propertyId={propertyId}
					roomType={bulkAddFor}
				/>
			) : null}
			{deleteTarget ? (
				<ConfirmDialog
					open
					onOpenChange={(open) => {
						if (!open) setDeleteTarget(null)
					}}
					title={`Удалить «${deleteTarget.name}»?`}
					description={`В категории ${roomsByType.get(deleteTarget.id)?.length ?? 0} ${pluralRu(roomsByType.get(deleteTarget.id)?.length ?? 0, 'номер', 'номера', 'номеров')}. Удаление невозможно отменить.`}
					confirmLabel="Удалить категорию"
					onConfirm={handleConfirmDeleteCategory}
					isPending={deleteRoomType.isPending}
				/>
			) : null}
			{deleteRoomTarget ? (
				<ConfirmDialog
					open
					onOpenChange={(open) => {
						if (!open) setDeleteRoomTarget(null)
					}}
					title={`Удалить номер ${deleteRoomTarget.number}?`}
					description="Номер будет удалён вместе со всеми бронированиями по нему. Это действие невозможно отменить."
					confirmLabel="Удалить номер"
					onConfirm={handleConfirmDeleteRoom}
					isPending={deleteRoom.isPending}
				/>
			) : null}
		</div>
	)
}

/**
 * Single category row с controlled accordion-style expand. Avoids native
 * `<details>/<summary>` because action buttons inside `<summary>` trip
 * axe's `nested-interactive` rule (Radix Accordion uses same APG pattern
 * с separate trigger + content; here we DIY с button + panel + aria-controls
 * since we don't have shadcn Accordion extracted yet).
 */
interface CategoryRowProps {
	readonly rt: RoomType
	readonly rooms: ReadonlyArray<Room>
	readonly onEdit: () => void
	readonly onBulkAdd: () => void
	readonly onDelete: () => void
	readonly onDeleteRoom: (room: Room) => void
}

function CategoryRow({ rt, rooms, onEdit, onBulkAdd, onDelete, onDeleteRoom }: CategoryRowProps) {
	const panelId = useId()
	const [expanded, setExpanded] = useState(false)
	const roomCount = rooms.length

	return (
		<li className="rounded-lg border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					aria-controls={panelId}
					className="flex min-w-0 items-center gap-3 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
				>
					<ChevronDown
						className={`size-4 shrink-0 transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`}
						aria-hidden="true"
					/>
					<div>
						<p className="font-medium">{rt.name}</p>
						<p className="text-xs text-muted-foreground">
							{roomCount} {pluralRu(roomCount, 'номер', 'номера', 'номеров')} · до {rt.maxOccupancy}{' '}
							{pluralRu(rt.maxOccupancy, 'гостя', 'гостей', 'гостей')}
						</p>
					</div>
				</button>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={onEdit}
						aria-label={`Изменить категорию «${rt.name}»`}
					>
						<Pencil className="size-4" aria-hidden="true" />
						Изменить
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={onBulkAdd}
						aria-label={`Добавить номера в категорию «${rt.name}»`}
					>
						<Plus className="size-4" aria-hidden="true" />
						Номера
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={onDelete}
						aria-label={`Удалить категорию «${rt.name}»`}
						className="text-destructive hover:bg-destructive/10"
					>
						<Trash2 className="size-4" aria-hidden="true" />
					</Button>
				</div>
			</div>
			{expanded ? (
				<div id={panelId} className="border-t px-4 py-3">
					{rooms.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							В этой категории пока нет номеров. Нажми «+ Номера» чтобы добавить диапазон.
						</p>
					) : (
						<ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
							{rooms.map((room) => (
								<li
									key={room.id}
									className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-1.5 text-sm"
								>
									<div className="min-w-0">
										<span className="font-medium tabular-nums">{room.number}</span>
										{room.floor !== null ? (
											<span className="ml-2 text-xs text-muted-foreground">этаж {room.floor}</span>
										) : null}
									</div>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => onDeleteRoom(room)}
										aria-label={`Удалить номер ${room.number}`}
										className="text-destructive hover:bg-destructive/10"
									>
										<Trash2 className="size-3.5" aria-hidden="true" />
									</Button>
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</li>
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
