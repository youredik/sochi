/**
 * Round 9 — Островок (ETG sandbox) booking form page.
 *
 * Pre-filled с reserved-test-range data (RFC 2606 email + ITU-T E.164.3
 * phone) per Round 8 outbound side-effect shield canon. Defaults differ
 * от Yandex flow (Пётр vs Иван) so demos showing both side-by-side keep
 * the data visibly distinct.
 *
 * **Two-stage handshake** (ETG canon, mirrors real upstream):
 *   1. `prebookForm()` — POST /hotel/order/booking/form/ — gets `order_id`
 *      + payment_types (declarative server-issued "what to pay")
 *   2. `finishBooking()` — POST /hotel/order/booking/finish/ — fires the
 *      webhook back to our own channel inbox (`/api/channel/webhooks/ETG`).
 *      Body MUST nest the partner_order_id inside `partner.partner_order_id`
 *      per ETG schema (not flat) — see api-client.ts:OstrovokFinishRequest.
 *
 * On success → onConfirmed(partnerOrderId). The success page uses
 * partner_order_id as our local correlation id (not the numeric order_id —
 * we surface the UUID to the user since they're the ones who provided it).
 *
 * Round 9 canon: brand-safe palette + DemoDisclaimerBanner mandatory.
 */

import { useId, useState } from 'react'
import { ostrovokBrandTokens } from '../shared/brand-tokens.ts'
import { DemoDisclaimerBanner, type DemoOtaBrand } from '../shared/demo-disclaimer-banner.tsx'
import { finishBooking, OstrovokApiError, prebookForm } from './api-client.ts'

const BRAND: DemoOtaBrand = 'ostrovok'

// Reserved-test-range defaults per Round 8 outbound side-effect shield canon
// (`feedback_outbound_side_effect_discipline_2026_05_22`). Demo NEVER hits
// live OTA upstream with these — safe triple-defense.
// Differentiated from Yandex (Иван) so side-by-side demos are visually distinct.
const DEFAULTS = {
	firstName: 'Пётр',
	lastName: 'Петров',
	email: 'petr@example.com',
	phone: '+79999999998',
} as const

export interface OstrovokBookingPageProps {
	readonly bookHash: string
	readonly partnerOrderId: string
	readonly totalPrice: number
	readonly onConfirmed: (partnerOrderId: string) => void
	/** Inject fetch for tests. */
	readonly fetchImpl?: typeof fetch
}

type SubmitState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'error'; message: string }

