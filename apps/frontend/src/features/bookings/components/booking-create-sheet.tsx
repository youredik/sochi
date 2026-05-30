import { useForm, useStore } from '@tanstack/react-form'
import { useQuery } from '@tanstack/react-query'
import { type ChangeEvent, useEffect, useId, useMemo, useRef } from 'react'
import { toast } from 'sonner'
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
import { BookingOverlapBanner } from './booking-overlap-banner'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { ratesRangeQueryOptions } from '../../inventory/hooks/use-rates'
import { addDays } from '../../chessboard/lib/date-range'
import { TextField } from '../../forms/text-field'
import { intRangeNumberValidator } from '../../../lib/forms/int-range-field-schema'
import { useCreateBooking, useCreateGuest, useRatePlans } from '../hooks/use-booking-mutations'
import {
	type BookingCreateSheetInput,
	buildScanAutofillPatch,
	buildScanReviewHints,
	scanResultToast,
	defaultCheckOut,
	generateIdempotencyKey,
	nightsCount,
	pickDefaultRatePlan,
	pluralNights,
} from '../lib/booking-create'
import { CitizenshipSelect } from '../../passport-scan/components/citizenship-select'
import { useScanPassportPreview } from '../../passport-scan/hooks/use-scan-passport-preview'
import { fileToBase64, transcodeToJpegForVision } from '../../passport-scan/lib/transcode-image'

// Server-side bound mirror: `bookingCreateInput.guestsCount` is
// `z.coerce.number().int().min(1).max(20)` per `packages/shared/src/booking.ts`.
const validateGuestsCount = intRangeNumberValidator({ min: 1, max: 20 })

/**
 * Канонический набор типов документа (Select вместо free-text — убирает МВД-value
 * chaos). Первые три совпадают с OCR identityMethod-маппингом (OCR_DOCUMENT_TYPE
 * в booking-create.ts) — скан автозаполняет именно их.
 */
const DOCUMENT_TYPE_OPTIONS = [
	'Паспорт РФ',
	'Загранпаспорт',
	'Водительское удостоверение',
	'Вид на жительство',
	'Иностранный паспорт',
] as const

/**
 * Click-to-create booking side-Sheet (M5e.1 + G3 + G3.bis 2026-05-15).
 *
 * **G3 architectural shift (2026-05-15)**: was `<Dialog>` modal, now
 * `<ResponsiveSheet side="right">` per Mews / Cloudbeds / Apaleo 2026
 * canon — side-panel preserves grid context (operator sees band layout
 * while filling form). Mobile auto-switches к bottom Drawer per
 * `[[hostaway-mobile-canon]]` thumb-reach.
 *
 * **G3.bis (2026-05-15)**: file + component renamed `*-dialog` → `*-sheet`
 * к match inventory canon (`category-form-sheet`, `rooms-bulk-add-sheet`).
 * Plan §G3 explicit rename completed (was halfmeasure-deferred). Playwright
 * `getByRole('dialog')` still works — Sheet exposes the dialog role.
 *
 * **Field order**: per Mews canon (2026) — dates first → room-type (read-
 * only via title context) → rate-plan → guest → payment (placeholder
 * для G5 Apaleo Amend-Stay). Reasoning: rate plans depend on dates, so
 * dates must be set before plan selection makes sense.
 *
 * Entry: user clicks an empty cell in the reservation grid; Chessboard
 * opens this with pre-filled roomTypeId + checkIn. Sheet picks the
 * default rate plan for that roomType automatically (per the wizard is
 * the seeded BAR plan) — server 422s on missing plan, so this is
 * always populated for a properly-onboarded tenant.
 *
 * Flow: guest create (POST /guests) → booking create (POST /bookings
 * with `Idempotency-Key`). Sequencing is deliberate — a failed guest-
 * create short-circuits before we commit the idempotency key. The key
 * is generated once per sheet mount so a user re-submitting after a
 * network hiccup replays the same operation (Stripe-style).
 *
 * Out of scope (later phases):
 *   - Editing existing guests (click on band → M5e.2 / G5)
 *   - Foreign-guest fields (visa, migration card) — registrationStatus
 *     auto-flags `pending`, HK workflow collects details later
 *   - Multiple companions — only primary guest for now
 */

