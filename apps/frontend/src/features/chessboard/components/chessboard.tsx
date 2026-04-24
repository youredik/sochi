import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { BookingCreateDialog } from '../../bookings/components/booking-create-dialog'
import { BookingEditDialog } from '../../bookings/components/booking-edit-dialog'
import { useGridData } from '../hooks/use-grid-data'
import { styleFor } from '../lib/booking-palette'
import { addDays, iterateDates, todayIso } from '../lib/date-range'
import {
	type FocusPosition,
	type GridNavModel,
	keyToAction,
	nextFocusPosition,
	type RowNav,
} from '../lib/keymap'
import { bandPosition } from '../lib/layout'

interface ClickedCell {
	roomTypeId: string
	roomTypeName: string
	date: string
}

// PageUp/Down jump — APG permits author choice; 5 rows = viewport
// approximation for a 5-30-room tenant.
const PAGE_STEP = 5

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
 * APG keymap wired (M5e.3): Arrow/Home/End/Ctrl+Home/End/PageUp/PageDown
 * via roving tabindex (useState + imperative .focus() in useEffect per
 * 2026 React Aria canonical). Enter/Space activate cells natively via
 * native `<button>` behavior. WCAG 2.2 SC 2.4.11 Focus Not Obscured
 * satisfied via `scroll-padding-top/left` reserving sticky header space.
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
	// Roving-tabindex focus state (W3C APG 2026 canonical). Null until the
	// user explicitly enters the grid (Tab-in or cell click); initial Tab
	// from outside lands on the (0,0) cell because that's the one with
	// tabIndex=0 when focus is null.
	const [focus, setFocus] = useState<FocusPosition | null>(null)
	// Grid container ref — used to locate cells via data-attribute
	// querySelector in the focus-sync effect. Simpler + allocation-free
	// vs per-cell callback refs that re-register on every render.
	const gridRef = useRef<HTMLDivElement>(null)

	const { propertyId, propertyName, roomTypes, bookings, isLoading, isError } = useGridData(
		windowFrom,
		windowTo,
	)

	// Pre-compute per-row band layout + navigation skeleton. Navigation
	// model is consumed by the keymap lib; render uses the same data.
	// One pass, memoized on (roomTypes, bookings, windowFrom, windowTo).
	const rowsLayout = useMemo(
		() =>
			roomTypes.map((rt) => {
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
				return { rt, bandByStart, covered }
			}),
		[roomTypes, bookings, windowFrom, windowTo],
	)

	const navModel: GridNavModel = useMemo(() => {
		const rows: RowNav[] = rowsLayout.map(({ bandByStart, covered }) => {
			const starts: number[] = []
			const spans: number[] = []
			for (let colIdx = 0; colIdx < dates.length; colIdx++) {
				const band = bandByStart.get(colIdx)
				if (band) {
					// aria-colindex of band = colIdx+2 (col 1 is rowheader)
					starts.push(colIdx + 2)
					spans.push(band.span)
				} else if (!covered.has(colIdx)) {
					starts.push(colIdx + 2)
					spans.push(1)
				}
			}
			return { cellStarts: starts, cellSpans: spans }
		})
		return { rows, pageStep: PAGE_STEP }
	}, [rowsLayout, dates.length])

	// Imperative focus sync: when `focus` changes, query the cell by its
	// data-row-idx/data-col-idx attributes and call .focus(). Per 2026
	// APG + React Aria canonical pattern. Programmatic .focus() does NOT
	// trigger :focus-visible (only user gestures do) — our CSS uses :focus
	// (not :focus-visible only) to cover keyboard-driven moves too.
	useEffect(() => {
		if (!focus || !gridRef.current) return
		const el = gridRef.current.querySelector<HTMLButtonElement>(
			`[data-row-idx="${focus.rowIdx}"][data-col-idx="${focus.colIdx}"]`,
		)
		el?.focus()
	}, [focus])

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		const action = keyToAction(e)
		if (!action) return
		if (!focus) return
		e.preventDefault()
		const next = nextFocusPosition(navModel, focus, action)
		if (next.rowIdx !== focus.rowIdx || next.colIdx !== focus.colIdx) {
			setFocus(next)
		}
	}

	// Initial roving focus target: (0, first-col-of-row-0). Used to
	// decide which cell gets tabIndex=0 when `focus === null` (pre-entry).
	const initialTabIdx = useMemo<FocusPosition | null>(() => {
		const row0 = navModel.rows[0]
		const firstCol = row0?.cellStarts[0]
		if (firstCol === undefined) return null
		return { rowIdx: 0, colIdx: firstCol }
	}, [navModel])

	const isTabStop = (rowIdx: number, colIdx: number): boolean => {
		const target = focus ?? initialTabIdx
		return target !== null && target.rowIdx === rowIdx && target.colIdx === colIdx
	}

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
					ref={gridRef}
					className="border-border relative overflow-x-auto rounded-lg border"
					role="grid"
					aria-rowcount={roomTypes.length + 1}
					aria-colcount={dates.length + 1}
					aria-label={`Шахматка: ${roomTypes.length} типов номеров, ${dates.length} дней`}
					style={{
						// WCAG 2.2 SC 2.4.11 Focus Not Obscured (AA, required for
						// 152-ФЗ). Sticky col/row headers must not fully cover a
						// focused cell after Ctrl+Home / PageDown jumps. scroll-
						// padding reserves space equal to sticky header sizes.
						scrollPaddingTop: '40px',
						scrollPaddingLeft: '180px',
					}}
					onKeyDown={handleKeyDown}
				>
					<div
						className="grid text-xs"
						style={{
							gridTemplateColumns: `180px repeat(${dates.length}, minmax(40px, 1fr))`,
						}}
					>
						{/* Header row: empty corner + date columns. WRAPPED in
						    role="row" — WCAG 1.3.1 requires gridcell/columnheader
						    direct parent to be role="row". The wrapper uses CSS
						    `display: contents` so its children continue to lay
						    out as direct grid items (CSS grid ≠ ARIA structure). */}
						<div role="row" aria-rowindex={1} className="contents">
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
						</div>

						{/* Room-type rows. Band cells use grid-column span + aria-colspan
						    — 2026 canonical APG pattern (React Aria, AG Grid 2026).
						    NOT absolute-positioned overlays (legacy pattern that (a) leaks
						    gridcell focus targets onto neighboring dates breaking screen-
						    reader navigation per Sarah Higley 2026, and (b) confuses
						    Playwright hit-testing in sticky-header grids). */}
						{rowsLayout.map(({ rt, bandByStart, covered }, rowIdx) => (
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
									const ariaColIdx = colIdx + 2
									const band = bandByStart.get(colIdx)
									if (band) {
										const style = styleFor(band.status)
										const tabStop = isTabStop(rowIdx, ariaColIdx)
										return (
											<button
												key={`${rt.id}:${ariaColIdx}`}
												type="button"
												className={`focus-visible:outline-ring border-border flex h-10 items-center overflow-hidden border-b px-2 text-[11px] focus:outline-2 focus:outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[box-shadow:0_0_0_4px_var(--background)] ${style.bg} ${style.text}`}
												style={{ gridColumn: `span ${band.span}` }}
												role="gridcell"
												aria-colindex={ariaColIdx}
												aria-colspan={band.span}
												aria-label={`${style.label}, ${rt.name}, ${band.checkIn} — ${band.checkOut}. Enter — открыть действия.`}
												data-booking-id={band.id}
												data-row-idx={rowIdx}
												data-col-idx={ariaColIdx}
												tabIndex={tabStop ? 0 : -1}
												onClick={() => setEditingBookingId(band.id)}
												onFocus={() => setFocus({ rowIdx, colIdx: ariaColIdx })}
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
									const tabStop = isTabStop(rowIdx, ariaColIdx)
									return (
										<button
											key={`${rt.id}:${ariaColIdx}`}
											type="button"
											className={`border-border hover:bg-muted/60 focus-visible:outline-ring h-10 border-b text-left transition-colors focus:outline-2 focus:outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[box-shadow:0_0_0_4px_var(--background)] ${
												colIdx === todayIdx ? 'bg-blue-50' : ''
											}`}
											role="gridcell"
											aria-colindex={ariaColIdx}
											aria-label={`Свободно, ${rt.name}, ${d}. Enter — создать бронь.`}
											data-cell-room-type-id={rt.id}
											data-cell-date={d}
											data-row-idx={rowIdx}
											data-col-idx={ariaColIdx}
											tabIndex={tabStop ? 0 : -1}
											onClick={() =>
												setClickedCell({ roomTypeId: rt.id, roomTypeName: rt.name, date: d })
											}
											onFocus={() => setFocus({ rowIdx, colIdx: ariaColIdx })}
										/>
									)
								})}
							</div>
						))}
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
