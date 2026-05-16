import { useForm } from '@tanstack/react-form'
import { useEffect, useId, useState } from 'react'
import type { PropertyBlockReason } from '@horeca/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
	ResponsiveSheet,
	ResponsiveSheetContent,
	ResponsiveSheetDescription,
	ResponsiveSheetFooter,
	ResponsiveSheetHeader,
	ResponsiveSheetTitle,
} from '@/components/ui/responsive-sheet'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useRoomTypes, useRoomsByRoomType } from '../../bookings/hooks/use-booking-mutations'
import { TextField } from '../../forms/text-field'
import { propertyBlockReasonLabels, useCreatePropertyBlocks } from '../hooks/use-property-blocks'
import { addDays, todayIso } from '../lib/date-range'

/**
 * G9 (2026-05-16) — operator UX для creating OOO/maintenance blocks.
 *
 * R1+R2 ≥ 2026-05-16 research-agent decisions:
 *   - Modal-driven create (Bnovo/TravelLine canon — NOT drag, deferred)
 *   - Multi-room select (Mews-style — pending feature request, we lead)
 *   - Reason enum 4 RU labels + optional 200-char comment (PII-guarded)
 *   - Past dates allowed at create (admins recording retroactively)
 *   - On block-over-booking 409 → toast hints operator must move booking
 *
 * Sheet structure (Mews canon, side-panel preserves grid context):
 *   1. Room-type pick (filter rooms list)
 *   2. Room(s) multi-select via simple checkboxes (small property scale)
 *   3. Date range
 *   4. Reason enum
 *   5. Optional comment (PII-guard hint shown above field)
 */

interface PropertyBlockCreateSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	propertyId: string | null
	initialRoomTypeId?: string
	initialStartDate?: string
}

