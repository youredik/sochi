import type { BookingStatus } from '@horeca/shared'
import { useMemo, useState } from 'react'
import { CalendarRangeIcon } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { BookingEditSheet } from '../../bookings/components/booking-edit-sheet'
import { useBookingEventsStream } from '../hooks/use-booking-events-stream'
import { useGridData } from '../hooks/use-grid-data'
import {
	channelIndicator,
	formatTourismTaxRub,
	paletteFor,
	registrationBadgeFor,
} from '../lib/booking-palette'
import { addDays, todayIso } from '../lib/date-range'
import {
	filterBySearch,
	filterByStatus,
	formatMobileGroupHeader,
	groupBookingsByCheckIn,
	nightsBetween,
	pluralNights,
} from '../lib/mobile-list-grouping'

/**
 * G10 (2026-05-16) — mobile-list view per R1+R2 ≥ 2026-05-16 canon
 * (Hostaway + Bnovo + Cloudbeds converged):
 *
 *   - Group-by-date headers («Сегодня» / «Завтра» / «15 мая, четверг»)
 *   - Per-card shape: channelDot + 152-ФЗ guest mask + №B-1234 + dates +
 *     (N ночей) + Room# · roomType + status / МВД / НДС badges
 *   - Sticky filter row: search (name OR booking#) + status chips +
 *     date jumpscroll («Сегодня» / «На неделе» / «На месяц»)
 *   - WCAG 2.5.5 + coarse-pointer convention: tap targets ≥44×44
 *   - Tap → existing `<BookingEditSheet>` (preserve amend flow от desktop)
 *   - SSE real-time invalidation (shared с desktop) via
 *     `useBookingEventsStream`
 *
 * Per D-G10.13: separate component (NOT responsive variant) — same data,
 * 100%-diverged interaction surface.
 */

/** Exhaustive Record<BookingStatus, string>. Adding к BookingStatus enum
 *  upstream → typecheck fails здесь until label provided. Per `[[no-hardcoding]]`. */
const STATUS_LABELS_RU: Record<BookingStatus, string> = {
	confirmed: 'Подтверждена',
	in_house: 'Заезд',
	checked_out: 'Выезд',
	cancelled: 'Отменена',
	no_show: 'Не явился',
}

const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: BookingStatus; label: string }> = [
	{ value: 'confirmed', label: 'Подтв.' },
	{ value: 'in_house', label: 'Заезд' },
	{ value: 'checked_out', label: 'Выезд' },
	{ value: 'cancelled', label: 'Отмена' },
] as const

const DATE_JUMP_OPTIONS = [
	{ label: 'Сегодня', days: 1 },
	{ label: 'Неделя', days: 7 },
	{ label: 'Месяц', days: 30 },
] as const