interface BookingCreateSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	propertyId: string | null
	roomTypeId: string
	roomTypeName: string
	checkIn: string
	windowFrom: string
	windowTo: string
}

export function BookingCreateSheet(props: BookingCreateSheetProps) {
	// Stable idempotency key per dialog mount — useMemo, NOT useRef, because
	// useMemo's [] dep guarantees identity lives for the whole mount while
	// still being testable. Reset happens when the dialog remounts (Dialog
	// defaults unmount on close via Radix Portal).
	const idempotencyKey = useMemo(() => generateIdempotencyKey(), [])
	const ratePlanFieldId = useId()
	const documentTypeFieldId = useId()

	const ratePlansQ = useRatePlans(props.propertyId, props.roomTypeId)
	const createGuest = useCreateGuest()
	const createBooking = useCreateBooking(props.propertyId, props.windowFrom, props.windowTo)

	// G-B3 fix (real-bug-hunt 2026-05-15): previously rate plan auto-picked
	// FIRST active silently — operator с 3 tariffs (BAR/Невозвратный/Завтрак)
	// could не choose. Now picker is explicit; default = first active.
	const activeRatePlans = useMemo(
		() => (ratePlansQ.data ?? []).filter((p) => p.isActive),
		[ratePlansQ.data],
	)
	const defaultRatePlan = useMemo(
		() => pickDefaultRatePlan(ratePlansQ.data ?? []),
		[ratePlansQ.data],
	)

	const form = useForm({
		defaultValues: {
			firstName: '',
			lastName: '',
			middleName: '',
			documentType: 'Паспорт РФ',
			documentNumber: '',
			citizenship: 'rus',
			guestsCount: 1,
			checkIn: props.checkIn,
			checkOut: defaultCheckOut(props.checkIn),
			ratePlanId: '',
		},
		onSubmit: async ({ value }) => {
			if (!value.ratePlanId) return
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
			const input: BookingCreateSheetInput = {
				roomTypeId: props.roomTypeId,
				ratePlanId: value.ratePlanId,
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

	// Auto-seed ratePlanId с default-active plan when query lands. User can
	// still override via Select — only fires once (when form value still empty).
	// Per `[[tanstack-form-derived-state-canon]]` — read form state via store
	// в effect deps, NOT `form.state.values` direct.
	const currentRatePlanId = useStore(form.store, (s) => s.values.ratePlanId)
	useEffect(() => {
		if (!currentRatePlanId && defaultRatePlan) {
			form.setFieldValue('ratePlanId', defaultRatePlan.id)
		}
	}, [currentRatePlanId, defaultRatePlan, form])

	const isPending = createGuest.isPending || createBooking.isPending

	// 2026-05-29 — Скан-first автозаполнение (ИИ). Оператор фотографирует паспорт →
	// Yandex Vision OCR → поля подставляются. Это TRANSIENT preview (backend ничего
	// не хранит, 152-ФЗ ст.6); полное согласие ст.11 + photo storage + guestDocument
	// собираются на ЗАЕЗДЕ через PassportScanDialog. Закрывает «дважды вводить данные».
	const scanPreview = useScanPassportPreview()
	const fileInputRef = useRef<HTMLInputElement>(null)

	async function handleScanFile(e: ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0]
		// Сброс value — повторный выбор того же файла снова триггерит change.
		e.target.value = ''
		if (!file) return
		try {
			// HEIC→JPEG транскод + resize ≤2048px + EXIF strip (transcode-image canon).
			const { file: jpeg } = await transcodeToJpegForVision(file)
			const imageBase64 = await fileToBase64(jpeg)
			const result = await scanPreview.mutateAsync({
				imageBase64,
				mimeType: 'image/jpeg',
				identityMethod: 'passport_paper',
			})
			if (result.outcome === 'api_error') {
				toast.error('Не удалось распознать паспорт. Заполните поля вручную.')
				return
			}
			const patch = buildScanAutofillPatch(result.entities, 'passport_paper')
			if (Object.keys(patch).length === 0) {
				toast.error('Не удалось извлечь данные из фото. Заполните поля вручную.')
				return
			}
			// Подставляем только распознанные поля (null от Vision → не трогаем ввод).
			if (patch.firstName !== undefined) form.setFieldValue('firstName', patch.firstName)
			if (patch.lastName !== undefined) form.setFieldValue('lastName', patch.lastName)
			if (patch.middleName !== undefined) form.setFieldValue('middleName', patch.middleName)
			if (patch.citizenship !== undefined) form.setFieldValue('citizenship', patch.citizenship)
			if (patch.documentType !== undefined) form.setFieldValue('documentType', patch.documentType)
			if (patch.documentNumber !== undefined)
				form.setFieldValue('documentNumber', patch.documentNumber)
			// Field-level review guidance (2026 HITL) — pure scanResultToast: текст по
			// outcome + перечень незаполненных полей. Логика вынесена + покрыта тестом.
			const t = scanResultToast(result.outcome, buildScanReviewHints(result.entities))
			if (t.kind === 'warning') toast.warning(t.message)
			else toast.success(t.message)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Не удалось распознать паспорт')
		}
	}

	return (
		<ResponsiveSheet open={props.open} onOpenChange={props.onOpenChange}>
			<ResponsiveSheetContent side="right" className="sm:max-w-lg overflow-y-auto">
				<ResponsiveSheetHeader>
					<ResponsiveSheetTitle>Новое бронирование</ResponsiveSheetTitle>
					<ResponsiveSheetDescription>
						{props.roomTypeName} · заезд {props.checkIn}
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
					{/* G3 Mews/Cloudbeds canon: dates first → rate-plan → guest. */}
					<div className="grid grid-cols-3 gap-3">
						<form.Field name="checkIn">
							{(field) => <TextField field={field} label="Заезд" type="date" required autoFocus />}
						</form.Field>
						<form.Field name="checkOut">
							{(field) => <TextField field={field} label="Выезд" type="date" required />}
						</form.Field>
						{/* G-B2 fix (real-bug-hunt 2026-05-15): previously HTML5-only
						   min/max → server 400 on 0/21/etc. intRangeNumberValidator
						   mirrors `guestsCountSchema.min(1).max(20)` server bound. */}
						<form.Field
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
								/>
							)}
						</form.Field>
					</div>

					{/* G-B3 fix (real-bug-hunt 2026-05-15): rate plan picker — was
					   silent auto-pick of first active. Default seeded from
					   pickDefaultRatePlan via useEffect; operator can override. */}
					<form.Field name="ratePlanId">
						{(field) => (
							<div className="space-y-1.5">
								<Label htmlFor={ratePlanFieldId}>Тариф</Label>
								<Select
									value={field.state.value}
									onValueChange={(v) => field.handleChange(v)}
									disabled={activeRatePlans.length === 0}
								>
									<SelectTrigger id={ratePlanFieldId} aria-label="Тариф">
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
						)}
					</form.Field>

					{/* 2026-05-29 — Скан-first (ИИ). Фото паспорта → Vision OCR →
					   автозаполнение ФИО/гражданства/документа. Закрывает «человек делает
					   работу ИИ»: оператор не печатает данные вручную, правит при нужде. */}
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						className="sr-only"
						onChange={handleScanFile}
						aria-hidden="true"
						tabIndex={-1}
						data-testid="passport-scan-input"
					/>
					<div className="space-y-1.5">
						<Button
							type="button"
							variant="secondary"
							className="w-full"
							onClick={() => fileInputRef.current?.click()}
							disabled={isPending || scanPreview.isPending}
						>
							{scanPreview.isPending ? 'Распознаём паспорт…' : 'Сканировать паспорт (ИИ)'}
						</Button>
						<p className="text-muted-foreground text-xs">
							Сфотографируйте паспорт — ИИ заполнит ФИО, гражданство и документ. Поля можно
							отредактировать.
						</p>
					</div>

					{/* G3 guest section — moved BELOW dates/rate per Mews canon
					   (dates+rate establish booking shape ДО guest data entry). */}
					<div className="grid grid-cols-2 gap-3">
						<form.Field name="lastName">
							{(field) => <TextField field={field} label="Фамилия" required />}
						</form.Field>
						<form.Field name="firstName">
							{(field) => <TextField field={field} label="Имя" required />}
						</form.Field>
					</div>

					<form.Field name="middleName">
						{(field) => <TextField field={field} label="Отчество (опционально)" />}
					</form.Field>

					{/* 2026-05-29 — документ ОПЦИОНАЛЕН при создании брони. По домену он
					    нужен только на заезде (для иностранцев — hard-gate). Реальные
					    данные собираются сканом (кнопка «Сканировать паспорт» выше) или на заезде.
					    Пустой номер → отложенный sentinel (buildGuestCreateBody). Это
					    совпадает с OTA/виджет-потоками, где документа при брони тоже нет. */}
					<div className="grid grid-cols-2 gap-3">
						<form.Field name="documentType">
							{(field) => (
								<div className="space-y-1.5">
									<Label htmlFor={documentTypeFieldId}>Документ (опционально)</Label>
									<Select value={field.state.value} onValueChange={(v) => field.handleChange(v)}>
										<SelectTrigger id={documentTypeFieldId} aria-label="Тип документа">
											<SelectValue placeholder="Выберите тип" />
										</SelectTrigger>
										<SelectContent>
											{DOCUMENT_TYPE_OPTIONS.map((t) => (
												<SelectItem key={t} value={t}>
													{t}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}
						</form.Field>
						<form.Field name="documentNumber">
							{(field) => (
								<TextField
									field={field}
									label="Номер документа (опционально)"
									description="Можно не заполнять — подставит скан паспорта (кнопка выше) или заезд."
								/>
							)}
						</form.Field>
					</div>

					<form.Field name="citizenship">
						{(field) => (
							<CitizenshipSelect
								value={field.state.value}
								onChange={(v) => field.handleChange(v)}
								label="Гражданство"
							/>
						)}
					</form.Field>

					<form.Subscribe
						selector={(s) => [s.values.checkIn, s.values.checkOut, s.values.ratePlanId] as const}
					>
						{([ci, co, planId]) => {
							const nights = safeNightsCount(ci, co)
							return (
								<>
									{/* G9 (2026-05-16) — live overlap banner. role=status,
									    aria-live=polite. NOT-disabled submit per Bnovo RU
									    flex canon — operator may force-book (server returns
									    409 if hard conflict). */}
									<BookingOverlapBanner
										propertyId={props.propertyId}
										roomTypeId={props.roomTypeId}
										checkIn={ci}
										checkOut={co}
									/>

									<BookingPricePreview
										propertyId={props.propertyId}
										ratePlanId={planId}
										checkIn={ci}
										checkOut={co}
										nights={nights}
										ratePlanName={activeRatePlans.find((p) => p.id === planId)?.name ?? null}
									/>

									<ResponsiveSheetFooter className="mt-2 px-0">
										<Button
											type="button"
											variant="outline"
											onClick={() => props.onOpenChange(false)}
											disabled={isPending}
										>
											Отмена
										</Button>
										<Button type="submit" disabled={isPending || !planId || nights < 1}>
											{isPending ? 'Создаём…' : 'Создать бронирование'}
										</Button>
									</ResponsiveSheetFooter>
								</>
							)
						}}
					</form.Subscribe>
				</form>
			</ResponsiveSheetContent>
		</ResponsiveSheet>
	)
}

function safeNightsCount(ci: string, co: string): number {
	try {
		return nightsCount(ci, co)
	} catch {
		return 0
	}
}

/**
 * G-B4 fix (real-bug-hunt 2026-05-15): live price preview via rate-grid query.
 *
 * Source-of-truth: `rate` table (per-date amount per ratePlan, seeded by
 * onboarding wizard 90-day window). Sum amounts для [checkIn..checkOut-1]
 * (exclusive checkout — last night is checkOut-1). Server `Rate.amount` is
 * a decimal string («5000.50»); `Number()` coerces safely up to ≤6 fractional
 * digits per `packages/shared/src/rate.ts` `amountSchema`.
 *
 * Edge cases:
 *   • ratePlanId empty / dates invalid → render nights-only line
 *   • Query loading → render «считаем…»
 *   • Some dates missing rate rows → partial total, hint operator
 *   • Query error → render nights-only с warn (don't block submit)
 */
function BookingPricePreview(props: {
	propertyId: string | null
	ratePlanId: string
	checkIn: string
	checkOut: string
	nights: number
	ratePlanName: string | null
}) {
	const { ratePlanId, checkIn, checkOut, nights, ratePlanName } = props
	const lastNight = useMemo(() => {
		if (!checkIn || !checkOut || nights < 1) return null
		try {
			return addDays(checkOut, -1)
		} catch {
			return null
		}
	}, [checkOut, checkIn, nights])
	const enabled = Boolean(ratePlanId && checkIn && lastNight)
	const ratesQ = useQuery({
		...ratesRangeQueryOptions(ratePlanId, checkIn, lastNight ?? checkIn),
		enabled,
	})

	if (nights < 1) {
		return (
			<p className="text-muted-foreground text-sm" data-slot="price-preview">
				Выезд должен быть позже заезда
			</p>
		)
	}

	const nightsLabel = `${nights} ${pluralNights(nights)}`
	const planLabel = ratePlanName ? ` · тариф ${ratePlanName}` : ' · тариф не выбран'

	if (!enabled) {
		return (
			<p className="text-muted-foreground text-sm" data-slot="price-preview">
				{nightsLabel}
				{planLabel}
			</p>
		)
	}

	if (ratesQ.isPending) {
		return (
			<p className="text-muted-foreground text-sm" data-slot="price-preview">
				{nightsLabel}
				{planLabel} · считаем стоимость…
			</p>
		)
	}

	const rates = ratesQ.data ?? []
	const total = rates.reduce((sum, r) => sum + Number(r.amount), 0)
	const ratesFound = rates.length
	const missing = nights - ratesFound

	if (ratesQ.isError || ratesFound === 0) {
		return (
			<p className="text-muted-foreground text-sm" data-slot="price-preview">
				{nightsLabel}
				{planLabel} · стоимость рассчитается при создании
			</p>
		)
	}

	const formattedTotal = new Intl.NumberFormat('ru-RU', {
		style: 'currency',
		currency: 'RUB',
		maximumFractionDigits: 0,
	}).format(total)
	const partialHint = missing > 0 ? ` (для ${missing} дн. цена не задана — будет 0₽)` : ''

	return (
		<div className="space-y-1 text-sm" data-slot="price-preview">
			<p className="text-muted-foreground">
				{nightsLabel}
				{planLabel}
			</p>
			<p className="font-medium" data-slot="price-preview-total">
				Итого: {formattedTotal}
				{partialHint ? <span className="text-amber-700 text-xs"> {partialHint}</span> : null}
			</p>
		</div>
	)
}
