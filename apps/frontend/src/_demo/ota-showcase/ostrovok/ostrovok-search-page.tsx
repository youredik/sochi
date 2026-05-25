/**
 * Round 9 — Островок (ETG sandbox) look-alike search landing page.
 *
 * Mounted by `routes/_demo.ota.ostrovok.index.tsx`. NOT production code —
 * lives inside `_demo/` per Round 9 canon (env-gated).
 *
 * Visual surface ('approximately Островок'):
 *   - sticky DemoDisclaimerBanner (MANDATORY, e2e-asserted)
 *   - "Островок.ru" wordmark (plain text, brand-safe — NO real logo SVG)
 *   - 2-col date inputs + 2-col adults/children + bright primary CTA
 *
 * Pre-fills sensible defaults: today+7 / today+9, 2 adults, 0 children.
 * User clicks "Найти" → navigates к property page с dates encoded в search.
 *
 * Brand-safe per `feedback_round_9_demo_ota_server_canon_2026_05_25.md`:
 *   - approximate HSL palette (NOT exact Островок hex)
 *   - plain text wordmark (NO real logo)
 *   - footer affiliation disclaimer
 */

import { useId, useState } from 'react'
import { ostrovokBrandTokens } from '../shared/brand-tokens.ts'
import { DemoDisclaimerBanner, type DemoOtaBrand } from '../shared/demo-disclaimer-banner.tsx'
import { SANDBOX_DEMO_HID } from './api-client.ts'

const BRAND: DemoOtaBrand = 'ostrovok'

function isoDate(plusDays: number): string {
	const d = new Date()
	d.setUTCHours(0, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + plusDays)
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export interface OstrovokSearchPageProps {
	readonly onSearch: (params: {
		hid: number
		checkinDate: string
		checkoutDate: string
		adults: number
		children: number
	}) => void
}

export function OstrovokSearchPage({ onSearch }: OstrovokSearchPageProps) {
	const idPrefix = useId()
	const [checkinDate, setCheckin] = useState(isoDate(7))
	const [checkoutDate, setCheckout] = useState(isoDate(9))
	const [adults, setAdults] = useState(2)
	const [children, setChildren] = useState(0)

	function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
		e.preventDefault()
		onSearch({
			hid: SANDBOX_DEMO_HID,
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
						data-testid="ostrovok-wordmark"
					>
						Островок.ru
					</span>
					<nav className="text-sm" style={{ color: ostrovokBrandTokens.textMuted }}>
						<span>Отели</span>
					</nav>
				</div>
			</header>

			<main className="mx-auto max-w-5xl px-6 py-10">
				<h1 className="text-3xl font-bold tracking-tight">Куда вы хотите поехать?</h1>
				<p className="mt-2 text-sm" style={{ color: ostrovokBrandTokens.textMuted }}>
					Найдите отель и забронируйте номер.
				</p>

				<form
					onSubmit={handleSubmit}
					aria-label="Форма поиска отеля"
					className="mt-6 rounded-lg p-4 shadow-sm"
					style={{
						background: ostrovokBrandTokens.bg,
						border: `1px solid ${ostrovokBrandTokens.border}`,
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
								style={{ borderColor: ostrovokBrandTokens.border }}
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
								style={{ borderColor: ostrovokBrandTokens.border }}
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
								onChange={(e) => setAdults(Number.parseInt(e.target.value, 10) || 1)}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: ostrovokBrandTokens.border }}
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
								onChange={(e) => setChildren(Number.parseInt(e.target.value, 10) || 0)}
								className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2"
								style={{ borderColor: ostrovokBrandTokens.border }}
							/>
						</div>
					</div>

					<button
						type="submit"
						data-testid="ostrovok-search-submit"
						className="mt-6 w-full rounded-md px-6 py-3 font-medium shadow-sm transition-colors"
						style={{
							background: ostrovokBrandTokens.primary,
							color: ostrovokBrandTokens.primaryText,
						}}
					>
						Найти
					</button>
				</form>
			</main>
		</div>
	)
}
