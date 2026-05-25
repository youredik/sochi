/**
 * Round 9 — Островок (ETG sandbox) booking confirmation page.
 *
 * Rendered after `finishBooking()` returns `{ status: 'ok' }`. Shows green
 * checkmark, partner_order_id (the UUID provided by us, not the numeric
 * ETG order_id), и a "вернуться в PMS" link that points back к the demo
 * entry tile в the sales-demo console (side-by-side view).
 *
 * The order_id (== partner_order_id) comes from the URL param `$orderId`.
 * Тhe route file passes it through `Route.useParams()`.
 *
 * Round 9 canon: brand-safe palette + DemoDisclaimerBanner mandatory.
 */

import { ostrovokBrandTokens } from '../shared/brand-tokens.ts'
import { DemoDisclaimerBanner, type DemoOtaBrand } from '../shared/demo-disclaimer-banner.tsx'

const BRAND: DemoOtaBrand = 'ostrovok'

export interface OstrovokSuccessPageProps {
	readonly orderId: string
	readonly returnToPmsUrl: string
}

export function OstrovokSuccessPage({ orderId, returnToPmsUrl }: OstrovokSuccessPageProps) {
	const footerNote = (
		<span>
			Демо-режим Sepshn. Бронирование передано в PMS через тестовый канал; реального платежа не
			было.
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
				<div className="mx-auto flex max-w-3xl items-center justify-between">
					<span
						className="font-bold text-lg tracking-tight"
						style={{ color: ostrovokBrandTokens.primary }}
					>
						Островок.ru
					</span>
				</div>
			</header>

			<main className="mx-auto max-w-3xl px-6 py-12">
				<div className="text-center">
					<div
						className="mx-auto flex h-16 w-16 items-center justify-center rounded-full"
						style={{ background: 'hsl(142 71% 45%)' }}
						aria-hidden="true"
					>
						<svg
							width="32"
							height="32"
							viewBox="0 0 24 24"
							fill="none"
							stroke="white"
							strokeWidth="3"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
							role="presentation"
						>
							<polyline points="20 6 9 17 4 12" />
						</svg>
					</div>
					<h1 className="mt-6 text-3xl font-bold tracking-tight" data-testid="success-heading">
						Бронирование подтверждено
					</h1>
					<p className="mt-3 text-sm" style={{ color: ostrovokBrandTokens.textMuted }}>
						Подтверждение отправлено на ваш email. Отель получил уведомление.
					</p>
				</div>

				<section
					className="mx-auto mt-8 max-w-md rounded-lg p-5"
					style={{
						background: ostrovokBrandTokens.bg,
						border: `1px solid ${ostrovokBrandTokens.border}`,
					}}
				>
					<dl className="grid grid-cols-1 gap-3 text-sm">
						<div className="flex justify-between">
							<dt style={{ color: ostrovokBrandTokens.textMuted }}>Номер заказа</dt>
							<dd className="font-mono font-medium" data-testid="success-order-id">
								{orderId}
							</dd>
						</div>
						<div className="flex justify-between">
							<dt style={{ color: ostrovokBrandTokens.textMuted }}>Статус</dt>
							<dd className="font-medium" style={{ color: 'hsl(142 71% 35%)' }}>
								Подтверждено
							</dd>
						</div>
					</dl>
				</section>

				<div className="mt-8 text-center">
					<a
						href={returnToPmsUrl}
						data-testid="success-return-link"
						className="inline-flex items-center rounded-md px-5 py-2.5 font-medium shadow-sm transition-colors"
						style={{
							background: ostrovokBrandTokens.bgMuted,
							color: ostrovokBrandTokens.text,
							border: `1px solid ${ostrovokBrandTokens.border}`,
						}}
					>
						Вернуться к демо PMS
					</a>
				</div>
			</main>
		</div>
	)
}
