import { useForm } from '@tanstack/react-form'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { TextareaField } from '../../forms/textarea-field'
import {
	useBooking,
	useCancelBooking,
	useCheckInBooking,
	useCheckOutBooking,
	useMarkNoShowBooking,
} from '../hooks/use-booking-transitions'
import {
	availableTransitions,
	type BookingTransition,
	isTerminal,
	labelForStatus,
	labelForTransition,
} from '../lib/booking-transitions'

/**
 * Click-on-band edit dialog (M5e.2).
 *
 * Two branches, decided by `isTerminal(booking.status)`:
 *
 *   1. Terminal (cancelled / checked_out / no_show) — READ-ONLY view.
 *      Shows current status + transition timestamp + reason (if any).
 *      No action buttons. Close is the only affordance. Prevents user
 *      from trying any transition the server would 409.
 *
 *   2. Non-terminal (confirmed / in_house) — ACTION view.
 *      Renders one button per available transition (enum-guard from
 *      state machine). Cancel + no-show expand an inline reason form.
 *      Other actions execute immediately.
 *
 * Data flow:
 *   - useBooking(id) fetches the full Booking row (audit timestamps,
 *     cancel reason) that the narrow grid GridBooking doesn't carry.
 *   - 4 transition hooks do optimistic updates on the grid + single-
 *     booking cache; rollback on 409; invalidate on settled.
 */

interface BookingEditDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	bookingId: string
	propertyId: string | null
	windowFrom: string
	windowTo: string
}

