/**
 * Round 9 — Yandex.Путешествия look-alike search landing page.
 *
 * Mounted by `routes/_demo.ota.yandex.index.tsx`. NOT production code —
 * lives inside `_demo/` per Round 9 canon (env-gated).
 *
 * Visual surface ('approximately Yandex'):
 *   - sticky DemoDisclaimerBanner (MANDATORY, e2e-asserted)
 *   - "Yandex.Путешествия" wordmark (plain text, brand-safe — NO real logo SVG)
 *   - 2-col date inputs + 2-col adults/children + bright primary CTA
 *
 * Pre-fills sensible defaults: today+7 / today+9, 2 adults, 0 children.
 * User clicks "Найти" → navigates к property page с dates encoded в search.
 *
 * Brand-safe per `feedback_round_9_demo_ota_server_canon_2026_05_25.md`:
 *   - approximate HSL palette (NOT exact Yandex hex)
 *   - plain text wordmark (NO real logo)
 *   - footer affiliation disclaimer
 */

import { useId, useState } from 'react'
import { yandexBrandTokens } from '../shared/brand-tokens.ts'
import { DemoDisclaimerBanner, type DemoOtaBrand } from '../shared/demo-disclaimer-banner.tsx'
import { DEFAULT_HOTEL_ID } from './api-client.ts'

const BRAND: DemoOtaBrand = 'yandex'

function isoDate(plusDays: number): string {
	const d = new Date()
	d.setUTCHours(0, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + plusDays)
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export interface YandexSearchPageProps {
	readonly onSearch: (params: {
		hotelId: string
		checkinDate: string
		checkoutDate: string
		adults: number
		children: number
	}) => void
}

export function YandexSearchPage({ onSearch }: YandexSearchPageProps) {
	const idPrefix = useId()
	const [checkinDate, setCheckin] = useState(isoDate(7))
	const [checkoutDate, setCheckout] = useState(isoDate(9))
	const [adults, setAdults] = useState(2)
	const [children, setChildren] = useState(0)

	// Round 12 R12V-1 — client-side validation: checkOut > checkIn. Backend
	// rejects invalid_date_range gracefully but the user experience is broken
	// (the property page shows the alert with no clear recovery path).
	const [dateError, setDateError] = useState<string | null>(null)

	function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
		e.preventDefault()
		if (
			checkinDate.length === 0 ||
			checkoutDate.length === 0 ||
			Date.parse(checkoutDate) <= Date.parse(checkinDate)
		) {
			setDateError('Дата выезда должна быть позже даты заезда.')
			return
		}
		setDateError(null)
		onSearch({
			hotelId: DEFAULT_HOTEL_ID,
			checkinDate,
			checkoutDate,
			adults,
			children,
		})
	}

	const footerNote = (
		<span>Демо-режим Sepshn. Все данные — тестовые. Поиск возвращает один пример объекта.</span>
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
						data-testid="yandex-wordmark"
					>
						Yandex.Путешествия
					</span>
					<nav className="text-sm" style={{ color: yandexBrandTokens.textMuted }}>
						<span>Отели</span>
					</nav>
				</div>
			</header>

			<main className="mx-auto max-w-5xl px-6 py-10">
				<h1 className="text-3xl font-bold tracking-tight">Куда вы хотите поехать?</h1>
				<p className="mt-2 text-sm" style={{ color: yandexBrandTokens.textMuted }}>
					Найдите отель и забронируйте номер.
				</p>

				<form
					onSubmit={handleSubmit}
					aria-label="Форма поиска отеля"
					className="mt-6 rounded-lg p-4 shadow-sm"
					style={{
						background: yandexBrandTokens.bg,
						border: `1px solid ${yandexBrandTokens.border}`,
					}}
				>
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
						<div>
							<label
								htmlFor={`${idPrefix}-search-checkin`}
								className="mb-1 block text-sm font-medium"
							>
								Заезд
							</label>
							<input
								id={`${idPrefix}-search-checkin`}
								type="date"
								required
								value={checkinDate}
								onChange={(e) => setCheckin(e.target.value)}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: yandexBrandTokens.border }}
							/>
						</div>
						<div>
							<label
								htmlFor={`${idPrefix}-search-checkout`}
								className="mb-1 block text-sm font-medium"
							>
								Выезд
							</label>
							<input
								id={`${idPrefix}-search-checkout`}
								type="date"
								required
								value={checkoutDate}
								onChange={(e) => setCheckout(e.target.value)}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: yandexBrandTokens.border }}
							/>
						</div>
						<div>
							<label
								htmlFor={`${idPrefix}-search-adults`}
								className="mb-1 block text-sm font-medium"
							>
								Взрослые
							</label>
							<input
								id={`${idPrefix}-search-adults`}
								type="number"
								min={1}
								max={10}
								required
								value={adults}
								onChange={(e) => {
									// Round 12 — clamp to [1,10]; empty input → fallback to current
									// value (no surprise 1-reset mid-typing).
									const raw = e.target.value
									if (raw === '') return
									const n = Number.parseInt(raw, 10)
									if (!Number.isFinite(n)) return
									setAdults(Math.min(10, Math.max(1, n)))
								}}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: yandexBrandTokens.border }}
							/>
						</div>
						<div>
							<label
								htmlFor={`${idPrefix}-search-children`}
								className="mb-1 block text-sm font-medium"
							>
								Дети
							</label>
							<input
								id={`${idPrefix}-search-children`}
								type="number"
								min={0}
								max={6}
								value={children}
								onChange={(e) => {
									// Round 12 — clamp to [0,6]; empty input → fallback to current
									// (avoid `'' || 0` collapse that silently zeroes mid-typing).
									const raw = e.target.value
									if (raw === '') return
									const n = Number.parseInt(raw, 10)
									if (!Number.isFinite(n)) return
									setChildren(Math.min(6, Math.max(0, n)))
								}}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: yandexBrandTokens.border }}
							/>
						</div>
					</div>

					{dateError !== null && (
						<p
							role="alert"
							data-testid="yandex-search-date-error"
							className="mt-4 rounded-md border-l-4 p-3 text-sm font-medium"
							style={{
								background: 'hsl(11 92% 96%)',
								color: 'hsl(11 80% 30%)',
								borderLeftColor: yandexBrandTokens.primary,
							}}
						>
							{dateError}
						</p>
					)}

					<button
						type="submit"
						data-testid="yandex-search-submit"
						className="mt-6 w-full rounded-md px-6 py-3 font-medium shadow-sm transition-colors"
						style={{
							background: yandexBrandTokens.primary,
							color: yandexBrandTokens.primaryText,
						}}
					>
						Найти
					</button>
				</form>
			</main>
		</div>
	)
}
