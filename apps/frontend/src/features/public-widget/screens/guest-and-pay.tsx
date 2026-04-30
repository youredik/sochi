/**
 * `<GuestAndPay>` — Screen 3 of public booking widget (M9.widget.4 / A2.2).
 *
 * Orchestrates: GuestForm + ConsentBlock + PaymentMethodSelector + StickySummary
 * + Submit. Pure component — receives resolved booking context (room/rate/cart)
 * via props; route wrapper resolves URL search params + queries.
 *
 * Submit pipeline (canonical interface — works для Stub demo + live ЮKassa):
 *   1. Guest form validates (TanStack Form + Zod 4 Standard Schema)
 *   2. Consent flags collected (152-ФЗ mandatory, 38-ФЗ optional)
 *   3. Payment method captured
 *   4. POST /api/public/widget/{slug}/booking via useCreateBooking mutation
 *   5. Result branches:
 *      - paymentStatus='succeeded' (Stub) → success state с bookingId + email hint
 *      - paymentStatus='pending' + confirmationToken → live ЮKassa Widget v1 init
 *        (Track C2 future; placeholder сейчас)
 *      - error → typed reason mapped к user-facing copy
 *
 * Idempotency-Key generated per-mount via `useMemo` — retries reuse same key,
 * fresh page load = fresh key. Backend dedup на (tenantId, idempotencyKey).
 */

import type {
	WidgetBookingCommitResult,
	WidgetGuestInput,
	WidgetPaymentMethod,
} from '@horeca/shared'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConsentBlock } from '../components/consent-block.tsx'
import { GuestForm } from '../components/guest-form.tsx'
import { PaymentMethodSelector } from '../components/payment-method-selector.tsx'
import { type AddonLineItem, StickySummary } from '../components/sticky-summary.tsx'
import { useCreateBooking } from '../hooks/use-create-booking.ts'
import {
	type AddonCartEntry,
	addonGrossKopecks,
	cartGrossTotalKopecks,
} from '../lib/addon-pricing.ts'
import { CONSENT_VERSION, DPA_CONSENT_TEXT, MARKETING_CONSENT_TEXT } from '../lib/consent-texts.ts'
import type { PublicRateOption, PublicRoomType, PublicWidgetAddon } from '../lib/widget-api.ts'
import { generateIdempotencyKey, WidgetBookingCommitError } from '../lib/widget-booking-api.ts'

export interface GuestAndPayProps {
	readonly tenantSlug: string
	readonly propertyId: string
	readonly checkIn: string
	readonly checkOut: string
	readonly nights: number
	readonly adults: number
	readonly childrenCount: number
	readonly selectedRoomType: PublicRoomType
	readonly selectedRate: PublicRateOption
	readonly tourismTaxRateBps: number | null
	readonly cart: readonly AddonCartEntry[]
	readonly addons: readonly PublicWidgetAddon[]
}

