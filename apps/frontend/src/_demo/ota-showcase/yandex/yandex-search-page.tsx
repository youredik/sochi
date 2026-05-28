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

import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { sessionQueryOptions } from '../../../lib/auth-client.ts'
import { yandexBrandTokens } from '../shared/brand-tokens.ts'
import { DemoDisclaimerBanner, type DemoOtaBrand } from '../shared/demo-disclaimer-banner.tsx'
import { dateRangeErrorMessage, validateDateRange } from '../shared/validate-date-range.ts'
import { DEFAULT_HOTEL_ID } from './api-client.ts'

/**
 * Round 14.6.4 follow-up — derive hotelId per-tenant from authed session.
 *
 * Pre-fix: hotelId was hardcoded к `DEFAULT_HOTEL_ID='demo-hotel-sochi'` для
 * EVERY visitor → URL `/property/demo-hotel-sochi` rendered identically для
 * anonymous AND authed cabinet visitors. Backend now derives propertyId from
 * `c.var.tenantId` (Round 14.6.4 `resolveDemoPropertyId(c.var.tenantId)`) so
 * webhook + booking row land под the correct per-tenant scope, but frontend
 * URL slug stayed legacy → cosmetic drift.
 *
 * Canonical fix — frontend reads session via Better Auth `sessionQueryOptions`.
 * If active org present → derive matching per-tenant value (`demoprop_<orgId>`).
 * If anonymous → fall back к `DEFAULT_HOTEL_ID` (`'demo-hotel-sochi'`) which
 * mirrors backend's `resolveDemoPropertyId('demo-tenant')` legacy carve-out.
 *
 * Single source of truth canon — both sides derive from same authenticated
 * tenant identifier (web research 28.05.2026 «never trust per-tenant
 * identifier from request body/query; always derive from auth token»).
 */
function useDemoHotelIdForSession(): string {
	const session = useQuery(sessionQueryOptions)
	const activeOrgId = session.data?.session?.activeOrganizationId
	if (typeof activeOrgId === 'string' && activeOrgId.length > 0) {
		return `demoprop_${activeOrgId}`
	}
	return DEFAULT_HOTEL_ID
}

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

	// Round 12 R12V-1 + self-review SR-4 — shared validator (drift-proof).
	const [dateError, setDateError] = useState<string | null>(null)
	// Round 14.6.4 follow-up — per-tenant hotelId from session.
	const hotelId = useDemoHotelIdForSession()

	function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
		e.preventDefault()
		const validation = validateDateRange(checkinDate, checkoutDate)
		if (!validation.ok) {
			setDateError(dateRangeErrorMessage(validation.reason))
			return
		}
		setDateError(null)
		onSearch({
			hotelId,
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