export function ChessboardMobile() {
	// Track date jump: today → today+N. Default «Неделя» (Hostaway canon).
	const [jumpDays, setJumpDays] = useState<number>(7)
	const [statusFilter, setStatusFilter] = useState<Set<BookingStatus>>(new Set())
	const [searchText, setSearchText] = useState('')
	const [editingBookingId, setEditingBookingId] = useState<string | null>(null)

	const today = todayIso()
	const windowFrom = today
	const windowTo = useMemo(() => addDays(today, jumpDays), [today, jumpDays])

	const { propertyId, propertyName, roomTypes, bookings, rooms, isLoading, isError } = useGridData(
		windowFrom,
		windowTo,
	)
	// G10 — SSE invalidates queries automatically when remote changes arrive.
	useBookingEventsStream({ propertyId })

	const roomTypeNameById = useMemo(() => {
		const m = new Map<string, string>()
		for (const rt of roomTypes) m.set(rt.id, rt.name)
		return m
	}, [roomTypes])

	const roomNumberById = useMemo(() => {
		const m = new Map<string, string>()
		for (const r of rooms) m.set(r.id, r.number)
		return m
	}, [rooms])

	const filtered = useMemo(() => {
		const byStatus = filterByStatus(bookings, statusFilter)
		return filterBySearch(
			byStatus,
			// G11 v3 (2026-05-18) — `guestMask` pre-computed via queryFn projection
			// (raw guestSnapshot не cached). Search by mask + bookingId.
			(b) => `${b.guestMask ?? ''} ${b.id}`,
			searchText,
		)
	}, [bookings, statusFilter, searchText])

	const groups = useMemo(() => groupBookingsByCheckIn(filtered), [filtered])

	function toggleStatus(value: BookingStatus) {
		setStatusFilter((prev) => {
			const next = new Set(prev)
			if (next.has(value)) next.delete(value)
			else next.add(value)
			return next
		})
	}

	if (isError) {
		return (
			<main className="mx-auto max-w-md px-4 py-6">
				<ErrorState title="Не удалось загрузить брони" onRetry={() => window.location.reload()} />
			</main>
		)
	}

	return (
		<main className="mx-auto max-w-2xl px-4 py-4" data-slot="chessboard-mobile">
			<header className="mb-3">
				<h1 className="text-xl font-semibold tracking-tight">Брони</h1>
				{propertyName ? <p className="text-muted-foreground text-sm">{propertyName}</p> : null}
			</header>

			{/* Sticky filter row (D-G10.14). Min target 44×44 per WCAG 2.5.5. */}
			<div
				className="sticky top-0 z-10 bg-background pb-3 -mx-4 px-4 border-b border-border space-y-2"
				data-slot="mobile-filter-row"
			>
				<input
					type="search"
					value={searchText}
					onChange={(e) => setSearchText(e.target.value)}
					placeholder="Поиск: фамилия или №B-…"
					className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
					data-slot="mobile-search-input"
					aria-label="Поиск по броням"
				/>
				<div
					className="flex gap-2 overflow-x-auto -mx-1 px-1"
					data-slot="mobile-status-chips"
					role="group"
					aria-label="Фильтр по статусу"
				>
					{STATUS_FILTER_OPTIONS.map((opt) => {
						const active = statusFilter.has(opt.value)
						return (
							<button
								key={opt.value}
								type="button"
								onClick={() => toggleStatus(opt.value)}
								className={`min-h-11 min-w-16 rounded-full border px-3 text-xs whitespace-nowrap transition-colors ${
									active
										? 'bg-primary text-primary-foreground border-primary'
										: 'bg-background border-border'
								}`}
								data-active={active}
								data-status-chip={opt.value}
								aria-pressed={active}
							>
								{opt.label}
							</button>
						)
					})}
				</div>
				<div
					className="flex gap-2"
					data-slot="mobile-date-jump"
					role="radiogroup"
					aria-label="Период"
				>
					{DATE_JUMP_OPTIONS.map((opt) => {
						const active = jumpDays === opt.days
						return (
							<button
								key={opt.days}
								type="button"
								onClick={() => setJumpDays(opt.days)}
								className={`min-h-11 flex-1 rounded-md border px-3 text-sm transition-colors ${
									active
										? 'bg-primary text-primary-foreground border-primary'
										: 'bg-background border-border'
								}`}
								data-active={active}
								data-jump-days={opt.days}
								role="radio"
								aria-checked={active}
							>
								{opt.label}
							</button>
						)
					})}
				</div>
			</div>

			{isLoading ? (
				<div className="space-y-2 pt-3" role="status" aria-busy="true" aria-live="polite">
					<span className="sr-only">Загружаем брони</span>
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-20 w-full" />
				</div>
			) : groups.length === 0 ? (
				<div className="pt-6">
					<EmptyState
						icon={CalendarRangeIcon}
						title="Нет броней"
						description="На выбранный период бронирований не найдено."
					/>
				</div>
			) : (
				<ol
					className="space-y-4 pt-3"
					data-slot="mobile-booking-list"
					aria-label={`${filtered.length} бронирований`}
				>
					{groups.map((g) => (
						<li key={g.dateKey}>
							<h2
								className="text-muted-foreground text-xs font-semibold uppercase tracking-wide mb-2 px-1"
								data-slot="mobile-group-header"
								data-date-key={g.dateKey}
							>
								{formatMobileGroupHeader(g.dateKey, today)}
							</h2>
							<ul className="space-y-2">
								{g.bookings.map((b) => {
									// G11 v3 (2026-05-18) — narrow GridBooking shape (no PII).
									// `guestMask` + `isForeignCitizen` pre-computed via queryFn
									// projection. Raw guestSnapshot не cached.
									const guestMask = b.guestMask ?? '—'
									const num = (b.id ?? '').slice(-6).toUpperCase()
									const palette = paletteFor({
										booking: {
											status: b.status,
											checkIn: b.checkIn,
											assignedRoomId: b.assignedRoomId ?? null,
										},
										todayIso: today,
									})
									const channel = b.channelCode ? channelIndicator(b.channelCode) : null
									const mvd = b.registrationStatus
										? registrationBadgeFor(b.registrationStatus, b.isForeignCitizen)
										: null
									const tax =
										b.tourismTaxMicros !== undefined && b.status !== 'cancelled'
											? formatTourismTaxRub(b.tourismTaxMicros)
											: null
									const nights = nightsBetween(b.checkIn, b.checkOut)
									const rtName = roomTypeNameById.get(b.roomTypeId) ?? '—'
									const roomNum = b.assignedRoomId ? roomNumberById.get(b.assignedRoomId) : null
									// b.status is BookingStatus per GridBooking shape (use-grid-data.ts).
									// Exhaustive record means no fallback needed — typecheck enforces.
									const statusLabel = STATUS_LABELS_RU[b.status]
									return (
										<li key={b.id}>
											<button
												type="button"
												onClick={() => setEditingBookingId(b.id)}
												className={`block w-full min-h-[44px] rounded-lg border border-border p-3 text-left focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${palette.bg} ${palette.text}`}
												data-slot="mobile-booking-card"
												data-booking-id={b.id}
												data-band-status={b.status}
												aria-label={`${statusLabel}. ${guestMask}, №${num}, заезд ${b.checkIn} — выезд ${b.checkOut}.`}
											>
												<div className="flex items-center justify-between gap-2 mb-1">
													<div className="flex items-center gap-2 min-w-0 flex-1">
														{channel ? (
															<span
																aria-hidden="true"
																className={`inline-block size-2.5 rounded-full shrink-0 ${channel.dotClass}`}
																data-channel-dot={b.channelCode}
															/>
														) : null}
														<span className="font-medium truncate" data-slot="mobile-card-guest">
															{guestMask}
														</span>
													</div>
													<span
														className="text-xs tabular-nums shrink-0"
														data-slot="mobile-card-booking-number"
													>
														№{num}
													</span>
												</div>
												<div
													className="text-xs text-muted-foreground mb-1"
													data-slot="mobile-card-dates"
												>
													{b.checkIn} → {b.checkOut} · {nights} {pluralNights(nights)}
												</div>
												{roomNum || rtName ? (
													<div
														className="text-xs text-muted-foreground mb-1"
														data-slot="mobile-card-room"
													>
														{roomNum ? `№ ${roomNum} · ` : ''}
														{rtName}
													</div>
												) : null}
												<div className="flex gap-1 flex-wrap">
													<span
														className={`text-[10px] px-1.5 py-0.5 rounded ${palette.bg} ${palette.text} border border-current/20`}
														data-slot="mobile-card-status-badge"
													>
														{statusLabel}
													</span>
													{mvd ? (
														<span
															className={`text-[10px] px-1.5 py-0.5 rounded ${mvd.dotClass}`}
															data-mvd-status={b.registrationStatus}
														>
															МВД: {mvd.label}
														</span>
													) : null}
													{tax ? (
														<span
															className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-foreground"
															data-slot="mobile-card-tax-badge"
														>
															ТН: {tax}
														</span>
													) : null}
												</div>
											</button>
										</li>
									)
								})}
							</ul>
						</li>
					))}
				</ol>
			)}

			{editingBookingId ? (
				<BookingEditSheet
					open={true}
					onOpenChange={(open) => {
						if (!open) setEditingBookingId(null)
					}}
					bookingId={editingBookingId}
					propertyId={propertyId}
					windowFrom={windowFrom}
					windowTo={windowTo}
				/>
			) : null}
		</main>
	)
}