export function GuestAndPay({
	tenantSlug,
	propertyId,
	checkIn,
	checkOut,
	nights,
	adults,
	childrenCount,
	selectedRoomType,
	selectedRate,
	tourismTaxRateBps,
	cart,
	addons,
}: GuestAndPayProps) {
	const idempotencyKey = useMemo(() => generateIdempotencyKey(), [])

	const [acceptedDpa, setAcceptedDpa] = useState(false)
	const [acceptedMarketing, setAcceptedMarketing] = useState(false)
	const [dpaError, setDpaError] = useState(false)
	const [paymentMethod, setPaymentMethod] = useState<WidgetPaymentMethod>('card')

	const totalGuests = adults + childrenCount
	const pricingCtx = useMemo(() => ({ nights, persons: totalGuests }), [nights, totalGuests])

	// Compute total для backend's expectedTotalKopecks integrity check
	const addonsTotalGrossKopecks = useMemo(
		() => cartGrossTotalKopecks(cart, addons, pricingCtx),
		[cart, addons, pricingCtx],
	)
	const expectedTotalKopecks = selectedRate.totalKopecks + addonsTotalGrossKopecks

	const addonLineItems: readonly AddonLineItem[] = useMemo(
		() =>
			cart
				.map((entry) => {
					const addon = addons.find((a) => a.addonId === entry.addonId)
					if (!addon || entry.quantity <= 0) return null
					const grossKopecks = addonGrossKopecks(
						addon.pricingUnit,
						addon.priceKopecks,
						entry.quantity,
						addon.vatBps,
						pricingCtx,
					)
					return {
						addonId: addon.addonId,
						nameRu: addon.nameRu,
						quantity: entry.quantity,
						grossKopecks,
					}
				})
				.filter((x): x is AddonLineItem => x !== null),
		[cart, addons, pricingCtx],
	)

	const mutation = useCreateBooking({ tenantSlug })

	async function handleGuestSubmit(guest: WidgetGuestInput) {
		// Re-validate consent gate at submit (152-ФЗ DPA mandatory)
		if (!acceptedDpa) {
			setDpaError(true)
			return
		}
		setDpaError(false)

		try {
			await mutation.mutateAsync({
				idempotencyKey,
				body: {
					propertyId,
					checkIn,
					checkOut,
					adults,
					children: childrenCount,
					roomTypeId: selectedRoomType.id,
					ratePlanId: selectedRate.ratePlanId,
					expectedTotalKopecks,
					addons: cart.map((entry) => ({
						addonId: entry.addonId,
						quantity: entry.quantity,
					})),
					guest,
					consents: {
						acceptedDpa: true,
						acceptedMarketing,
					},
					consentSnapshot: {
						dpaText: DPA_CONSENT_TEXT,
						marketingText: MARKETING_CONSENT_TEXT,
						version: CONSENT_VERSION,
					},
					paymentMethod,
				},
			})
			// On success — UI flips к success state via mutation.data
		} catch (err) {
			// Surface displayed via mutation.error в UI; no rethrow needed
			if (process.env.NODE_ENV !== 'production') {
				console.error('booking commit failed', err)
			}
		}
	}

	if (mutation.isSuccess && mutation.data) {
		return <SuccessState result={mutation.data} guestEmail={mutation.variables?.body.guest.email} />
	}

	return (
		<main
			className="mx-auto grid min-h-svh max-w-6xl gap-4 p-4 sm:p-6 md:grid-cols-[1fr_320px] md:p-8"
			lang="ru"
			data-testid="guest-and-pay-screen"
		>
			<div className="space-y-6">
				<header>
					<h1 className="text-2xl font-semibold tracking-tight">Контактные данные и оплата</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Шаг 3 из 3 • Бронируем {selectedRoomType.name} на {nights}{' '}
						{nights === 1 ? 'ночь' : nights < 5 ? 'ночи' : 'ночей'}
					</p>
				</header>

				<GuestForm onSubmit={handleGuestSubmit} disabled={mutation.isPending}>
					<PaymentMethodSelector
						value={paymentMethod}
						onChange={setPaymentMethod}
						disabled={mutation.isPending}
					/>

					<ConsentBlock
						acceptedDpa={acceptedDpa}
						acceptedMarketing={acceptedMarketing}
						onAcceptedDpaChange={(next) => {
							setAcceptedDpa(next)
							if (next) setDpaError(false)
						}}
						onAcceptedMarketingChange={setAcceptedMarketing}
						dpaError={dpaError}
					/>

					{mutation.isError ? <MutationErrorAlert error={mutation.error} /> : null}

					<Button
						type="submit"
						size="lg"
						disabled={mutation.isPending}
						className="w-full sm:w-auto forced-colors:bg-[ButtonText] forced-colors:text-[ButtonFace] forced-colors:border-[ButtonText]"
						data-testid="commit-button"
					>
						{mutation.isPending ? (
							<>
								<Loader2 className="size-4 animate-spin" aria-hidden />
								<span>Оформляем бронирование…</span>
							</>
						) : (
							'Оформить и оплатить'
						)}
					</Button>
				</GuestForm>
			</div>

			<aside className="md:sticky md:top-4 md:self-start">
				<StickySummary
					checkIn={checkIn}
					checkOut={checkOut}
					nights={nights}
					adults={adults}
					childrenCount={childrenCount}
					selectedRoomType={selectedRoomType}
					selectedRate={selectedRate}
					tourismTaxRateBps={tourismTaxRateBps}
					addonLineItems={addonLineItems}
					onContinue={() => {
						/* Submit lives в form footer; sticky CTA inert here. */
					}}
					continueLabel="См. форму ниже"
				/>
			</aside>
		</main>
	)
}

