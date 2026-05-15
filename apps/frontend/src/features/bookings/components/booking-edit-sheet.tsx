import { useForm } from '@tanstack/react-form'
import { useId, useState } from 'react'
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
import { intRangeNumberValidator } from '../../../lib/forms/int-range-field-schema'
import { useRatePlans } from '../../bookings/hooks/use-booking-mutations'
import { TextField } from '../../forms/text-field'
import { TextareaField } from '../../forms/textarea-field'
import {
	useBooking,
	useCancelBooking,
	useChangeGuestsCountBooking,
	useChangeRatePlanBooking,
	useCheckInBooking,
	useCheckOutBooking,
	useMarkNoShowBooking,
	useMoveDatesBooking,
} from '../hooks/use-booking-transitions'
import {
	availableTransitions,
	type BookingTransition,
	isTerminal,
	labelForStatus,
	labelForTransition,
} from '../lib/booking-transitions'

const validateGuestsCount = intRangeNumberValidator({ min: 1, max: 20 })

type AmendMode = 'move-dates' | 'change-rate-plan' | 'change-guests-count'
type ExpandedMode = BookingTransition | AmendMode | null

/**
 * Click-on-band edit side-Sheet (M5e.2 + G3 + G3.bis 2026-05-15).
 *
 * **G3 architectural shift**: `<Dialog>` modal → `<ResponsiveSheet
 * side="right">` per Mews / Cloudbeds / Apaleo 2026 canon — side-panel
 * preserves grid context. Mobile auto-switches к bottom Drawer.
 *
 * **G3.bis (2026-05-15)**: file + component renamed `*-dialog` → `*-sheet`
 * к match inventory canon. Playwright `getByRole('dialog')` still works
 * (Sheet exposes the dialog role). Plan §G3 explicit rename completed.
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

interface BookingEditSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	bookingId: string
	propertyId: string | null
	windowFrom: string
	windowTo: string
}

export function BookingEditSheet(props: BookingEditSheetProps) {
	const bookingQ = useBooking(props.open ? props.bookingId : null)

	return (
		<ResponsiveSheet open={props.open} onOpenChange={props.onOpenChange}>
			<ResponsiveSheetContent side="right" className="sm:max-w-md overflow-y-auto">
				{bookingQ.isPending ? (
					<ResponsiveSheetHeader>
						<ResponsiveSheetTitle>Загрузка брони…</ResponsiveSheetTitle>
						<ResponsiveSheetDescription>
							Получаем актуальные данные с сервера.
						</ResponsiveSheetDescription>
					</ResponsiveSheetHeader>
				) : bookingQ.isError || !bookingQ.data ? (
					<>
						<ResponsiveSheetHeader>
							<ResponsiveSheetTitle>Не удалось загрузить бронь</ResponsiveSheetTitle>
							<ResponsiveSheetDescription>
								Проверьте соединение и закройте диалог — попробуйте ещё раз позже.
							</ResponsiveSheetDescription>
						</ResponsiveSheetHeader>
						<ResponsiveSheetFooter>
							<Button type="button" onClick={() => props.onOpenChange(false)}>
								Закрыть
							</Button>
						</ResponsiveSheetFooter>
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
			</ResponsiveSheetContent>
		</ResponsiveSheet>
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
			<ResponsiveSheetHeader>
				<ResponsiveSheetTitle>
					Бронь завершена: {labelForStatus(booking.status)}
				</ResponsiveSheetTitle>
				<ResponsiveSheetDescription>
					{booking.checkIn} — {booking.checkOut}
				</ResponsiveSheetDescription>
			</ResponsiveSheetHeader>

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

			<ResponsiveSheetFooter>
				<Button type="button" onClick={props.onClose}>
					Закрыть
				</Button>
			</ResponsiveSheetFooter>
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
		ratePlanId?: string
		guestsCount?: number
	}
	propertyId: string | null
	windowFrom: string
	windowTo: string
	onClose: () => void
}) {
	const { booking } = props
	const transitions = availableTransitions(booking.status)
	// G5 (2026-05-15): expanded state covers BOTH transition reason forms
	// (cancel/noShow) AND amend inline editors (move-dates/change-rate-plan/
	// change-guests-count). Single state machine — only ONE editor visible
	// at a time, «Назад» universal back-button.
	const [expanded, setExpanded] = useState<ExpandedMode>(null)
	const ratePlanSelectId = useId()

	const deps = {
		propertyId: props.propertyId,
		windowFrom: props.windowFrom,
		windowTo: props.windowTo,
		bookingId: booking.id,
		currentStatus: booking.status,
	}
	const amendDeps = {
		propertyId: props.propertyId,
		windowFrom: props.windowFrom,
		windowTo: props.windowTo,
		bookingId: booking.id,
	}
	const checkIn = useCheckInBooking(deps)
	const checkOut = useCheckOutBooking(deps)
	const cancel = useCancelBooking(deps)
	const noShow = useMarkNoShowBooking(deps)
	const moveDates = useMoveDatesBooking(amendDeps)
	const changeRatePlan = useChangeRatePlanBooking(amendDeps)
	const changeGuestsCount = useChangeGuestsCountBooking(amendDeps)

	// G5: rate plans fetched only когда change-rate-plan editor expanded —
	// avoids unnecessary network when operator opens edit sheet to just
	// check-in / cancel.
	const ratePlansQ = useRatePlans(
		expanded === 'change-rate-plan' ? props.propertyId : null,
		expanded === 'change-rate-plan' ? booking.roomTypeId : '',
	)

	const isPending =
		checkIn.isPending ||
		checkOut.isPending ||
		cancel.isPending ||
		noShow.isPending ||
		moveDates.isPending ||
		changeRatePlan.isPending ||
		changeGuestsCount.isPending

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

	// G5 amend forms — each pre-populates с current values, submits on Save.
	const moveDatesForm = useForm({
		defaultValues: { checkIn: booking.checkIn, checkOut: booking.checkOut },
		onSubmit: async ({ value }) => {
			await moveDates.mutateAsync({
				checkIn: value.checkIn,
				checkOut: value.checkOut,
			})
			props.onClose()
		},
	})

	const changeRatePlanForm = useForm({
		defaultValues: { ratePlanId: booking.ratePlanId ?? '' },
		onSubmit: async ({ value }) => {
			await changeRatePlan.mutateAsync({ ratePlanId: value.ratePlanId })
			props.onClose()
		},
	})

	const changeGuestsCountForm = useForm({
		defaultValues: { guestsCount: booking.guestsCount ?? 1 },
		onSubmit: async ({ value }) => {
			await changeGuestsCount.mutateAsync({ guestsCount: value.guestsCount })
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
			<ResponsiveSheetHeader>
				<ResponsiveSheetTitle>Бронь: {labelForStatus(booking.status)}</ResponsiveSheetTitle>
				<ResponsiveSheetDescription>
					{booking.checkIn} — {booking.checkOut}
				</ResponsiveSheetDescription>
			</ResponsiveSheetHeader>

			{expanded === 'cancel' ? (
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
							<ResponsiveSheetFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => setExpanded(null)}
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
							</ResponsiveSheetFooter>
						)}
					</cancelForm.Subscribe>
				</form>
			) : expanded === 'noShow' ? (
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
					<ResponsiveSheetFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setExpanded(null)}
							disabled={isPending}
						>
							Назад
						</Button>
						<Button type="submit" disabled={isPending}>
							{isPending ? 'Сохраняем…' : 'Отметить: не заехал'}
						</Button>
					</ResponsiveSheetFooter>
				</form>
			) : expanded === 'move-dates' ? (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void moveDatesForm.handleSubmit()
					}}
					className="space-y-3"
					noValidate
					data-slot="amend-move-dates-form"
				>
					<div className="grid grid-cols-2 gap-3">
						<moveDatesForm.Field name="checkIn">
							{(field) => <TextField field={field} label="Заезд" type="date" required autoFocus />}
						</moveDatesForm.Field>
						<moveDatesForm.Field name="checkOut">
							{(field) => <TextField field={field} label="Выезд" type="date" required />}
						</moveDatesForm.Field>
					</div>
					<moveDatesForm.Subscribe
						selector={(s) => ({ checkIn: s.values.checkIn, checkOut: s.values.checkOut })}
					>
						{({ checkIn: ci, checkOut: co }) => (
							<>
								{ci >= co ? (
									<p className="text-status-issue-foreground text-xs" role="alert">
										Выезд должен быть позже заезда
									</p>
								) : null}
								<ResponsiveSheetFooter>
									<Button
										type="button"
										variant="outline"
										onClick={() => setExpanded(null)}
										disabled={isPending}
									>
										Назад
									</Button>
									<Button type="submit" disabled={isPending || ci >= co}>
										{isPending ? 'Сохраняем…' : 'Сохранить новые даты'}
									</Button>
								</ResponsiveSheetFooter>
							</>
						)}
					</moveDatesForm.Subscribe>
				</form>
			) : expanded === 'change-rate-plan' ? (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void changeRatePlanForm.handleSubmit()
					}}
					className="space-y-3"
					noValidate
					data-slot="amend-change-rate-plan-form"
				>
					<changeRatePlanForm.Field name="ratePlanId">
						{(field) => {
							const activeRatePlans = (ratePlansQ.data ?? []).filter((p) => p.isActive)
							return (
								<div className="space-y-1.5">
									<Label htmlFor={ratePlanSelectId}>Новый тариф</Label>
									<Select
										value={field.state.value}
										onValueChange={(v) => field.handleChange(v)}
										disabled={activeRatePlans.length === 0}
									>
										<SelectTrigger id={ratePlanSelectId} aria-label="Новый тариф">
											<SelectValue
												placeholder={ratePlansQ.isPending ? 'Загружаем тарифы…' : 'Выберите тариф'}
											/>
										</SelectTrigger>
										<SelectContent>
											{activeRatePlans.map((p) => (
												<SelectItem key={p.id} value={p.id}>
													{p.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)
						}}
					</changeRatePlanForm.Field>
					<changeRatePlanForm.Subscribe selector={(s) => s.values.ratePlanId}>
						{(ratePlanId) => (
							<ResponsiveSheetFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => setExpanded(null)}
									disabled={isPending}
								>
									Назад
								</Button>
								<Button
									type="submit"
									disabled={
										isPending || ratePlanId === '' || ratePlanId === (booking.ratePlanId ?? '')
									}
								>
									{isPending ? 'Сохраняем…' : 'Применить тариф'}
								</Button>
							</ResponsiveSheetFooter>
						)}
					</changeRatePlanForm.Subscribe>
				</form>
			) : expanded === 'change-guests-count' ? (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void changeGuestsCountForm.handleSubmit()
					}}
					className="space-y-3"
					noValidate
					data-slot="amend-change-guests-count-form"
				>
					<changeGuestsCountForm.Field
						name="guestsCount"
						validators={{ onChange: ({ value }) => validateGuestsCount(value) }}
					>
						{(field) => (
							<TextField
								field={field}
								label="Гостей"
								type="number"
								min={1}
								max={20}
								step={1}
								required
								autoFocus
							/>
						)}
					</changeGuestsCountForm.Field>
					<changeGuestsCountForm.Subscribe
						selector={(s) => ({
							guestsCount: s.values.guestsCount,
							isValid: s.isFieldsValid,
						})}
					>
						{({ guestsCount, isValid }) => (
							<ResponsiveSheetFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => setExpanded(null)}
									disabled={isPending}
								>
									Назад
								</Button>
								<Button
									type="submit"
									disabled={isPending || !isValid || guestsCount === (booking.guestsCount ?? -1)}
								>
									{isPending ? 'Сохраняем…' : 'Сохранить'}
								</Button>
							</ResponsiveSheetFooter>
						)}
					</changeGuestsCountForm.Subscribe>
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
										setExpanded(t)
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
					{/* G5 Apaleo Amend-Stay (2026-05-15) — pre-arrival edits.
					    move-dates / change-rate-plan: confirmed-only.
					    change-guests-count: confirmed OR in_house (walk-up canon). */}
					{booking.status === 'confirmed' || booking.status === 'in_house' ? (
						<div className="border-border mt-2 space-y-2 border-t pt-3" data-slot="amend-actions">
							<p className="text-muted-foreground text-xs">Изменить бронь:</p>
							{booking.status === 'confirmed' ? (
								<>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={isPending}
										onClick={() => setExpanded('move-dates')}
										data-amend="move-dates"
										className="w-full"
									>
										Перенести даты
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={isPending}
										onClick={() => setExpanded('change-rate-plan')}
										data-amend="change-rate-plan"
										className="w-full"
									>
										Сменить тариф
									</Button>
								</>
							) : null}
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={isPending}
								onClick={() => setExpanded('change-guests-count')}
								data-amend="change-guests-count"
								className="w-full"
							>
								Изменить число гостей
							</Button>
						</div>
					) : null}
					<ResponsiveSheetFooter>
						<Button type="button" variant="outline" onClick={props.onClose} disabled={isPending}>
							Закрыть
						</Button>
					</ResponsiveSheetFooter>
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