export function PropertyBlockCreateSheet(props: PropertyBlockCreateSheetProps) {
	const create = useCreatePropertyBlocks(props.propertyId)
	const roomTypeFieldId = useId()
	const reasonFieldId = useId()
	const [selectedRoomTypeId, setSelectedRoomTypeId] = useState<string>(
		props.initialRoomTypeId ?? '',
	)
	const [selectedRoomIds, setSelectedRoomIds] = useState<Set<string>>(new Set())

	// Reset transient state when sheet closes — Base UI Drawer / shadcn Sheet
	// don't unmount on close by default, so без этого operator опыт «дёрнутый»
	// (3 rooms picked → cancel → re-open shows still-3-picked). Caught via
	// `[[adversarial-reading-before-done]]` 9-item «reset semantics».
	useEffect(() => {
		if (!props.open) {
			setSelectedRoomTypeId(props.initialRoomTypeId ?? '')
			setSelectedRoomIds(new Set())
		}
	}, [props.open, props.initialRoomTypeId])

	const roomTypesQ = useRoomTypes(props.propertyId)
	const roomsQ = useRoomsByRoomType(props.propertyId, selectedRoomTypeId || null)

	const defaultStartDate = props.initialStartDate ?? todayIso()
	const defaultEndDate = addDays(defaultStartDate, 1)

	const form = useForm({
		defaultValues: {
			startDate: defaultStartDate,
			endDate: defaultEndDate,
			reason: 'repair' as PropertyBlockReason,
			comment: '',
		},
		onSubmit: async ({ value }) => {
			if (selectedRoomIds.size === 0) return
			if (!value.startDate || !value.endDate) return
			if (value.startDate >= value.endDate) return
			await create.mutateAsync({
				roomIds: Array.from(selectedRoomIds),
				startDate: value.startDate,
				endDate: value.endDate,
				reason: value.reason,
				comment: value.comment.trim() ? value.comment.trim() : null,
			})
			// On error toast surfaces canonical RU message; on success — close sheet.
			if (!create.isError) {
				setSelectedRoomIds(new Set())
				props.onOpenChange(false)
			}
		},
	})

	function toggleRoom(roomId: string) {
		setSelectedRoomIds((prev) => {
			const next = new Set(prev)
			if (next.has(roomId)) next.delete(roomId)
			else next.add(roomId)
			return next
		})
	}

	const isSubmitDisabled = create.isPending || selectedRoomIds.size === 0 || !selectedRoomTypeId

	return (
		<ResponsiveSheet open={props.open} onOpenChange={props.onOpenChange}>
			<ResponsiveSheetContent
				side="right"
				className="sm:max-w-lg overflow-y-auto"
				data-slot="property-block-create-sheet"
			>
				<ResponsiveSheetHeader>
					<ResponsiveSheetTitle>Заблокировать номер</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>
						Ремонт, генеральная уборка, личное пользование — номер становится недоступным для
						бронирования.
					</ResponsiveSheetDescription>
				</ResponsiveSheetHeader>

				<form
					onSubmit={(e) => {
						e.preventDefault()
						void form.handleSubmit()
					}}
					className="space-y-4 px-4 pb-4"
					noValidate
				>
					{/* Room type picker */}
					<div className="space-y-1.5">
						<Label htmlFor={roomTypeFieldId}>Тип номера</Label>
						<Select
							value={selectedRoomTypeId}
							onValueChange={(v) => {
								setSelectedRoomTypeId(v)
								setSelectedRoomIds(new Set())
							}}
						>
							<SelectTrigger id={roomTypeFieldId} aria-label="Тип номера">
								<SelectValue placeholder="Выберите тип номера" />
							</SelectTrigger>
							<SelectContent>
								{(roomTypesQ.data ?? []).map((rt) => (
									<SelectItem key={rt.id} value={rt.id}>
										{rt.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Rooms multi-select */}
					{selectedRoomTypeId ? (
						<fieldset
							className="space-y-2 rounded-md border border-border p-3"
							data-slot="property-block-rooms-fieldset"
						>
							<legend className="text-sm font-medium px-1">Номера</legend>
							{roomsQ.isPending ? (
								<p className="text-muted-foreground text-sm">Загружаем номера…</p>
							) : (roomsQ.data ?? []).length === 0 ? (
								<p className="text-muted-foreground text-sm">
									Нет активных номеров в этой категории.
								</p>
							) : (
								<div className="grid grid-cols-2 gap-2">
									{(roomsQ.data ?? []).map((r) => {
										const checked = selectedRoomIds.has(r.id)
										return (
											<label
												key={r.id}
												className="flex items-center gap-2 text-sm cursor-pointer"
												data-slot="property-block-room-checkbox"
											>
												<input
													type="checkbox"
													checked={checked}
													onChange={() => toggleRoom(r.id)}
													data-room-id={r.id}
												/>
												<span>№ {r.number}</span>
											</label>
										)
									})}
								</div>
							)}
							<p
								className="text-muted-foreground text-xs mt-1"
								data-slot="property-block-rooms-count"
							>
								Выбрано: {selectedRoomIds.size}
							</p>
						</fieldset>
					) : null}

					{/* Date range */}
					<div className="grid grid-cols-2 gap-3">
						<form.Field name="startDate">
							{(field) => <TextField field={field} label="С даты" type="date" required />}
						</form.Field>
						<form.Field name="endDate">
							{(field) => <TextField field={field} label="По дату" type="date" required />}
						</form.Field>
					</div>

					{/* Reason */}
					<form.Field name="reason">
						{(field) => (
							<div className="space-y-1.5">
								<Label htmlFor={reasonFieldId}>Причина</Label>
								<Select
									value={field.state.value}
									onValueChange={(v) => field.handleChange(v as PropertyBlockReason)}
								>
									<SelectTrigger id={reasonFieldId} aria-label="Причина">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{(Object.keys(propertyBlockReasonLabels) as PropertyBlockReason[]).map((k) => (
											<SelectItem key={k} value={k}>
												{propertyBlockReasonLabels[k]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}
					</form.Field>

					{/* Comment с PII guard hint */}
					<form.Field name="comment">
						{(field) => (
							<div className="space-y-1.5">
								<TextField
									field={field}
									label="Комментарий (опционально)"
									description="Не указывайте ФИО, телефон или e-mail гостя — для этого создайте бронирование."
									maxLength={200}
								/>
							</div>
						)}
					</form.Field>

					<ResponsiveSheetFooter className="mt-2 px-0">
						<Button
							type="button"
							variant="outline"
							onClick={() => props.onOpenChange(false)}
							disabled={create.isPending}
						>
							Отмена
						</Button>
						<Button type="submit" disabled={isSubmitDisabled} data-slot="property-block-submit">
							{create.isPending ? 'Создаём…' : `Заблокировать (${selectedRoomIds.size})`}
						</Button>
					</ResponsiveSheetFooter>
				</form>
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}
