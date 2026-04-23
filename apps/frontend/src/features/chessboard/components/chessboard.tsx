import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { BookingCreateDialog } from '../../bookings/components/booking-create-dialog'
import { BookingEditDialog } from '../../bookings/components/booking-edit-dialog'
import { useGridData } from '../hooks/use-grid-data'
import { styleFor } from '../lib/booking-palette'
import { addDays, iterateDates, todayIso } from '../lib/date-range'
import { bandPosition } from '../lib/layout'

interface ClickedCell {
	roomTypeId: string
	roomTypeName: string
	date: string
}

/**
 * Reservation grid — rooms (roomType rows) × dates (columns).
 *
 * Architecture:
 *   - roomType rows (bookings reference roomTypeId, not individual rooms —
 *     ARI allotment model; physical-room assignment happens at check-in
 *     time and isn't stored on the booking in the current domain)
 *   - 15-day default window (Bnovo 2026 default; 30-day / adaptive modes
 *     deferred until user-tested)
 *   - Today column highlighted (Cloudbeds-style visual anchor)
 *   - Booking bands are grid-column-span cells (NOT absolute overlays)
 *     with `aria-colspan={N}` and `grid-column: span N` — 2026 canonical
 *     APG pattern (React Aria + AG Grid). Band at checkIn position, next
 *     (N-1) empty-cell slots skipped in render. Mews 2026 palette.
 *
 * a11y: `role="grid"` with `aria-rowcount`/`aria-colcount` per W3C ARIA
 * APG; rowheader cells (roomType name) + columnheader row (dates). Full
 * APG keymap (Arrow/Home/End/Ctrl+Home/End) deferred to M5e when there's
 * a cell-level interaction target beyond "view".
 *
 * Scale note: CSS Grid, NOT virtualized — 30 rooms × 30 days = 900 cells
 * is trivial for the browser. Virtualization (TanStack Virtual 2D) waits
 * for chain customers with 100+ rooms.
 */

const WINDOW_DAYS = 15

