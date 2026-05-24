import { useForm } from '@tanstack/react-form'
import { useId, useState } from 'react'
import type { BookingGuestSnapshot } from '@horeca/shared'
import { isRussianCitizenship } from '@horeca/shared'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import {
	useRatePlans,
	useRoomsByRoomType,
	useRoomTypes,
} from '../../bookings/hooks/use-booking-mutations'
import { useCompliance } from '../../content-wizard/hooks/use-compliance'
import { TextField } from '../../forms/text-field'
import { TextareaField } from '../../forms/textarea-field'
import type { OperatorIdentity } from '../../passport-scan/components/consent-152fz-modal'
import {
	PassportScanDialog,
	type PassportScanResult,
} from '../../passport-scan/components/passport-scan-dialog'
import { useActiveGuestDocument } from '../../passport-scan/hooks/use-active-guest-document'
import { useSaveDocumentFromScan } from '../../passport-scan/hooks/use-save-document-from-scan'
import { useActiveOrg } from '../../tenancy/hooks/use-active-org'
import {
	useAssignRoom,
	useBooking,
	useCancelBooking,
	useChangeGuestsCountBooking,
	useChangeRatePlanBooking,
	useChangeRoomTypeBooking,
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

type AmendMode =
	| 'move-dates'
	| 'change-rate-plan'
	| 'change-guests-count'
	| 'change-room-type'
	| 'assign-room'
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
		assignedRoomId?: string | null
		// 2026-05-24 — Required for passport-scan section + foreign-citizenship
		// Заезд hard-gate per canonical May 2026 PMS UX (Stayntouch / Mews /
		// Cloudbeds: disable CTA until scan complete для non-RU per ПП-1912).
		// Both optional in upstream BookingShape для backward compat с G8
		// unassigned list rendering, but ActionView без них = degraded UX.
		primaryGuestId?: string
		guestSnapshot?: BookingGuestSnapshot
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
	const changeRoomType = useChangeRoomTypeBooking(amendDeps)
	const assignRoom = useAssignRoom(amendDeps)

	// G5: rate plans fetched only когда change-rate-plan editor expanded —
	// avoids unnecessary network when operator opens edit sheet to just
	// check-in / cancel.
	const ratePlansQ = useRatePlans(
		expanded === 'change-rate-plan' ? props.propertyId : null,
		expanded === 'change-rate-plan' ? booking.roomTypeId : '',
	)

	// G7: roomTypes fetched only когда change-room-type editor expanded.
	const roomTypesQ = useRoomTypes(expanded === 'change-room-type' ? props.propertyId : null)
	const roomTypeSelectId = useId()
	// G8 (2026-05-16) — rooms fetched only когда assign-room editor expanded.
	// Filtered к booking.roomTypeId (server query param).
	const roomsQ = useRoomsByRoomType(
		expanded === 'assign-room' ? props.propertyId : null,
		expanded === 'assign-room' ? booking.roomTypeId : null,
	)
	const roomSelectId = useId()

	const isPending =
		checkIn.isPending ||
		checkOut.isPending ||
		cancel.isPending ||
		noShow.isPending ||
		moveDates.isPending ||
		changeRatePlan.isPending ||
		changeGuestsCount.isPending ||
		changeRoomType.isPending ||
		assignRoom.isPending

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

	// G7 — change-room-type amend form. Pre-populates с current roomTypeId
	// so submit-disabled когда operator не выбрал новую категорию.
	const changeRoomTypeForm = useForm({
		defaultValues: { roomTypeId: booking.roomTypeId },
		onSubmit: async ({ value }) => {
			await changeRoomType.mutateAsync({ roomTypeId: value.roomTypeId })
			props.onClose()
		},
	})

	// G8 — assign-room amend form. Pre-populates с current assignedRoomId (or
	// empty for unassigned). Submit disabled когда same OR empty.
	const assignRoomForm = useForm({
		defaultValues: { roomId: booking.assignedRoomId ?? '' },
		onSubmit: async ({ value }) => {
			await assignRoom.mutateAsync({ roomId: value.roomId })
			props.onClose()
		},
	})

	// 2026-05-24 — Pre-check-in passport-scan UX (canonical May 2026 PMS per
	// Stayntouch / Mews / Cloudbeds research): inline section above transitions,
	// hard-gate Заезд CTA для foreign citizens без active document.
	// Per 109-ФЗ ст. 22 ч. 3 + ПП РФ № 9 от 15.01.2007 — уведомление в МВД ОВМ
	// в течение 1 рабочего дня после прибытия; штраф ст. 18.9 КоАП 400-500k ₽.
	// Server-side mirror (booking.service.checkIn → PassportScanRequiredError
	// HTTP 428) prevents direct API bypass; UI gate = primary UX defence.
	//
	// `useActiveGuestDocument` hits `GET /guests/:id/documents/active` —
	// masked-tail response per 152-ФЗ ст.18 minimization; RTBF-revoked rows
	// excluded server-side (entitiesAnonymizedAt + photoConsentLog.revokedAt
	// dual filter).
	const activeDocQ = useActiveGuestDocument(booking.primaryGuestId ?? null)
	// Sprint C+ Round 7 Senior P0 fix: alpha-2 ('RU') AND alpha-3 ('RUS') case-
	// insensitive — shared `isRussianCitizenship` canonical detector. Previously
	// hardcoded `toUpperCase() !== 'RU'` mis-classified 'RUS' as foreign.
	const isForeign =
		booking.guestSnapshot?.citizenship != null &&
		!isRussianCitizenship(booking.guestSnapshot.citizenship)
	// Sprint C+ Round 7 Senior P0 fix: **fail-closed** during loading.
	// Previously optimistic-allow → operator с fast click можно проскочить
	// gate за ~150ms latency window → 109-ФЗ violation risk. Now: loading
	// state == still-blocked for foreign citizens, banner shows «Проверяем».
	// Server-side mirror в booking.service catches edge case.
	const checkInBlockedByMissingScan =
		isForeign && (activeDocQ.isPending || activeDocQ.data === null)

	const [scanOpen, setScanOpen] = useState(false)
	const [lastScan, setLastScan] = useState<PassportScanResult | null>(null)
	const [scanPersistError, setScanPersistError] = useState<string | null>(null)
	const saveFromScan = useSaveDocumentFromScan()
	const { active: activeOrg } = useActiveOrg()
	const compliance = useCompliance()
	const operatorIdentity: OperatorIdentity | undefined =
		activeOrg && typeof activeOrg.name === 'string' && activeOrg.name.length > 0
			? {
					legalName: activeOrg.name,
					legalAddress: compliance.data?.legalAddress ?? null,
					dpoEmail: compliance.data?.dpoEmail ?? null,
				}
			: undefined

	// Sprint C+ Round 7 a11y P0 fix: `title=` attribute is NOT canonical
	// screen-reader announcement for disabled buttons (NVDA/VoiceOver behave
	// inconsistently). Use `aria-describedby` + visually-hidden text node so
	// blind operators hear blocked-reason on focus. useId() generates stable id.
	const blockedReasonId = useId()

	const handleCheckIn = async () => {
		// Defence in depth: if somehow click bypassed disabled state (assistive
		// tech, keyboard race), refuse pre-mutation. UX surfaces alert inline,
		// no toast leak — operator stays в context.
		if (checkInBlockedByMissingScan) {
			setScanPersistError(
				'Скан паспорта обязателен для иностранных граждан до заезда (109-ФЗ ст. 22 ч. 3 + ПП РФ № 9).',
			)
			return
		}
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
			) : expanded === 'change-room-type' ? (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void changeRoomTypeForm.handleSubmit()
					}}
					className="space-y-3"
					noValidate
					data-slot="amend-change-room-type-form"
				>
					<changeRoomTypeForm.Field name="roomTypeId">
						{(field) => {
							const allRoomTypes = roomTypesQ.data ?? []
							return (
								<div className="space-y-1.5">
									<Label htmlFor={roomTypeSelectId}>Новая категория</Label>
									<Select
										value={field.state.value}
										onValueChange={(v) => field.handleChange(v)}
										disabled={allRoomTypes.length === 0}
									>
										<SelectTrigger id={roomTypeSelectId} aria-label="Новая категория">
											<SelectValue
												placeholder={
													roomTypesQ.isPending ? 'Загружаем категории…' : 'Выберите категорию'
												}
											/>
										</SelectTrigger>
										<SelectContent>
											{allRoomTypes.map((r) => (
												<SelectItem key={r.id} value={r.id}>
													{r.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)
						}}
					</changeRoomTypeForm.Field>
					<changeRoomTypeForm.Subscribe selector={(s) => s.values.roomTypeId}>
						{(roomTypeId) => (
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
									disabled={isPending || roomTypeId === '' || roomTypeId === booking.roomTypeId}
								>
									{isPending ? 'Перемещаем…' : 'Переместить'}
								</Button>
							</ResponsiveSheetFooter>
						)}
					</changeRoomTypeForm.Subscribe>
				</form>
			) : expanded === 'assign-room' ? (
				<form
					onSubmit={(e) => {
						e.preventDefault()
						void assignRoomForm.handleSubmit()
					}}
					className="space-y-3"
					noValidate
					data-slot="amend-assign-room-form"
				>
					<assignRoomForm.Field name="roomId">
						{(field) => {
							const allRooms = roomsQ.data ?? []
							return (
								<div className="space-y-1.5">
									<Label htmlFor={roomSelectId}>Назначить номер</Label>
									<Select
										value={field.state.value}
										onValueChange={(v) => field.handleChange(v)}
										disabled={allRooms.length === 0}
									>
										<SelectTrigger id={roomSelectId} aria-label="Назначить номер">
											<SelectValue
												placeholder={
													roomsQ.isPending
														? 'Загружаем номера…'
														: allRooms.length === 0
															? 'Нет доступных номеров'
															: 'Выберите номер'
												}
											/>
										</SelectTrigger>
										<SelectContent>
											{allRooms.map((r) => (
												<SelectItem key={r.id} value={r.id}>
													№ {r.number}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)
						}}
					</assignRoomForm.Field>
					<assignRoomForm.Subscribe selector={(s) => s.values.roomId}>
						{(roomId) => (
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
									disabled={isPending || roomId === '' || roomId === (booking.assignedRoomId ?? '')}
								>
									{isPending ? 'Назначаем…' : 'Назначить'}
								</Button>
							</ResponsiveSheetFooter>
						)}
					</assignRoomForm.Subscribe>
				</form>
			) : (
				<>
					{/* 2026-05-24 — Passport-scan section, canonical May 2026 PMS UX.
					    Visible ONLY для status='confirmed' (pre-check-in window per
					    109-ФЗ ст. 22 + ПП РФ № 9: scan must precede МВД-учёт CDC
					    enqueue). После in_house — Re-scan через migration-registration
					    detail sheet (existing surface). */}
					{booking.status === 'confirmed' && booking.primaryGuestId ? (
						<PassportScanSection
							guestSnapshot={booking.guestSnapshot}
							activeDoc={activeDocQ.data ?? null}
							isLoading={activeDocQ.isPending}
							isForeign={isForeign}
							isPending={isPending}
							lastScan={lastScan}
							scanPersistError={scanPersistError}
							onScanClick={() => {
								setScanPersistError(null)
								setScanOpen(true)
							}}
						/>
					) : null}
					<p className="text-muted-foreground text-sm">Выберите действие:</p>
					{/* a11y P0: visually-hidden blocked-reason text для NVDA/VoiceOver.
					    `aria-describedby` на disabled button announces причину при
					    focus; sighted operators получают same info через PassportScan
					    Section red Alert + button-disabled visual state. */}
					{checkInBlockedByMissingScan ? (
						<p id={blockedReasonId} className="sr-only">
							Скан документа обязателен для иностранных граждан до заезда (109-ФЗ ст. 22 ч. 3 + ПП
							РФ № 9 от 15.01.2007). Нажмите «Сканировать паспорт» в секции выше.
						</p>
					) : null}
					<div className="flex flex-col gap-2" data-slot="transition-actions">
						{transitions.map((t) => {
							const isCheckIn = t === 'checkIn'
							const disabled = isPending || (isCheckIn && checkInBlockedByMissingScan)
							return (
								<Button
									key={t}
									type="button"
									variant={t === 'cancel' ? 'destructive' : 'default'}
									disabled={disabled}
									aria-disabled={disabled}
									aria-describedby={
										isCheckIn && checkInBlockedByMissingScan ? blockedReasonId : undefined
									}
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
									data-blocked-by-scan={
										isCheckIn && checkInBlockedByMissingScan ? 'true' : undefined
									}
								>
									{labelForTransition(t)}
								</Button>
							)
						})}
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
									{/* G7 (2026-05-16) pointer-alternative для drag-move
									    gesture per WCAG 2.2 SC 2.5.7 (mandatory AA).
									    Also serves keyboard + mobile users (operator
									    focus band → Enter → этот dialog). */}
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={isPending}
										onClick={() => setExpanded('change-room-type')}
										data-amend="change-room-type"
										className="w-full"
									>
										Переместить в категорию
									</Button>
									{/* G8 (2026-05-16) «Назначить номер» — WCAG 2.5.7
									    pointer-alternative для UnassignedPanel + grid-
									    drag-target в G8.bis. Label-flip: «Назначить» если
									    null, «Переназначить» если уже pinned. */}
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={isPending}
										onClick={() => setExpanded('assign-room')}
										data-amend="assign-room"
										className="w-full"
									>
										{booking.assignedRoomId ? 'Переназначить номер' : 'Назначить номер'}
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
			{/* 2026-05-24 — PassportScanDialog mounted unconditionally so its open
			    state is preserved across expanded-mode toggles. Guard wiring inside
			    onSave: primaryGuestId can be undefined per BookingShape optionality. */}
			{booking.primaryGuestId ? (
				<PassportScanDialog
					open={scanOpen}
					onClose={() => setScanOpen(false)}
					onSave={(result) => {
						setLastScan(result)
						setScanOpen(false)
						setScanPersistError(null)
						// Sprint C+ Senior P0-1 fix: persist guestDocument linked к
						// photoConsentLogId. Without this, RTBF cascade has no rows to
						// scrub. Mirrors RescanSection in migration-registration-detail-sheet.
						if (result.photoConsentLogId === null) {
							setScanPersistError(
								'Backend не вернул photoConsentLogId — сохранение документа невозможно. Повторите сканирование.',
							)
							return
						}
						const primaryGuestId = booking.primaryGuestId
						if (!primaryGuestId) return
						saveFromScan.mutate(
							{
								guestId: primaryGuestId,
								identityMethod: result.identityMethod,
								entities: result.entities,
								photoConsentLogId: result.photoConsentLogId,
								ocrConfidenceHeuristic: result.confidenceHeuristic,
								objectStoragePath: null,
								objectMimeType: null,
								objectSizeBytes: null,
							},
							{
								onSuccess: () => {
									// Re-fetch active document so hard-gate unblocks Заезд CTA
									// без необходимости close+reopen booking dialog.
									void activeDocQ.refetch()
								},
								onError: (err) =>
									setScanPersistError(err instanceof Error ? err.message : String(err)),
							},
						)
					}}
					guestAlreadyConsentedToVersion={null}
					guestId={booking.primaryGuestId}
					{...(operatorIdentity ? { operatorIdentity } : {})}
				/>
			) : null}
		</>
	)
}

/**
 * 2026-05-24 — Passport-scan inline section в booking-edit-sheet ActionView.
 *
 * Canonical May 2026 PMS UX per web research (Stayntouch / Mews / Cloudbeds /
 * TravelLine): scan trigger INLINE с check-in CTA, NOT separate step. Foreign
 * citizenship → hard-gate Заезд (disabled CTA + aria-describedby), avoiding
 * modal-after-click (junior pattern). Section visible только для
 * status='confirmed'.
 *
 * **Legal citations (Round 7 corrected)**: 109-ФЗ ст. 22 ч. 3 (миграционный
 * учёт иностранных граждан) + ПП РФ № 9 от 15.01.2007 — 1 рабочий день на
 * подачу уведомления в МВД ОВМ. ПП-1912 = КСР-реестр (другой контекст,
 * compliance-step + privacy.tsx).
 *
 * **152-ФЗ ст. 18 minimization**: just-scanned Alert masks lastName + first-
 * initial + doc-number-tail-4. NEVER renders full PII в DOM (defence-in-depth
 * против screenshare / DOM-scraper / error-monitoring).
 *
 * Visual states (progressive disclosure):
 *   1. loading + foreign: «Проверяем скан…» (fail-closed Заезд disabled)
 *   2. foreign-no-scan: red Alert «109-ФЗ scan обязателен» + primary CTA
 *   3. foreign-with-scan: green Alert «Паспорт отсканирован: …LAST4» + Rescan
 *   4. ru-no-scan: muted Alert «Скан опционален» (RU-other-region disclaimer)
 *   5. ru-with-scan: same green Alert as foreign-with-scan
 *   6. just-scanned (session): «OCR данные сохранены» — fully masked PII
 *   7. persist-error: destructive Alert с message
 */
export function PassportScanSection(props: {
	guestSnapshot: BookingGuestSnapshot | undefined
	activeDoc:
		| import('../../passport-scan/hooks/use-active-guest-document').ActiveGuestDocument
		| null
	isLoading: boolean
	isForeign: boolean
	isPending: boolean
	lastScan: PassportScanResult | null
	scanPersistError: string | null
	onScanClick: () => void
}) {
	const headingId = useId()
	const { guestSnapshot, activeDoc, isLoading, isForeign, isPending, lastScan, scanPersistError } =
		props
	const guestLabel = guestSnapshot
		? `${guestSnapshot.lastName} ${guestSnapshot.firstName.slice(0, 1)}.`
		: 'Гость'
	const hasActive = activeDoc !== null
	const ctaLabel = hasActive ? 'Пересканировать паспорт' : 'Сканировать паспорт'

	return (
		<section
			className="border-border space-y-2 border-b pb-3"
			data-slot="passport-scan-section"
			aria-labelledby={headingId}
		>
			<h3 id={headingId} className="text-sm font-medium">
				Документ гостя
			</h3>
			{isLoading && isForeign ? (
				<Alert data-state="loading-foreign" role="status" aria-live="polite">
					<AlertTitle>Проверяем наличие скана</AlertTitle>
					<AlertDescription className="text-xs">
						Заезд иностранного гостя заблокирован до подтверждения скана документа.
					</AlertDescription>
				</Alert>
			) : isLoading ? (
				<p className="text-muted-foreground text-xs" aria-live="polite">
					Проверяем наличие скана документа…
				</p>
			) : isForeign && !hasActive ? (
				<Alert variant="destructive" data-state="foreign-no-scan">
					<AlertTitle>Скан документа обязателен</AlertTitle>
					<AlertDescription>
						Иностранный гость ({guestSnapshot?.citizenship ?? '—'}) — уведомление о прибытии в МВД
						ОВМ должно быть подано в течение 1 рабочего дня (109-ФЗ ст. 22 ч. 3 + ПП РФ № 9 от
						15.01.2007). Заезд заблокирован до сканирования. Штраф ст. 18.9 КоАП: 400-500 тыс. ₽.
					</AlertDescription>
				</Alert>
			) : hasActive ? (
				<Alert data-state="has-active-scan" role="status" aria-live="polite">
					<AlertTitle>Документ отсканирован</AlertTitle>
					<AlertDescription className="text-xs">
						{guestLabel} • {labelForIdentityMethod(activeDoc.identityMethod)} • №…
						{activeDoc.documentNumberMaskedTail} • {activeDoc.citizenshipIso3.toUpperCase()}
					</AlertDescription>
				</Alert>
			) : (
				<Alert data-state="ru-no-scan">
					<AlertTitle>Скан документа</AlertTitle>
					<AlertDescription className="text-xs">
						Опционально для гражданина РФ из того же региона. Если гость прибыл из другого региона
						РФ — требуется регистрация по месту пребывания (109-ФЗ ст. 19, ПП РФ № 9), в течение 24
						часов после заезда.
					</AlertDescription>
				</Alert>
			)}
			{lastScan ? (
				<Alert data-state="just-scanned" role="status" aria-live="polite">
					<AlertTitle>OCR-данные сохранены</AlertTitle>
					<AlertDescription className="text-xs space-y-1">
						{/* 152-ФЗ ст.18 minimization: mask lastName + first-initial +
						    doc-tail-4 ONLY. Never render full PII (Sprint C+ Round 7
						    Senior P0 fix — was leaking full surname/name/middleName/
						    documentNumber). DOM-persistence risk через screenshare /
						    error-monitoring / a11y-snapshot. */}
						<div>
							{maskScanResult(lastScan)} • Уверенность:{' '}
							{(lastScan.confidenceHeuristic * 100).toFixed(0)}%
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			{scanPersistError !== null ? (
				<Alert variant="destructive" data-state="persist-error" role="alert">
					<AlertTitle>Документ не сохранён</AlertTitle>
					<AlertDescription className="text-xs">{scanPersistError}</AlertDescription>
				</Alert>
			) : null}
			<Button
				type="button"
				variant={isForeign && !hasActive ? 'default' : 'outline'}
				size="sm"
				disabled={isPending}
				onClick={props.onScanClick}
				data-slot="open-scan-dialog"
				className="w-full"
			>
				{ctaLabel}
			</Button>
		</section>
	)
}

function labelForIdentityMethod(
	m: 'passport_paper' | 'passport_zagran' | 'driver_license',
): string {
	if (m === 'passport_paper') return 'Паспорт РФ'
	if (m === 'passport_zagran') return 'Загранпаспорт'
	return 'Водительское удостоверение'
}

/**
 * 152-ФЗ ст. 18 minimization helper для just-scanned Alert.
 *
 * Renders: «{surnameInitial}. {firstInitial}. • №…{docTail4}» — без middleName,
 * birthDate, birthPlace. Operator уже видит full guestSnapshot в booking
 * details, scan-confirmation Alert служит только для подтверждения «OCR
 * succeeded», NOT для re-display PII.
 */
function maskScanResult(scan: PassportScanResult): string {
	const surnameInit = scan.entities.surname?.charAt(0).toUpperCase() ?? '?'
	const firstInit = scan.entities.name?.charAt(0).toUpperCase() ?? '?'
	const docRaw = (scan.entities.documentNumber ?? '').replace(/\s+/g, '')
	const docTail = docRaw.length >= 4 ? docRaw.slice(-4) : docRaw
	return `${surnameInit}. ${firstInit}. • №…${docTail}`
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