export function BookingEditDialog(props: BookingEditDialogProps) {
	const bookingQ = useBooking(props.open ? props.bookingId : null)

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto">
				{bookingQ.isPending ? (
					<DialogHeader>
						<DialogTitle>Загрузка брони…</DialogTitle>
						<DialogDescription>Получаем актуальные данные с сервера.</DialogDescription>
					</DialogHeader>
				) : bookingQ.isError || !bookingQ.data ? (
					<>
						<DialogHeader>
							<DialogTitle>Не удалось загрузить бронь</DialogTitle>
							<DialogDescription>
								Проверьте соединение и закройте диалог — попробуйте ещё раз позже.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button type="button" onClick={() => props.onOpenChange(false)}>
								Закрыть
							</Button>
						</DialogFooter>
					</>
				) : isTerminal(bookingQ.data.status) ? (
					<TerminalView booking={bookingQ.data} onClose={() => props.onOpenChange(false)} />
				) : (
					<ActionView
						booking={bookingQ.data}
						propertyId={props.propertyId}
						windowFrom={props.windowFrom}
						windowTo={props.windowTo}
						onClose={() => props.onOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	)
}

// ---------- Terminal (read-only) branch ----------

function TerminalView(props: {
	booking: {
		id: string
		status: 'cancelled' | 'checked_out' | 'no_show' | 'confirmed' | 'in_house'
		checkIn: string
		checkOut: string
		cancelReason?: string | null
		cancelledAt?: string | null
		checkedOutAt?: string | null
		noShowAt?: string | null
	}
	onClose: () => void
}) {
	const { booking } = props
	const transitionAt =
		booking.status === 'cancelled'
			? booking.cancelledAt
			: booking.status === 'checked_out'
				? booking.checkedOutAt
				: booking.status === 'no_show'
					? booking.noShowAt
					: null

	return (
		<>
			<DialogHeader>
				<DialogTitle>Бронь завершена: {labelForStatus(booking.status)}</DialogTitle>
				<DialogDescription>
					{booking.checkIn} — {booking.checkOut}
				</DialogDescription>
			</DialogHeader>

			<dl className="space-y-2 text-sm" data-slot="terminal-details">
				{transitionAt ? (
					<div className="flex gap-2">
						<dt className="text-muted-foreground min-w-24">Дата перехода</dt>
						<dd>{formatTransitionDate(transitionAt)}</dd>
					</div>
				) : null}
				{booking.cancelReason ? (
					<div className="flex gap-2">
						<dt className="text-muted-foreground min-w-24">Причина</dt>
						<dd>{booking.cancelReason}</dd>
					</div>
				) : null}
			</dl>

			<DialogFooter>
				<Button type="button" onClick={props.onClose}>
					Закрыть
				</Button>
			</DialogFooter>
		</>
	)
}

// ---------- Non-terminal (action) branch ----------

function ActionView(props: {
	booking: {
		id: string
		roomTypeId: string
		status: 'confirmed' | 'in_house' | 'cancelled' | 'checked_out' | 'no_show'
		checkIn: string
		checkOut: string
	}
	propertyId: string | null
	windowFrom: string
	windowTo: string
	onClose: () => void
}) {
	const { booking } = props
	const transitions = availableTransitions(booking.status)
	const [reasonExpanded, setReasonExpanded] = useState<BookingTransition | null>(null)

	const deps = {
		propertyId: props.propertyId,
		windowFrom: props.windowFrom,
		windowTo: props.windowTo,
		bookingId: booking.id,
		currentStatus: booking.status,
	}
	const checkIn = useCheckInBooking(deps)
	const checkOut = useCheckOutBooking(deps)
	const cancel = useCancelBooking(deps)
	const noShow = useMarkNoShowBooking(deps)

	const isPending = checkIn.isPending || checkOut.isPending || cancel.isPending || noShow.isPending

	const cancelForm = useForm({
		defaultValues: { reason: '' },
		onSubmit: async ({ value }) => {
			await cancel.mutateAsync({ reason: value.reason })
			props.onClose()
		},
	})

	const noShowForm = useForm({
		defaultValues: { reason: '' },
		onSubmit: async ({ value }) => {
			await noShow.mutateAsync({ reason: value.reason })
			props.onClose()
		},
	})

	const handleCheckIn = async () => {
		await checkIn.mutateAsync()
		props.onClose()
	}
	const handleCheckOut = async () => {
		await checkOut.mutateAsync()
		props.onClose()
	}

	return (
		<>
			<DialogHeader>
				<DialogTitle>Бронь: {labelForStatus(booking.status)}</DialogTitle>
				<DialogDescription>
					{booking.checkIn} — {booking.checkOut}
				</DialogDescription>
			</DialogHeader>

			{reasonExpanded === 'cancel' ? (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void cancelForm.handleSubmit()
					}}
					className="space-y-3"
					noValidate
				>
					<cancelForm.Field
						name="reason"
						validators={{
							onChange: ({ value }) =>
								value.trim().length === 0 ? 'Укажите причину отмены' : undefined,
						}}
					>
						{(field) => (
							<TextareaField
								field={field}
								label="Причина отмены"
								description="1..500 символов. Видно только сотрудникам."
								maxLength={500}
								autoFocus
								required
							/>
						)}
					</cancelForm.Field>
					<cancelForm.Subscribe selector={(s) => s.values.reason}>
						{(reason) => (
							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => setReasonExpanded(null)}
									disabled={isPending}
								>
									Назад
								</Button>
								<Button
									type="submit"
									variant="destructive"
									disabled={isPending || reason.trim().length === 0}
								>
									{isPending ? 'Отменяем…' : 'Подтвердить отмену'}
								</Button>
							</DialogFooter>
						)}
					</cancelForm.Subscribe>
				</form>
			) : reasonExpanded === 'noShow' ? (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void noShowForm.handleSubmit()
					}}
					className="space-y-3"
					noValidate
				>
					<noShowForm.Field name="reason">
						{(field) => (
							<TextareaField
								field={field}
								label="Комментарий (опционально)"
								description="Не обязательно. Полезно для аудита."
								maxLength={500}
								autoFocus
							/>
						)}
					</noShowForm.Field>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setReasonExpanded(null)}
							disabled={isPending}
						>
							Назад
						</Button>
						<Button type="submit" disabled={isPending}>
							{isPending ? 'Сохраняем…' : 'Отметить: не заехал'}
						</Button>
					</DialogFooter>
				</form>
			) : (
				<>
					<p className="text-muted-foreground text-sm">Выберите действие:</p>
					<div className="flex flex-col gap-2" data-slot="transition-actions">
						{transitions.map((t) => (
							<Button
								key={t}
								type="button"
								variant={t === 'cancel' ? 'destructive' : 'default'}
								disabled={isPending}
								onClick={() => {
									if (t === 'cancel' || t === 'noShow') {
										setReasonExpanded(t)
									} else if (t === 'checkIn') {
										void handleCheckIn()
									} else if (t === 'checkOut') {
										void handleCheckOut()
									}
								}}
								data-transition={t}
							>
								{labelForTransition(t)}
							</Button>
						))}
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={props.onClose} disabled={isPending}>
							Закрыть
						</Button>
					</DialogFooter>
				</>
			)}
		</>
	)
}

function formatTransitionDate(iso: string): string {
	// Backend returns ISO 8601 UTC; format to local Russian readable.
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return iso
	return d.toLocaleString('ru-RU', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	})
}
