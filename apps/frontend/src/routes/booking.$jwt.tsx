/**
 * Magic-link landing route — `/booking/:jwt` (M9.widget.5 / A3.4).
 *
 * Per `plans/m9_widget_5_canonical.md` §D1 + §D5:
 *   - Two-step canon (Apple MPP defense): GET /render verifies WITHOUT consuming.
 *     User clicks button → POST /consume marks consumed + sets cookie + navigates
 *     к /booking/guest-portal/{bookingId}.
 *   - Email scanners (Apple MPP / Slack unfurl / Outlook SafeLinks) safely follow
 *     GET — no attempts burned.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
	consumeMagicLink,
	type MagicLinkRenderPayload,
	renderMagicLink,
} from '../features/public-widget/lib/booking-portal-api.ts'

export const Route = createFileRoute('/booking/$jwt')({
	component: MagicLinkLandingPage,
})

function MagicLinkLandingPage() {
	const { jwt } = Route.useParams()
	const navigate = useNavigate()

	const [state, setState] = useState<
		| { kind: 'loading' }
		| { kind: 'ready'; payload: MagicLinkRenderPayload }
		| { kind: 'error'; code: string; message: string }
		| { kind: 'consuming' }
		| { kind: 'consumed' }
	>({ kind: 'loading' })

	useEffect(() => {
		let cancelled = false
		void (async () => {
			const result = await renderMagicLink(jwt)
			if (cancelled) return
			if (result.kind === 'ok') {
				setState({ kind: 'ready', payload: result.data })
			} else {
				setState({ kind: 'error', code: result.code, message: result.message })
			}
		})()
		return () => {
			cancelled = true
		}
	}, [jwt])

	async function handleConsume(): Promise<void> {
		setState({ kind: 'consuming' })
		const result = await consumeMagicLink(jwt)
		if (result.kind === 'ok') {
			setState({ kind: 'consumed' })
			void navigate({
				to: '/booking/guest-portal/$bookingId',
				params: { bookingId: result.data.bookingId },
			})
		} else {
			setState({ kind: 'error', code: result.code, message: result.message })
		}
	}

	return (
		<main className="mx-auto max-w-md p-6">
			<h1 className="mb-4 text-xl font-semibold">Управление бронированием</h1>
			{state.kind === 'loading' && <p>Проверяем ссылку…</p>}
			{state.kind === 'ready' && (
				<>
					<p className="mb-2">
						Бронирование № <strong>{state.payload.bookingId}</strong>
					</p>
					<p className="mb-6 text-sm text-muted-foreground">
						Ссылка действительна до {new Date(state.payload.expiresAt).toLocaleString('ru-RU')}.
					</p>
					<button
						type="button"
						onClick={() => void handleConsume()}
						className="rounded-md bg-primary px-6 py-3 font-medium text-primary-foreground"
					>
						Открыть бронирование
					</button>
				</>
			)}
			{state.kind === 'consuming' && <p>Открываем портал…</p>}
			{state.kind === 'consumed' && <p>Перенаправляем…</p>}
			{state.kind === 'error' && (
				<div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
					<p className="font-medium text-destructive">{state.message}</p>
					<p className="mt-2 text-sm">
						Запросите новую ссылку через{' '}
						<a href="/booking/find" className="underline">
							форму поиска брони
						</a>
						.
					</p>
				</div>
			)}
		</main>
	)
}
