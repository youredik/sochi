import { useForm } from '@tanstack/react-form'
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { TextField } from '../../forms/text-field'
import { useCreateBooking, useCreateGuest, useRatePlans } from '../hooks/use-booking-mutations'
import {
	type BookingCreateDialogInput,
	defaultCheckOut,
	generateIdempotencyKey,
	nightsCount,
} from '../lib/booking-create'

/**
 * Click-to-create booking dialog (M5e.1).
 *
 * Entry: user clicks an empty cell in the reservation grid; Chessboard
 * opens this with pre-filled roomTypeId + checkIn. Dialog picks the
 * default rate plan for that roomType automatically (first one, which
 * per the wizard is the seeded BAR plan) — server 422s on missing
 * plan, so this is always populated for a properly-onboarded tenant.
 *
 * Flow: guest create (POST /guests) → booking create (POST /bookings
 * with `Idempotency-Key`). Sequencing is deliberate — a failed guest-
 * create short-circuits before we commit the idempotency key. The key
 * is generated once per dialog mount so a user re-submitting after a
 * network hiccup replays the same operation (Stripe-style).
 *
 * Out of scope (later phases):
 *   - Editing existing guests (click on band → M5e.2)
 *   - Foreign-guest fields (visa, migration card) — registrationStatus
 *     auto-flags `pending`, HK workflow collects details later
 *   - Multiple companions — only primary guest for now
 */

interface BookingCreateDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	propertyId: string | null
	roomTypeId: string
	roomTypeName: string
	checkIn: string
	windowFrom: string
	windowTo: string
}

export function BookingCreateDialog(props: BookingCreateDialogProps) {
	// Stable idempotency key per dialog mount — useMemo, NOT useRef, because
	// useMemo's [] dep guarantees identity lives for the whole mount while
	// still being testable. Reset happens when the dialog remounts (Dialog
	// defaults unmount on close via Radix Portal).
	const idempotencyKey = useMemo(() => generateIdempotencyKey(), [])

	const ratePlansQ = useRatePlans(props.propertyId, props.roomTypeId)
	const createGuest = useCreateGuest()
	const createBooking = useCreateBooking(props.propertyId, props.windowFrom, props.windowTo)

	// First active rate plan for this roomType. Null while query loads or if
	// the tenant somehow has zero plans for this roomType — submit button is
	// disabled in that case (guard below).
	const defaultRatePlan = useMemo(() => {
		const plans = ratePlansQ.data ?? []
		return plans.find((p) => p.isDefault && p.isActive) ?? plans.find((p) => p.isActive) ?? null
	}, [ratePlansQ.data])

	const form = useForm({
		defaultValues: {
			firstName: '',
			lastName: '',
			middleName: '',
			documentType: 'Паспорт РФ',
			documentNumber: '',
			citizenship: 'RU',
			guestsCount: 1,
			checkIn: props.checkIn,
			checkOut: defaultCheckOut(props.checkIn),
		},
		onSubmit: async ({ value }) => {
			if (!defaultRatePlan) return
			// 1. Create guest
			const guest = await createGuest.mutateAsync({
				firstName: value.firstName,
				lastName: value.lastName,
				middleName: value.middleName,
				citizenship: value.citizenship,
				documentType: value.documentType,
				documentNumber: value.documentNumber,
			})
			// 2. Create booking (optimistic band appears immediately)
			const input: BookingCreateDialogInput = {
				roomTypeId: props.roomTypeId,
				ratePlanId: defaultRatePlan.id,
				checkIn: value.checkIn,
				checkOut: value.checkOut,
				guestsCount: value.guestsCount,
				primaryGuestId: guest.id,
				primaryGuest: {
					firstName: guest.firstName,
					lastName: guest.lastName,
					middleName: guest.middleName,
					citizenship: guest.citizenship,
					documentType: guest.documentType,
					documentNumber: guest.documentNumber,
				},
				channelCode: 'walkIn',
			}
			await createBooking.mutateAsync({ input, idempotencyKey })
			props.onOpenChange(false)
		},
	})

	const isPending = createGuest.isPending || createBooking.isPending

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Новое бронирование</DialogTitle>
					<DialogDescription>
						{props.roomTypeName} · заезд {props.checkIn}
					</DialogDescription>
				</DialogHeader>

				<form
					onSubmit={(e) => {
						e.preventDefault()
						void form.handleSubmit()
					}}
					className="space-y-4"
					noValidate
				>
					<div className="grid grid-cols-2 gap-3">
						<form.Field name="lastName">
							{(field) => <TextField field={field} label="Фамилия" autoFocus required />}
						</form.Field>
						<form.Field name="firstName">
							{(field) => <TextField field={field} label="Имя" required />}
						</form.Field>
					</div>

					<form.Field name="middleName">
						{(field) => <TextField field={field} label="Отчество (опционально)" />}
					</form.Field>

					<div className="grid grid-cols-2 gap-3">
						<form.Field name="documentType">
							{(field) => <TextField field={field} label="Документ" required />}
						</form.Field>
						<form.Field name="documentNumber">
							{(field) => <TextField field={field} label="Номер документа" required />}
						</form.Field>
					</div>

					<form.Field name="citizenship">
						{(field) => (
							<TextField
								field={field}
								label="Гражданство (ISO)"
								description="RU, BY, KZ, USA… Не-RU триггерит МВД-регистрацию."
								pattern="^[A-Z]{2,3}$"
								maxLength={3}
								required
							/>
						)}
					</form.Field>

					<div className="grid grid-cols-3 gap-3">
						<form.Field name="checkIn">
							{(field) => <TextField field={field} label="Заезд" type="date" required />}
						</form.Field>
						<form.Field name="checkOut">
							{(field) => <TextField field={field} label="Выезд" type="date" required />}
						</form.Field>
						<form.Field name="guestsCount">
							{(field) => (
								<TextField
									field={field}
									label="Гостей"
									type="number"
									min={1}
									max={20}
									step={1}
									required
								/>
							)}
						</form.Field>
					</div>

					<form.Subscribe selector={(s) => [s.values.checkIn, s.values.checkOut] as const}>
						{([ci, co]) => {
							const nights = safeNightsCount(ci, co)
							return (
								<>
									<p className="text-muted-foreground text-sm">
										{nights > 0
											? `${nights} ${pluralNights(nights)}`
											: 'Выезд должен быть позже заезда'}
										{defaultRatePlan ? ` · тариф ${defaultRatePlan.name}` : ' · тариф загружается…'}
									</p>

									<DialogFooter>
										<Button
											type="button"
											variant="outline"
											onClick={() => props.onOpenChange(false)}
											disabled={isPending}
										>
											Отмена
										</Button>
										<Button type="submit" disabled={isPending || !defaultRatePlan || nights < 1}>
											{isPending ? 'Создаём…' : 'Создать бронирование'}
										</Button>
									</DialogFooter>
								</>
							)
						}}
					</form.Subscribe>
				</form>
			</DialogContent>
		</Dialog>
	)
}

function safeNightsCount(ci: string, co: string): number {
	try {
		return nightsCount(ci, co)
	} catch {
		return 0
	}
}

function pluralNights(n: number): string {
	// Russian plural: ночь / ночи / ночей (1 / 2-4 / 5+, with teens exception)
	const mod10 = n % 10
	const mod100 = n % 100
	if (mod10 === 1 && mod100 !== 11) return 'ночь'
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'ночи'
	return 'ночей'
}