export function OstrovokBookingPage({
	bookHash,
	partnerOrderId,
	totalPrice,
	onConfirmed,
	fetchImpl,
}: OstrovokBookingPageProps) {
	const idPrefix = useId()
	const [firstName, setFirstName] = useState<string>(DEFAULTS.firstName)
	const [lastName, setLastName] = useState<string>(DEFAULTS.lastName)
	const [email, setEmail] = useState<string>(DEFAULTS.email)
	const [phone, setPhone] = useState<string>(DEFAULTS.phone)
	const [state, setState] = useState<SubmitState>({ kind: 'idle' })

	async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
		e.preventDefault()
		setState({ kind: 'submitting' })
		try {
			// Stage 2: prebookForm — get order_id + payment_types
			await prebookForm(
				{
					partner_order_id: partnerOrderId,
					book_hash: bookHash,
					language: 'ru',
					// Reserved-range IP (RFC 5737 TEST-NET-1 documentation block) —
					// never routable; safe demo default.
					user_ip: '192.0.2.1',
				},
				fetchImpl !== undefined ? { fetchImpl } : {},
			)
			// Stage 3: finishBooking — fires webhook back to our channel inbox.
			await finishBooking(
				{
					partner: { partner_order_id: partnerOrderId },
					user: { email, phone },
					language: 'ru',
					rooms: [
						{
							guests: [{ first_name: firstName, last_name: lastName }],
						},
					],
					payment_type: {
						type: 'now',
						amount: totalPrice.toFixed(2),
						currency_code: 'RUB',
					},
				},
				fetchImpl !== undefined ? { fetchImpl } : {},
			)
			onConfirmed(partnerOrderId)
		} catch (err) {
			const message =
				err instanceof OstrovokApiError
					? `Не удалось подтвердить бронирование: ${err.code}`
					: `Не удалось подтвердить бронирование: ${err instanceof Error ? err.message : String(err)}`
			setState({ kind: 'error', message })
		}
	}

	const footerNote = (
		<span>Демо-режим Sepshn. Все данные тестовые. Никаких реальных платежей не происходит.</span>
	)

	return (
		<div
			lang="ru"
			className="min-h-svh"
			style={{
				background: ostrovokBrandTokens.bg,
				color: ostrovokBrandTokens.text,
			}}
		>
			<DemoDisclaimerBanner brand={BRAND} footerNote={footerNote} />
			<header
				className="px-6 py-4"
				style={{
					background: ostrovokBrandTokens.bgMuted,
					borderBottom: `1px solid ${ostrovokBrandTokens.border}`,
				}}
			>
				<div className="mx-auto flex max-w-3xl items-center justify-between">
					<span
						className="font-bold text-lg tracking-tight"
						style={{ color: ostrovokBrandTokens.primary }}
					>
						Островок.ru
					</span>
				</div>
			</header>

			<main className="mx-auto max-w-3xl px-6 py-8">
				<h1 className="text-2xl font-bold tracking-tight">Данные для бронирования</h1>
				<p className="mt-2 text-sm" style={{ color: ostrovokBrandTokens.textMuted }}>
					Поля предзаполнены тестовыми значениями для демонстрации. Никаких реальных платежей не
					пройдёт.
				</p>

				<form
					onSubmit={(e) => {
						void handleSubmit(e)
					}}
					aria-label="Форма бронирования"
					className="mt-6 rounded-lg p-5 shadow-sm"
					style={{
						background: ostrovokBrandTokens.bg,
						border: `1px solid ${ostrovokBrandTokens.border}`,
					}}
				>
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
						<div>
							<label
								htmlFor={`${idPrefix}-booking-first-name`}
								className="mb-1 block text-sm font-medium"
							>
								Имя
							</label>
							<input
								id={`${idPrefix}-booking-first-name`}
								type="text"
								required
								value={firstName}
								onChange={(e) => setFirstName(e.target.value)}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: ostrovokBrandTokens.border }}
							/>
						</div>
						<div>
							<label
								htmlFor={`${idPrefix}-booking-last-name`}
								className="mb-1 block text-sm font-medium"
							>
								Фамилия
							</label>
							<input
								id={`${idPrefix}-booking-last-name`}
								type="text"
								required
								value={lastName}
								onChange={(e) => setLastName(e.target.value)}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: ostrovokBrandTokens.border }}
							/>
						</div>
						<div>
							<label
								htmlFor={`${idPrefix}-booking-email`}
								className="mb-1 block text-sm font-medium"
							>
								Email
							</label>
							<input
								id={`${idPrefix}-booking-email`}
								type="email"
								required
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: ostrovokBrandTokens.border }}
							/>
						</div>
						<div>
							<label
								htmlFor={`${idPrefix}-booking-phone`}
								className="mb-1 block text-sm font-medium"
							>
								Телефон
							</label>
							<input
								id={`${idPrefix}-booking-phone`}
								type="tel"
								required
								value={phone}
								onChange={(e) => setPhone(e.target.value)}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: ostrovokBrandTokens.border }}
							/>
						</div>
					</div>

					<div
						className="mt-4 rounded-md p-3 text-sm"
						style={{
							background: ostrovokBrandTokens.bgMuted,
							color: ostrovokBrandTokens.textMuted,
						}}
					>
						К оплате:{' '}
						<strong style={{ color: ostrovokBrandTokens.text }} data-testid="booking-total-price">
							{totalPrice.toLocaleString('ru-RU')} ₽
						</strong>
					</div>

					{state.kind === 'error' && (
						<p
							role="alert"
							data-testid="booking-error"
							className="mt-4 rounded-md p-3 text-sm"
							style={{
								background: 'hsl(354 76% 96%)',
								color: ostrovokBrandTokens.primary,
							}}
						>
							{state.message}
						</p>
					)}

					<button
						type="submit"
						data-testid="booking-submit"
						disabled={state.kind === 'submitting'}
						className="mt-6 w-full rounded-md px-6 py-3 font-medium shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							background: ostrovokBrandTokens.primary,
							color: ostrovokBrandTokens.primaryText,
						}}
					>
						{state.kind === 'submitting' ? 'Подтверждаем…' : 'Подтвердить бронирование'}
					</button>
				</form>
			</main>
		</div>
	)
}
