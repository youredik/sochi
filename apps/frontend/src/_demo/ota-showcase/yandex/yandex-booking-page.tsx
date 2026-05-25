/**
 * Round 9 — Yandex.Путешествия booking form page.
 *
 * Pre-filled с reserved-test-range data (RFC 2606 email + ITU-T E.164.3
 * phone) per Round 8 outbound side-effect shield canon. Hotelier can
 * just click "Подтвердить" в демо без typing — wow-effect demos должны
 * быть friction-free.
 *
 * Submits к `POST /api/_mock-ota/yandex/v1/hotels/booking/orders` which
 * fires CloudEvents webhook into our own channel inbox, surfaces в the
 * PMS split-pane side-by-side, then returns `{ order_id, status: 'CONFIRMED' }`.
 *
 * Round 9 canon: brand-safe palette + DemoDisclaimerBanner mandatory.
 */

import { useId, useState } from 'react'
import { yandexBrandTokens } from '../shared/brand-tokens.ts'
import { DemoDisclaimerBanner, type DemoOtaBrand } from '../shared/demo-disclaimer-banner.tsx'
import { createOrder } from './api-client.ts'

const BRAND: DemoOtaBrand = 'yandex'

// Reserved-test-range defaults per Round 8 outbound side-effect shield canon
// (`feedback_outbound_side_effect_discipline_2026_05_22`). Demo NEVER hits
// live OTA upstream with these — safe triple-defense.
const DEFAULTS = {
	firstName: 'Иван',
	lastName: 'Иванов',
	email: 'ivan@example.com',
	phone: '+70000000001',
} as const

export interface YandexBookingPageProps {
	readonly bookingToken: string
	readonly onConfirmed: (orderId: string) => void
	/** Inject fetch for tests. */
	readonly fetchImpl?: typeof fetch
}

type SubmitState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'error'; message: string }

export function YandexBookingPage({
	bookingToken,
	onConfirmed,
	fetchImpl,
}: YandexBookingPageProps) {
	const idPrefix = useId()
	const [firstName, setFirstName] = useState<string>(DEFAULTS.firstName)
	const [lastName, setLastName] = useState<string>(DEFAULTS.lastName)
	const [email, setEmail] = useState<string>(DEFAULTS.email)
	const [phone, setPhone] = useState<string>(DEFAULTS.phone)
	const [comment, setComment] = useState<string>('')
	const [state, setState] = useState<SubmitState>({ kind: 'idle' })

	async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
		e.preventDefault()
		setState({ kind: 'submitting' })
		const result = await createOrder(
			{
				booking_token: bookingToken,
				customer_email: email,
				customer_phone: phone,
				guests: [{ first_name: firstName, last_name: lastName }],
				...(comment.length > 0 ? { comment } : {}),
			},
			fetchImpl,
		)
		if (result.kind === 'ok') {
			onConfirmed(result.data.order_id)
		} else {
			setState({
				kind: 'error',
				message: `Не удалось подтвердить бронирование: ${result.error}`,
			})
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
				background: yandexBrandTokens.bg,
				color: yandexBrandTokens.text,
			}}
		>
			<DemoDisclaimerBanner brand={BRAND} footerNote={footerNote} />
			<header
				className="px-6 py-4"
				style={{
					background: yandexBrandTokens.bgMuted,
					borderBottom: `1px solid ${yandexBrandTokens.border}`,
				}}
			>
				<div className="mx-auto flex max-w-3xl items-center justify-between">
					<span
						className="font-bold text-lg tracking-tight"
						style={{ color: yandexBrandTokens.primary }}
					>
						Yandex.Путешествия
					</span>
				</div>
			</header>

			<main className="mx-auto max-w-3xl px-6 py-8">
				<h1 className="text-2xl font-bold tracking-tight">Данные для бронирования</h1>
				<p className="mt-2 text-sm" style={{ color: yandexBrandTokens.textMuted }}>
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
						background: yandexBrandTokens.bg,
						border: `1px solid ${yandexBrandTokens.border}`,
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
								style={{ borderColor: yandexBrandTokens.border }}
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
								style={{ borderColor: yandexBrandTokens.border }}
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
								style={{ borderColor: yandexBrandTokens.border }}
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
								style={{ borderColor: yandexBrandTokens.border }}
							/>
						</div>
					</div>
					<div className="mt-4">
						<label
							htmlFor={`${idPrefix}-booking-comment`}
							className="mb-1 block text-sm font-medium"
						>
							Комментарий для отеля (необязательно)
						</label>
						<textarea
							id={`${idPrefix}-booking-comment`}
							rows={3}
							value={comment}
							onChange={(e) => setComment(e.target.value)}
							className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
							style={{ borderColor: yandexBrandTokens.border }}
						/>
					</div>

					{state.kind === 'error' && (
						<p
							role="alert"
							data-testid="booking-error"
							className="mt-4 rounded-md p-3 text-sm"
							style={{
								background: 'hsl(11 92% 96%)',
								color: yandexBrandTokens.primary,
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
							background: yandexBrandTokens.primary,
							color: yandexBrandTokens.primaryText,
						}}
					>
						{state.kind === 'submitting' ? 'Подтверждаем…' : 'Подтвердить бронирование'}
					</button>
				</form>
			</main>
		</div>
	)
}
