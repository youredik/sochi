/**
 * Guest portal route — `/booking/guest-portal/:bookingId` (M9.widget.5 / A3.4).
 *
 * Per `plans/m9_widget_5_canonical.md` §D12 (ПП РФ № 1912 п. 16 canon):
 *   - View booking details + ПП-1912 cancel policy disclosure
 *   - Cancel button с reason input — only shown если scope='mutate'
 *   - 100% refund if pre_checkin; max 1-night charge if day_of_or_later
 *   - «Невозвратный тариф» NEVER shown (eliminated per ПП-1912)
 */

import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
	cancelBooking,
	type GuestPortalGetPayload,
	getGuestPortal,
} from '../features/public-widget/lib/booking-portal-api.ts'

export const Route = createFileRoute('/booking/guest-portal/$bookingId')({
	component: GuestPortalPage,
})

function GuestPortalPage() {
	const { bookingId } = Route.useParams()

	const [state, setState] = useState<
		| { kind: 'loading' }
		| { kind: 'ready'; payload: GuestPortalGetPayload }
		| { kind: 'error'; code: string; message: string }
		| { kind: 'cancelling' }
		| { kind: 'cancelled'; status: string; refundPercent: number; maxChargeNights: number }
	>({ kind: 'loading' })

	const [reason, setReason] = useState<string>('')

	useEffect(() => {
		let cancelledFlag = false
		void (async () => {
			const result = await getGuestPortal(bookingId)
			if (cancelledFlag) return
			if (result.kind === 'ok') setState({ kind: 'ready', payload: result.data })
			else setState({ kind: 'error', code: result.code, message: result.message })
		})()
		return () => {
			cancelledFlag = true
		}
	}, [bookingId])

	async function handleCancel(): Promise<void> {
		if (!reason.trim()) return
		setState({ kind: 'cancelling' })
		const result = await cancelBooking(bookingId, reason.trim())
		if (result.kind === 'ok') {
			setState({
				kind: 'cancelled',
				status: result.data.status,
				refundPercent: result.data.cancelPolicy.refundPercent,
				maxChargeNights: result.data.cancelPolicy.maxChargeNights,
			})
		} else {
			setState({ kind: 'error', code: result.code, message: result.message })
		}
	}

	if (state.kind === 'loading') {
		return (
			<main className="mx-auto max-w-2xl p-6">
				<p>Загружаем бронирование…</p>
			</main>
		)
	}

	if (state.kind === 'error') {
		return (
			<main className="mx-auto max-w-2xl p-6">
				<div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
					<p className="font-medium text-destructive">{state.message}</p>
				</div>
			</main>
		)
	}

	if (state.kind === 'cancelled') {
		return (
			<main className="mx-auto max-w-2xl p-6">
				<h1 className="mb-4 text-xl font-semibold">Бронирование отменено</h1>
				<p className="mb-2">
					Возврат: <strong>{state.refundPercent}%</strong> от суммы
				</p>
				{state.maxChargeNights > 0 && (
					<p className="mb-2 text-sm text-muted-foreground">
						Удержание: не более стоимости {state.maxChargeNights} суток (ПП РФ № 1912 п. 16).
					</p>
				)}
			</main>
		)
	}

	if (state.kind !== 'ready') {
		// Should be unreachable — earlier kind branches handle loading/error/cancelled/cancelling.
		return null
	}
	const { booking, cancelPolicy, scope } = state.payload
	const cancellable =
		scope === 'mutate' && booking.status !== 'cancelled' && booking.status !== 'checkedOut'

	return (
		<main className="mx-auto max-w-2xl p-6">
			<h1 className="mb-4 text-xl font-semibold">Бронирование № {booking.bookingId}</h1>

			<dl className="mb-6 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
				<dt className="text-muted-foreground">Статус</dt>
				<dd>{booking.status}</dd>
				<dt className="text-muted-foreground">Гостиница</dt>
				<dd>{booking.propertyName}</dd>
				{booking.propertyAddress !== null && (
					<>
						<dt className="text-muted-foreground">Адрес</dt>
						<dd>{booking.propertyAddress}</dd>
					</>
				)}
				<dt className="text-muted-foreground">Заезд</dt>
				<dd>{new Date(booking.checkIn).toLocaleDateString('ru-RU')}</dd>
				<dt className="text-muted-foreground">Выезд</dt>
				<dd>{new Date(booking.checkOut).toLocaleDateString('ru-RU')}</dd>
				<dt className="text-muted-foreground">Гости</dt>
				<dd>{booking.guestsCount}</dd>
				<dt className="text-muted-foreground">Сумма</dt>
				<dd className="font-semibold">{booking.totalFormatted}</dd>
			</dl>

			{cancellable ? (
				<section className="rounded-md border p-4">
					<h2 className="mb-2 font-medium">Отменить бронирование</h2>
					<p className="mb-3 text-sm text-muted-foreground">{cancelPolicy.disclosure}</p>
					<label className="mb-3 block">
						<span className="mb-1 block text-sm">Причина отмены</span>
						<input
							type="text"
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							placeholder="Укажите причину"
							className="w-full rounded-md border px-3 py-2"
							maxLength={500}
						/>
					</label>
					<button
						type="button"
						onClick={() => void handleCancel()}
						disabled={reason.trim() === ''}
						className="rounded-md bg-destructive px-4 py-2 font-medium text-destructive-foreground disabled:opacity-50"
					>
						Отменить бронирование
					</button>
				</section>
			) : scope === 'view' ? (
				<p className="text-sm text-muted-foreground">
					Для отмены требуется свежая ссылка с правом изменения. Запросите новую через форму поиска
					брони.
				</p>
			) : null}
		</main>
	)
}
