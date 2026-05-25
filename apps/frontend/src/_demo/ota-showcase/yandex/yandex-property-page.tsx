/**
 * Round 9 — Yandex.Путешествия property detail page.
 *
 * Single hardcoded demo property (`demo-hotel-sochi` — see backend
 * `yandex.routes.ts`). Shows hotel name, photo placeholder, 1-line
 * description, price summary fetched live от mock backend через
 * {@link searchOffers}, и a primary "Забронировать" CTA that navigates к
 * booking form с the issued booking_token.
 *
 * Round 9 canon: brand-safe palette + DemoDisclaimerBanner mandatory.
 *
 * **Loading semantics**: page hydrates с known check-in/out (from URL
 * search params or fallback). On mount, fires `searchOffers` to get a
 * fresh `booking_token` (single-use, 24h TTL). Until token resolves, the
 * book button is disabled — guarantees we never submit без valid token.
 */

import { useEffect, useState } from 'react'
import { yandexBrandTokens } from '../shared/brand-tokens.ts'
import { DemoDisclaimerBanner, type DemoOtaBrand } from '../shared/demo-disclaimer-banner.tsx'
import { searchOffers, type YandexOffer } from './api-client.ts'

const BRAND: DemoOtaBrand = 'yandex'

export interface YandexPropertyPageProps {
	readonly hotelId: string
	readonly checkinDate: string
	readonly checkoutDate: string
	readonly adults: number
	readonly childrenCount: number
	readonly onBook: (params: {
		bookingToken: string
		totalPrice: number
		roomName: string
		checkinDate: string
		checkoutDate: string
	}) => void
	/** Inject fetch for tests. */
	readonly fetchImpl?: typeof fetch
}

type LoadState =
	| { kind: 'loading' }
	| { kind: 'ready'; offer: YandexOffer }
	| { kind: 'error'; message: string }

export function YandexPropertyPage({
	hotelId,
	checkinDate,
	checkoutDate,
	adults,
	childrenCount,
	onBook,
	fetchImpl,
}: YandexPropertyPageProps) {
	const [state, setState] = useState<LoadState>({ kind: 'loading' })

	useEffect(() => {
		let cancelled = false
		void (async () => {
			const result = await searchOffers(
				{
					hotelId,
					checkinDate,
					checkoutDate,
					adults,
					children: childrenCount,
				},
				fetchImpl,
			)
			if (cancelled) return
			const firstOffer = result.kind === 'ok' ? result.data.offers[0] : undefined
			if (firstOffer !== undefined) {
				setState({ kind: 'ready', offer: firstOffer })
			} else if (result.kind === 'ok') {
				setState({ kind: 'error', message: 'Нет доступных предложений' })
			} else {
				setState({
					kind: 'error',
					message: `Ошибка поиска: ${result.error}`,
				})
			}
		})()
		return () => {
			cancelled = true
		}
	}, [hotelId, checkinDate, checkoutDate, adults, childrenCount, fetchImpl])

	const footerNote = (
		<span>
			Демо-режим Sepshn. Это вымышленный объект, бронирование пройдёт через тестовый канал.
		</span>
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
				<div className="mx-auto flex max-w-5xl items-center justify-between">
					<span
						className="font-bold text-lg tracking-tight"
						style={{ color: yandexBrandTokens.primary }}
					>
						Yandex.Путешествия
					</span>
				</div>
			</header>

			<main className="mx-auto max-w-5xl px-6 py-8">
				<h1 className="text-3xl font-bold tracking-tight" data-testid="property-hotel-name">
					Гостевой дом «Сэпшн-демо» в Сочи
				</h1>
				<p className="mt-2 text-sm" style={{ color: yandexBrandTokens.textMuted }}>
					Краснодарский край, Сочи · 0,5 км до пляжа
				</p>

				<div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
					<div
						className="aspect-[4/3] rounded-lg md:col-span-2"
						style={{
							background: `linear-gradient(135deg, ${yandexBrandTokens.bgMuted} 0%, ${yandexBrandTokens.accent} 100%)`,
						}}
						aria-label="Фото гостевого дома (демо-плейсхолдер)"
						role="img"
					/>
					<aside
						className="rounded-lg p-4"
						style={{
							background: yandexBrandTokens.bg,
							border: `1px solid ${yandexBrandTokens.border}`,
						}}
					>
						<h2 className="font-semibold text-base">Удобства</h2>
						<ul className="mt-3 space-y-1 text-sm" style={{ color: yandexBrandTokens.textMuted }}>
							<li>Wi-Fi бесплатно</li>
							<li>Завтрак включён</li>
							<li>Парковка</li>
							<li>Кондиционер</li>
						</ul>
					</aside>
				</div>

				<section
					className="mt-8 rounded-lg p-5"
					style={{
						background: yandexBrandTokens.bg,
						border: `1px solid ${yandexBrandTokens.border}`,
					}}
				>
					<div className="flex flex-wrap items-baseline justify-between gap-4">
						<div>
							<h2 className="font-semibold text-lg">
								{state.kind === 'ready' ? state.offer.room_name : 'Загружаем номер…'}
							</h2>
							<p className="mt-1 text-sm" style={{ color: yandexBrandTokens.textMuted }}>
								Заезд {checkinDate} · Выезд {checkoutDate} · {adults} взр.{' '}
								{childrenCount > 0 ? `· ${childrenCount} дет.` : ''}
							</p>
						</div>
						<div className="text-right">
							{state.kind === 'ready' ? (
								<>
									<p className="text-2xl font-bold" data-testid="property-total-price">
										{state.offer.total_price.toLocaleString('ru-RU')} ₽
									</p>
									<p className="text-xs" style={{ color: yandexBrandTokens.textMuted }}>
										за всё проживание
									</p>
								</>
							) : (
								<p className="text-2xl font-bold">— ₽</p>
							)}
						</div>
					</div>

					{state.kind === 'error' && (
						<p
							role="alert"
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
						type="button"
						data-testid="property-book-button"
						disabled={state.kind !== 'ready'}
						onClick={() => {
							if (state.kind !== 'ready') return
							onBook({
								bookingToken: state.offer.booking_token,
								totalPrice: state.offer.total_price,
								roomName: state.offer.room_name,
								checkinDate,
								checkoutDate,
							})
						}}
						className="mt-5 w-full rounded-md px-6 py-3 font-medium shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							background: yandexBrandTokens.primary,
							color: yandexBrandTokens.primaryText,
						}}
					>
						Забронировать
					</button>
				</section>
			</main>
		</div>
	)
}