export function Chessboard() {
	const [windowFrom, setWindowFrom] = useState(todayIso)
	const windowTo = useMemo(() => addDays(windowFrom, WINDOW_DAYS - 1), [windowFrom])
	const dates = useMemo(() => iterateDates(windowFrom, windowTo), [windowFrom, windowTo])
	const [clickedCell, setClickedCell] = useState<ClickedCell | null>(null)
	const [editingBookingId, setEditingBookingId] = useState<string | null>(null)

	const { propertyId, propertyName, roomTypes, bookings, isLoading, isError } = useGridData(
		windowFrom,
		windowTo,
	)

	if (isError) {
		return (
			<main className="mx-auto max-w-7xl px-6 py-10">
				<p className="text-destructive" role="alert">
					Не удалось загрузить шахматку. Проверьте соединение и обновите страницу.
				</p>
			</main>
		)
	}

	const today = todayIso()
	const todayIdx = dates.indexOf(today)

	return (
		<main className="mx-auto max-w-7xl px-6 py-8">
			<header className="mb-4 flex items-center justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Шахматка</h1>
					{propertyName ? <p className="text-muted-foreground text-sm">{propertyName}</p> : null}
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setWindowFrom(addDays(windowFrom, -WINDOW_DAYS))}
						aria-label="Предыдущие 15 дней"
					>
						← Назад
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setWindowFrom(todayIso())}
					>
						Сегодня
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setWindowFrom(addDays(windowFrom, WINDOW_DAYS))}
						aria-label="Следующие 15 дней"
					>
						Вперёд →
					</Button>
				</div>
			</header>

			{isLoading ? (
				<p className="text-muted-foreground text-sm">Загружаем…</p>
			) : roomTypes.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					Нет типов номеров. Завершите настройку гостиницы.
				</p>
			) : (
				<div
					className="border-border relative overflow-x-auto rounded-lg border"
					role="grid"
					aria-rowcount={roomTypes.length + 1}
					aria-colcount={dates.length + 1}
					aria-label={`Шахматка: ${roomTypes.length} типов номеров, ${dates.length} дней`}
				>
					<div
						className="grid text-xs"
						style={{
							gridTemplateColumns: `180px repeat(${dates.length}, minmax(40px, 1fr))`,
						}}
					>
						{/* Header row: empty corner + date columns */}
						<div
							className="border-border bg-muted sticky top-0 left-0 z-20 border-r border-b p-2 font-medium"
							role="columnheader"
							aria-colindex={1}
						>
							Тип номера
						</div>
						{dates.map((d, i) => (
							<div
								key={d}
								className={`border-border bg-muted sticky top-0 z-10 border-b p-2 text-center font-medium ${
									i === todayIdx ? 'bg-blue-100 text-blue-900' : ''
								}`}
								role="columnheader"
								aria-colindex={i + 2}
								aria-current={i === todayIdx ? 'date' : undefined}
							>
								<div>{formatDateHeader(d)}</div>
							</div>
						))}

						{/* Room-type rows. Band cells use grid-column span + aria-colspan
						    — 2026 canonical APG pattern (React Aria, AG Grid 2026).
						    NOT absolute-positioned overlays (legacy pattern that (a) leaks
						    gridcell focus targets onto neighboring dates breaking screen-
						    reader navigation per Sarah Higley 2026, and (b) confuses
						    Playwright hit-testing in sticky-header grids). */}
						{roomTypes.map((rt, rowIdx) => {
							const rowBookings = bookings.filter((b) => b.roomTypeId === rt.id)
							const bandByStart = new Map<
								number,
								{
									id: string
									status: (typeof rowBookings)[number]['status']
									checkIn: string
									checkOut: string
									span: number
									truncatedLeft: boolean
									truncatedRight: boolean
								}
							>()
							const covered = new Set<number>()
							for (const b of rowBookings) {
								const pos = bandPosition(b, windowFrom, windowTo)
								if (!pos) continue
								const span = pos.colEnd - pos.colStart
								bandByStart.set(pos.colStart, {
									id: b.id,
									status: b.status,
									checkIn: b.checkIn,
									checkOut: b.checkOut,
									span,
									truncatedLeft: pos.truncatedLeft,
									truncatedRight: pos.truncatedRight,
								})
								for (let i = pos.colStart; i < pos.colEnd; i++) covered.add(i)
							}

							return (
								<div key={rt.id} role="row" aria-rowindex={rowIdx + 2} className="contents">
									<div
										className="border-border bg-background sticky left-0 z-10 border-r border-b p-2 font-medium"
										role="rowheader"
										aria-colindex={1}
									>
										<div>{rt.name}</div>
										<div className="text-muted-foreground text-[10px]">
											{rt.inventoryCount} {rt.inventoryCount === 1 ? 'номер' : 'номеров'}
										</div>
									</div>
									{dates.map((d, colIdx) => {
										const band = bandByStart.get(colIdx)
										if (band) {
											const style = styleFor(band.status)
											return (
												<button
													key={`band-${band.id}`}
													type="button"
													className={`focus-visible:ring-ring border-border flex h-10 items-center overflow-hidden border-b px-2 text-[11px] focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none ${style.bg} ${style.text}`}
													style={{ gridColumn: `span ${band.span}` }}
													role="gridcell"
													aria-colindex={colIdx + 2}
													aria-colspan={band.span}
													aria-label={`${style.label}, ${band.checkIn} — ${band.checkOut}. Открыть действия.`}
													data-booking-id={band.id}
													onClick={() => setEditingBookingId(band.id)}
												>
													<span className="truncate">
														{band.truncatedLeft ? '…' : ''}
														{style.label}
														{band.truncatedRight ? '…' : ''}
													</span>
												</button>
											)
										}
										if (covered.has(colIdx)) return null // already spanned by band
										return (
											<button
												key={d}
												type="button"
												className={`border-border hover:bg-muted/60 focus-visible:ring-ring h-10 border-b text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none ${
													colIdx === todayIdx ? 'bg-blue-50' : ''
												}`}
												role="gridcell"
												aria-colindex={colIdx + 2}
												aria-label={`Создать бронирование: ${rt.name}, ${d}`}
												data-cell-room-type-id={rt.id}
												data-cell-date={d}
												onClick={() =>
													setClickedCell({ roomTypeId: rt.id, roomTypeName: rt.name, date: d })
												}
											/>
										)
									})}
								</div>
							)
						})}
					</div>
				</div>
			)}

			{clickedCell ? (
				<BookingCreateDialog
					open={true}
					onOpenChange={(open) => {
						if (!open) setClickedCell(null)
					}}
					propertyId={propertyId}
					roomTypeId={clickedCell.roomTypeId}
					roomTypeName={clickedCell.roomTypeName}
					checkIn={clickedCell.date}
					windowFrom={windowFrom}
					windowTo={windowTo}
				/>
			) : null}

			{editingBookingId ? (
				<BookingEditDialog
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

function formatDateHeader(iso: string): string {
	const d = new Date(`${iso}T12:00:00Z`)
	const day = d.getUTCDate()
	const weekday = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getUTCDay()] ?? ''
	return `${day}\n${weekday}`
}
