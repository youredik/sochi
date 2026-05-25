/**
 * Round 9 — Островок (ETG sandbox) property detail page.
 *
 * Single hardcoded demo hotel (`SANDBOX_DEMO_HID = 8473727` — see backend
 * `ostrovok.routes.ts`). Shows hotel name, photo placeholder, 1-line
 * description, price summary fetched live от mock backend через
 * {@link searchHotel}, и a primary "Забронировать" CTA that navigates к
 * booking form с the issued book_hash + a freshly-generated partner_order_id.
 *
 * Round 9 canon: brand-safe palette + DemoDisclaimerBanner mandatory.
 *
 * **Loading semantics**: page hydrates с known check-in/out (from URL
 * search params or fallback). On mount, fires `searchHotel` to get a
 * fresh `book_hash` (one of multiple rates). Until book_hash resolves, the
 * book button is disabled — guarantees we never call form() без valid hash.
 *
 * **Flow difference vs Yandex**: Yandex returns `booking_token` direct.
 * Островок returns `book_hash` here, which is consumed by `prebookForm`
 * на next step. The booking page receives book_hash via navigation state /
 * URL search and orchestrates the 2-stage form→finish handshake.
 */

import { useEffect, useState } from 'react'
import { ostrovokBrandTokens } from '../shared/brand-tokens.ts'
import { DemoDisclaimerBanner, type DemoOtaBrand } from '../shared/demo-disclaimer-banner.tsx'
import { OstrovokApiError, type OstrovokRate, searchHotel } from './api-client.ts'

const BRAND: DemoOtaBrand = 'ostrovok'

export interface OstrovokPropertyPageProps {
	readonly hid: number
	readonly checkinDate: string
	readonly checkoutDate: string
	readonly adults: number
	readonly childrenCount: number
	readonly onBook: (params: {
		bookHash: string
		partnerOrderId: string
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
	| { kind: 'ready'; rate: OstrovokRate }
	| { kind: 'error'; message: string }

export function OstrovokPropertyPage({
	hid,
	checkinDate,
	checkoutDate,
	adults,
	childrenCount,
	onBook,
	fetchImpl,
}: OstrovokPropertyPageProps) {
	const [state, setState] = useState<LoadState>({ kind: 'loading' })

	useEffect(() => {
		let cancelled = false
		void (async () => {
			try {
				const result = await searchHotel(
					{
						checkin: checkinDate,
						checkout: checkoutDate,
						hid,
						currency: 'RUB',
						language: 'ru',
						residency: 'ru',
						guests: [{ adults, children: new Array(childrenCount).fill(10) }],
					},
					fetchImpl !== undefined ? { fetchImpl } : {},
				)
				if (cancelled) return
				const firstHotel = result.data.hotels[0]
				const firstRate = firstHotel?.rates[0]
				if (firstRate !== undefined) {
					setState({ kind: 'ready', rate: firstRate })
				} else {
					setState({ kind: 'error', message: 'Нет доступных предложений' })
				}
			} catch (err) {
				if (cancelled) return
				const message =
					err instanceof OstrovokApiError
						? `Ошибка поиска: ${err.code}`
						: `Ошибка поиска: ${err instanceof Error ? err.message : String(err)}`
				setState({ kind: 'error', message })
			}
		})()
		return () => {
			cancelled = true
		}
	}, [hid, checkinDate, checkoutDate, adults, childrenCount, fetchImpl])

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
				<div className="mx-auto flex max-w-5xl items-center justify-between">
					<span
						className="font-bold text-lg tracking-tight"
						style={{ color: ostrovokBrandTokens.primary }}
					>
						Островок.ru
					</span>
				</div>
			</header>

			<main className="mx-auto max-w-5xl px-6 py-8">
				<h1 className="text-3xl font-bold tracking-tight" data-testid="property-hotel-name">
					Гостевой дом «Сэпшн-демо» в Сочи
				</h1>
				<p className="mt-2 text-sm" style={{ color: ostrovokBrandTokens.textMuted }}>
					Краснодарский край, Сочи · 0,5 км до пляжа
				</p>

				<div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
					<div
						className="aspect-[4/3] rounded-lg md:col-span-2"
						style={{
							background: `linear-gradient(135deg, ${ostrovokBrandTokens.bgMuted} 0%, ${ostrovokBrandTokens.accent} 100%)`,
						}}
						aria-label="Фото гостевого дома (демо-плейсхолдер)"
						role="img"
					/>
					<aside
						className="rounded-lg p-4"
						style={{
							background: ostrovokBrandTokens.bg,
							border: `1px solid ${ostrovokBrandTokens.border}`,
						}}
					>
						<h2 className="font-semibold text-base">Удобства</h2>
						<ul className="mt-3 space-y-1 text-sm" style={{ color: ostrovokBrandTokens.textMuted }}>
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
						background: ostrovokBrandTokens.bg,
						border: `1px solid ${ostrovokBrandTokens.border}`,
					}}
				>
					<div className="flex flex-wrap items-baseline justify-between gap-4">
						<div>
							<h2 className="font-semibold text-lg">
								{state.kind === 'ready' ? state.rate.room_name : 'Загружаем номер…'}
							</h2>
							<p className="mt-1 text-sm" style={{ color: ostrovokBrandTokens.textMuted }}>
								Заезд {checkinDate} · Выезд {checkoutDate} · {adults} взр.{' '}
								{childrenCount > 0 ? `· ${childrenCount} дет.` : ''}
							</p>
						</div>
						<div className="text-right">
							{state.kind === 'ready' ? (
								<>
									<p className="text-2xl font-bold" data-testid="property-total-price">
										{state.rate.total_price.toLocaleString('ru-RU')} ₽
									</p>
									<p className="text-xs" style={{ color: ostrovokBrandTokens.textMuted }}>
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
								background: 'hsl(354 76% 96%)',
								color: ostrovokBrandTokens.primary,
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
								bookHash: state.rate.book_hash,
								// Generate fresh UUIDv4 per Round 9 canon — backend rejects
								// non-UUIDv4 partner_order_id с invalid_partner_order_id.
								partnerOrderId: crypto.randomUUID(),
								totalPrice: state.rate.total_price,
								roomName: state.rate.room_name,
								checkinDate,
								checkoutDate,
							})
						}}
						className="mt-5 w-full rounded-md px-6 py-3 font-medium shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							background: ostrovokBrandTokens.primary,
							color: ostrovokBrandTokens.primaryText,
						}}
					>
						Забронировать
					</button>
				</section>
			</main>
		</div>
	)
}