function SuccessState({
	result,
	guestEmail,
}: {
	result: WidgetBookingCommitResult
	guestEmail: string | undefined
}) {
	return (
		<main
			className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6 md:p-8"
			lang="ru"
			data-testid="commit-success"
		>
			<div className="rounded-xl border border-primary bg-primary/5 p-6 text-center">
				<CheckCircle2 className="mx-auto size-12 text-primary" aria-hidden />
				<h1 className="mt-4 text-2xl font-semibold">Бронирование подтверждено</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					Номер брони: <code className="font-mono">{result.bookingId}</code>
				</p>
			</div>
			<dl className="grid gap-2 rounded-lg border bg-card p-4 text-sm">
				<div className="grid grid-cols-[auto_1fr] gap-x-4">
					<dt className="text-muted-foreground">Статус оплаты</dt>
					<dd className="font-medium">
						{result.paymentStatus === 'succeeded'
							? 'Оплачено'
							: result.paymentStatus === 'pending'
								? 'Ожидает оплаты'
								: result.paymentStatus}
					</dd>
				</div>
				<div className="grid grid-cols-[auto_1fr] gap-x-4">
					<dt className="text-muted-foreground">Сумма</dt>
					<dd className="font-medium tabular-nums">
						{(result.totalKopecks / 100).toLocaleString('ru-RU', {
							style: 'currency',
							currency: 'RUB',
							maximumFractionDigits: 0,
						})}
					</dd>
				</div>
			</dl>
			{guestEmail ? (
				<Alert>
					<AlertTitle>Подтверждение отправлено на email</AlertTitle>
					<AlertDescription>
						Письмо со ссылкой на личный кабинет придёт на <strong>{guestEmail}</strong>. Через
						кабинет можно дозаполнить данные паспорта (если ещё не заполнены) и связаться с
						гостиницей. Если письмо не пришло — проверьте папку «Спам».
					</AlertDescription>
				</Alert>
			) : null}
		</main>
	)
}

function MutationErrorAlert({ error }: { error: Error }) {
	const reason = error instanceof WidgetBookingCommitError ? error.reason : 'server'
	const message =
		reason === 'consent_missing'
			? 'Необходимо принять согласие на обработку персональных данных (152-ФЗ).'
			: reason === 'stale_availability'
				? 'Цена или доступность номера изменились. Вернитесь к шагу 1, чтобы выбрать заново.'
				: reason === 'rate_limited'
					? 'Слишком много попыток подряд. Подождите минуту и попробуйте снова.'
					: reason === 'not_found'
						? 'Объект размещения недоступен. Попробуйте начать поиск заново.'
						: reason === 'validation'
							? 'Проверьте введённые данные и попробуйте снова.'
							: reason === 'network'
								? 'Сбой соединения. Проверьте интернет и повторите.'
								: 'Не удалось оформить бронирование. Попробуйте через минуту.'

	return (
		<Alert variant="destructive" data-testid="commit-error">
			<AlertTriangle className="size-4" aria-hidden />
			<AlertTitle>Ошибка оплаты</AlertTitle>
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	)
}
