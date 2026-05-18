// biome-ignore lint/correctness/noUnresolvedImports: pragmatic-drag-and-drop 1.8.1 sub-package entry-points use per-folder package.json canon (Atlassian pattern); biome resolver doesn't traverse this. Empirically verified — tsgo typecheck OK + e2e G7-E13 drag-gesture works.
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
// biome-ignore lint/correctness/noUnresolvedImports: same canon as above (per-folder package.json sub-entry).
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { CalendarRangeIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useGridDragMoveRoomType } from '../../bookings/hooks/use-booking-transitions'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { BookingCreateSheet } from '../../bookings/components/booking-create-sheet'
import { BookingEditSheet } from '../../bookings/components/booking-edit-sheet'
import { useFitWindowDays } from '../hooks/use-fit-window-days'
import { useBookingEventsStream } from '../hooks/use-booking-events-stream'
import { useGridData } from '../hooks/use-grid-data'
import {
	channelIndicator,
	formatTourismTaxRub,
	maskGuestNameRu,
	paletteFor,
	registrationBadgeFor,
} from '../lib/booking-palette'
import { useChessboardPrefsStore } from '../lib/chessboard-prefs-store'
import { addDays, iterateDates, todayIso } from '../lib/date-range'
import {
	type FocusPosition,
	type GridNavModel,
	keyToAction,
	nextFocusPosition,
	type RowNav,
} from '../lib/keymap'
import { bandPosition } from '../lib/layout'
import { BookingBandTooltip } from './booking-band-tooltip'
import { ChessboardDatePicker } from './chessboard-date-picker'
import { ChessboardViewModeSelector } from './chessboard-view-mode-selector'
import { ChessboardWindowSelector } from './chessboard-window-selector'
import { PropertyBlockCreateSheet } from './property-block-create-sheet'
import { UnassignedPanel } from './unassigned-panel'
import { propertyBlockReasonLabels } from '../hooks/use-property-blocks'

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

export function Chessboard() {
	const windowDaysPref = useChessboardPrefsStore((state) => state.windowDays)
	const viewMode = useChessboardPrefsStore((state) => state.viewMode)
	// Outer container (M9.5 Phase B @container query host + fit measurement).
	const containerRef = useRef<HTMLElement>(null)
	const fitDays = useFitWindowDays(containerRef)
	// Phase B viewMode binding: 'month' forces 30-day window (Bnovo-parity
	// monthly aggregation) regardless of windowDays pref. 'day' uses pref.
	// Result: ToggleGroup is functional, NOT decorative UI.
	const windowDays = viewMode === 'month' ? 30 : windowDaysPref === 'fit' ? fitDays : windowDaysPref
	const [windowFrom, setWindowFrom] = useState(todayIso)
	const windowTo = useMemo(() => addDays(windowFrom, windowDays - 1), [windowFrom, windowDays])
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

	const { propertyId, propertyName, roomTypes, bookings, rooms, blocks, isLoading, isError } =
		useGridData(windowFrom, windowTo)
	// G10 (2026-05-16) — SSE real-time subscription. EventSource auto-
	// reconnects per `retry: 5000` server hint; toast + query-invalidate
	// on every booking.* event. Per R1+R2 ≥ 2026-05-16 canon.
	useBookingEventsStream({ propertyId })
	// G9 (2026-05-16) — open «Заблокировать номер» sheet from toolbar.
	const [blockCreateOpen, setBlockCreateOpen] = useState(false)

	// G9: roomId → roomTypeId map for placing OOO blocks на correct row.
	const roomTypeByRoomId = useMemo(() => {
		const m = new Map<string, string>()
		for (const r of rooms) m.set(r.id, r.roomTypeId)
		return m
	}, [rooms])

	// Pre-compute per-row band layout + navigation skeleton. Navigation
	// model is consumed by the keymap lib; render uses the same data.
	// One pass, memoized on (roomTypes, bookings, blocks, windowFrom, windowTo).
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
						assignedRoomId: string | null
						channelCode: (typeof rowBookings)[number]['channelCode']
						// G11 v3 (2026-05-18) — narrowed shape (no PII): grid query
						// projects к pre-computed `guestMask` + `isForeignCitizen`
						// (single bit, не PII per 152-ФЗ ст. 3). Raw guestSnapshot
						// NEVER reaches grid layout state.
						guestMask: string | null
						isForeignCitizen: boolean
						registrationStatus: (typeof rowBookings)[number]['registrationStatus']
						tourismTaxMicros: (typeof rowBookings)[number]['tourismTaxMicros']
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
						assignedRoomId: b.assignedRoomId ?? null,
						channelCode: b.channelCode,
						guestMask: b.guestMask,
						isForeignCitizen: b.isForeignCitizen,
						registrationStatus: b.registrationStatus,
						tourismTaxMicros: b.tourismTaxMicros,
						span,
						truncatedLeft: pos.truncatedLeft,
						truncatedRight: pos.truncatedRight,
					})
					for (let i = pos.colStart; i < pos.colEnd; i++) covered.add(i)
				}

				// G9 (2026-05-16) — OOO block bands (per-room, placed on
				// roomType row). Skip cells already occupied by booking band
				// (booking wins visually — operator sees "double-trouble" via
				// availability check banner). Multi-block-per-cell collapses
				// к latest (rare overlap edge — Bnovo accepts same trade-off).
				const blockByStart = new Map<
					number,
					{
						id: string
						roomId: string
						checkIn: string
						checkOut: string
						reason: (typeof blocks)[number]['reason']
						comment: string | null
						span: number
						truncatedLeft: boolean
						truncatedRight: boolean
					}
				>()
				const rowBlocks = blocks.filter((blk) => roomTypeByRoomId.get(blk.roomId) === rt.id)
				for (const blk of rowBlocks) {
					const pos = bandPosition(
						{ checkIn: blk.startDate, checkOut: blk.endDate },
						windowFrom,
						windowTo,
					)
					if (!pos) continue
					// Skip к next slot if a booking already covers this colStart
					if (covered.has(pos.colStart)) continue
					const span = pos.colEnd - pos.colStart
					blockByStart.set(pos.colStart, {
						id: blk.id,
						roomId: blk.roomId,
						checkIn: blk.startDate,
						checkOut: blk.endDate,
						reason: blk.reason,
						comment: blk.comment,
						span,
						truncatedLeft: pos.truncatedLeft,
						truncatedRight: pos.truncatedRight,
					})
					for (let i = pos.colStart; i < pos.colEnd; i++) covered.add(i)
				}

				return { rt, bandByStart, blockByStart, covered }
			}),
		[roomTypes, bookings, blocks, roomTypeByRoomId, windowFrom, windowTo],
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

	// G7 (2026-05-16) — Pragmatic DnD wiring: whole-band draggable →
	// rowheader drop target → mutation. Mobile gated via pointer:coarse
	// per Hostaway 2026 canon + WCAG 2.2 SC 2.5.7 (pointer-alternative =
	// ActionView amend dialog «Переместить в категорию», covered separately).
	const dragMoveMutation = useGridDragMoveRoomType(propertyId, windowFrom, windowTo)
	// biome-ignore lint/correctness/useExhaustiveDependencies: rowsLayout не referenced directly внутри effect, но drives DOM band layout via React render. Effect MUST re-run after layout change к re-wire draggables/dropTargets via querySelector (new band nodes replace old ones; stale listeners на removed nodes are GC'd but new ones need explicit wiring). React state → DOM dependency не visible to biome static analysis.
	useEffect(() => {
		if (typeof window === 'undefined') return
		const grid = gridRef.current
		if (!grid) return
		// D-G7.5 mobile gate — touch input has SC 2.5.7 pointer-alt via
		// ActionView dialog; drag-gesture suppressed.
		if (window.matchMedia('(pointer: coarse)').matches) return
		// Re-wire on every layout change (bookings list change triggers
		// rowsLayout dep → useMemo recomputes → DOM rebuild).
		const cleanups: Array<() => void> = []
		// Draggable: every band button с confirmed status. D-G7.2 locked-block
		// opt-out via querySelector filter (non-confirmed bands не получают
		// draggable).
		for (const el of grid.querySelectorAll<HTMLButtonElement>(
			'[data-booking-id][data-band-status="confirmed"]',
		)) {
			const bookingId = el.dataset.bookingId
			const sourceRoomTypeId = el.dataset.bandRoomTypeId
			if (!bookingId || !sourceRoomTypeId) continue
			cleanups.push(
				draggable({
					element: el,
					getInitialData: () => ({
						type: 'booking-band',
						bookingId,
						sourceRoomTypeId,
					}),
					onDragStart: () => {
						el.setAttribute('data-dragging', 'true')
					},
					onDrop: () => {
						el.removeAttribute('data-dragging')
					},
				}),
			)
		}
		// Drop target: each row's sticky rowheader cell (carries roomType
		// identity via data-row-room-type-id).
		for (const el of grid.querySelectorAll<HTMLElement>('[data-row-room-type-id]')) {
			const targetRoomTypeId = el.dataset.rowRoomTypeId
			if (!targetRoomTypeId) continue
			cleanups.push(
				dropTargetForElements({
					element: el,
					canDrop: ({ source }) => source.data.type === 'booking-band',
					getData: () => ({ targetRoomTypeId }),
					onDragEnter: ({ source }) => {
						// D-G7.4 conflict hint: highlight target row красным когда
						// drag-source same roomType (no-op move). Backend rejects
						// other conflicts (overlap / stopSell) с toast.
						if (source.data.sourceRoomTypeId === targetRoomTypeId) {
							el.setAttribute('data-drop-noop', 'true')
						} else {
							el.setAttribute('data-drop-active', 'true')
						}
					},
					onDragLeave: () => {
						el.removeAttribute('data-drop-active')
						el.removeAttribute('data-drop-noop')
					},
					onDrop: ({ source }) => {
						el.removeAttribute('data-drop-active')
						el.removeAttribute('data-drop-noop')
						const bookingId = source.data.bookingId
						if (typeof bookingId !== 'string') return
						if (source.data.sourceRoomTypeId === targetRoomTypeId) return
						dragMoveMutation.mutate({ bookingId, roomTypeId: targetRoomTypeId })
					},
				}),
			)
		}
		return combine(...cleanups)
	}, [rowsLayout, dragMoveMutation])

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
				<ErrorState
					title="Не удалось загрузить шахматку"
					onRetry={() => window.location.reload()}
				/>
			</main>
		)
	}

	const today = todayIso()
	const todayIdx = dates.indexOf(today)

	return (
		<main ref={containerRef} className="@container/chessboard mx-auto max-w-7xl px-6 py-8">
			{/* M9.5 Phase B: @container queries — header переключается между
			 * stack (mobile/narrow) и row layout на @md+ container width,
			 * НЕ viewport. Per plan §M9.3 + §6.7 anti-pattern (no shadcn
			 * dup): Tailwind v4 native syntax. */}
			<header className="@md/chessboard:flex-row @md/chessboard:items-center @md/chessboard:justify-between mb-4 flex flex-col gap-4">
				<div className="flex items-center gap-3">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">Шахматка</h1>
						{propertyName ? <p className="text-muted-foreground text-sm">{propertyName}</p> : null}
					</div>
					{/* G8 (2026-05-16) — UnassignedPanel в top-left position per
					    Cloudbeds 2026 canon (D-G8.1). Self-hides когда N=0. */}
					<UnassignedPanel
						propertyId={propertyId}
						windowFrom={windowFrom}
						windowTo={windowTo}
						onOpenBooking={(bookingId) => setEditingBookingId(bookingId)}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{/* G9 (2026-05-16) — open Заблокировать sheet from toolbar.
					    Visible only when property loaded (no-op без roomType ctx). */}
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setBlockCreateOpen(true)}
						disabled={!propertyId}
						data-slot="chessboard-block-create-trigger"
					>
						Заблокировать номер
					</Button>
					<ChessboardViewModeSelector />
					<ChessboardWindowSelector />
					<ChessboardDatePicker value={windowFrom} onChange={setWindowFrom} />
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setWindowFrom(addDays(windowFrom, -windowDays))}
						aria-label={`Предыдущие ${windowDays} дней`}
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
						onClick={() => setWindowFrom(addDays(windowFrom, windowDays))}
						aria-label={`Следующие ${windowDays} дней`}
					>
						Вперёд →
					</Button>
				</div>
			</header>

			{isLoading ? (
				<div className="space-y-2" role="status" aria-busy="true" aria-live="polite">
					<span className="sr-only">Загружаем шахматку</span>
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : roomTypes.length === 0 ? (
				<EmptyState
					icon={CalendarRangeIcon}
					title="Нет типов номеров"
					description="Чтобы увидеть Шахматку с бронированиями, сначала добавьте типы номеров в настройках гостиницы."
				/>
			) : (
				<div
					ref={gridRef}
					className="border-border relative overflow-x-auto rounded-lg border snap-x snap-mandatory @md/chessboard:snap-none"
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
									className={`border-border bg-muted sticky top-0 z-10 snap-start border-b p-2 text-center font-medium ${
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
						{rowsLayout.map(({ rt, bandByStart, blockByStart, covered }, rowIdx) => (
							<div key={rt.id} role="row" aria-rowindex={rowIdx + 2} className="contents">
								{/* G7 drop-target rowheader. data-drop-active fires when
								    a draggable band hovers; data-drop-noop fires when
								    source roomType == target (no-op move attempt).
								    Tailwind v4 arbitrary data-* modifiers provide visual
								    feedback per D-G7.4 (conflict highlight canon). */}
								<div
									className="border-border bg-background data-[drop-active=true]:bg-status-confirmed/15 data-[drop-active=true]:outline data-[drop-active=true]:outline-2 data-[drop-active=true]:outline-status-confirmed data-[drop-noop=true]:bg-status-past/15 data-[drop-noop=true]:outline data-[drop-noop=true]:outline-2 data-[drop-noop=true]:outline-status-past sticky left-0 z-10 border-r border-b p-2 font-medium transition-colors"
									role="rowheader"
									aria-colindex={1}
									data-row-room-type-id={rt.id}
									data-row-room-type-name={rt.name}
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
										// G2: paletteFor combines status + checkIn-vs-today
										// (overdue) + assignedRoomId-null (unassigned) per
										// TravelLine 8-color canon.
										const style = paletteFor({
											booking: {
												status: band.status,
												checkIn: band.checkIn,
												assignedRoomId: band.assignedRoomId,
											},
											todayIso: today,
										})
										// G2.bis: channel-origin differentiator dot. null когда
										// direct/walkIn (operator-originated, no clutter).
										const channel = band.channelCode ? channelIndicator(band.channelCode) : null
										// G4: RU compliance overlays. Guest mask = ALWAYS rendered
										// when snapshot present (152-ФЗ default). registrationBadge
										// + tourismTax = optional chips (null = omit). Status label
										// stays in aria-label (screen-reader semantic) + colour
										// (sighted urgency) — visible text now identifies the
										// booking, per Mews / Cloudbeds / Apaleo canon.
										// G11 v3 (2026-05-18) — `guestMask` + `isForeignCitizen` come
										// pre-computed from `use-grid-data.ts` projection on receive.
										// Raw `guestSnapshot` (PII) НЕ хранится в TanStack cache /
										// IndexedDB persister. Per 152-ФЗ data-minimization + TanStack
										// TkDodo offline-react-query canon ≥ 2026-05-18.
										const guestMask = band.guestMask
										const visibleLabel = guestMask ?? style.label
										const mvdBadge = band.registrationStatus
											? registrationBadgeFor(band.registrationStatus, band.isForeignCitizen)
											: null
										const taxRub =
											band.tourismTaxMicros !== undefined && band.status !== 'cancelled'
												? formatTourismTaxRub(band.tourismTaxMicros)
												: null
										const tabStop = isTabStop(rowIdx, ariaColIdx)
										return (
											<BookingBandTooltip
												key={`${rt.id}:${ariaColIdx}`}
												bookingId={band.id}
												statusLabel={style.label}
												roomTypeName={rt.name}
												checkIn={band.checkIn}
												checkOut={band.checkOut}
												channelLabel={channel?.label ?? null}
												// G11 v3 (2026-05-18) — full PII не cached в grid path.
												// Tooltip отображает masked name только (152-ФЗ default-mask
												// canon). Full PII доступна только в edit Sheet via
												// `useBooking(id)` detail query (NOT cached). Operator
												// clicks band → opens Sheet → fresh detail fetch.
												guestFullName={band.guestMask}
												mvdLabel={mvdBadge?.label ?? null}
												taxRub={taxRub}
											>
												{({ popoverId, onMouseEnter, onMouseLeave, onFocus, onBlur }) => (
													<button
														type="button"
														className={`focus-visible:outline-ring border-border data-[band-status=confirmed]:cursor-grab data-[dragging=true]:cursor-grabbing data-[dragging=true]:opacity-50 relative flex h-10 items-center overflow-hidden border-b px-2 text-[11px] focus:outline-2 focus:outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[box-shadow:0_0_0_4px_var(--background)] ${style.bg} ${style.text}`}
														style={{ gridColumn: `span ${band.span}` }}
														role="gridcell"
														aria-colindex={ariaColIdx}
														aria-colspan={band.span}
														aria-label={`${style.label}, ${rt.name}, ${band.checkIn} — ${band.checkOut}${
															channel ? `, ${channel.label}` : ''
														}${mvdBadge ? `, ${mvdBadge.label}` : ''}${
															taxRub ? `, туристический налог ${taxRub}` : ''
														}. Enter — открыть действия.`}
														aria-details={popoverId}
														data-booking-id={band.id}
														data-band-status={band.status}
														data-band-room-type-id={rt.id}
														data-row-idx={rowIdx}
														data-col-idx={ariaColIdx}
														tabIndex={tabStop ? 0 : -1}
														onClick={() => setEditingBookingId(band.id)}
														onMouseEnter={onMouseEnter}
														onMouseLeave={onMouseLeave}
														onBlur={onBlur}
														onFocus={() => {
															onFocus()
															setFocus({ rowIdx, colIdx: ariaColIdx })
														}}
													>
														<span className="truncate" data-band-label>
															{band.truncatedLeft ? '…' : ''}
															{visibleLabel}
															{band.truncatedRight ? '…' : ''}
														</span>
														{/* G2.bis channel dot — decorative (semantic carried в
														    aria-label above). Top-right corner, размер 6px,
														    contrast verified ≥3:1 non-text per WCAG 2.2. */}
														{channel ? (
															<span
																aria-hidden="true"
																className={`pointer-events-none absolute top-1 right-1 size-1.5 rounded-full ${channel.dotClass}`}
																data-channel-dot={band.channelCode}
															/>
														) : null}
														{/* G4 МВД badge — decorative dot top-left corner. Color-
														    coded по lifecycle state. Non-text contrast ≥3:1 per
														    WCAG 2.2 SC 1.4.11 (reuses status-* tokens — already
														    axe-verified). Semantic в aria-label выше + tooltip. */}
														{mvdBadge ? (
															<span
																aria-hidden="true"
																className={`pointer-events-none absolute top-1 left-1 size-1.5 rounded-full ${mvdBadge.dotClass}`}
																data-mvd-status={band.registrationStatus}
																data-mvd-urgent={mvdBadge.urgent ? 'true' : 'false'}
															/>
														) : null}
													</button>
												)}
											</BookingBandTooltip>
										)
									}
									// G9 (2026-05-16) — render OOO block band если starts at this col.
									const block = blockByStart.get(colIdx)
									if (block) {
										const reasonLabel = propertyBlockReasonLabels[block.reason]
										return (
											<div
												key={`${rt.id}:block:${ariaColIdx}`}
												className="border-border bg-slate-200 [background-image:repeating-linear-gradient(45deg,_rgba(100,116,139,0.25)_0_8px,_transparent_8px_16px)] border-b border-slate-400 flex h-10 items-center overflow-hidden px-2 text-[11px] text-slate-900"
												style={{ gridColumn: `span ${block.span}` }}
												role="gridcell"
												aria-colindex={ariaColIdx}
												aria-colspan={block.span}
												aria-label={`Блокировка: ${reasonLabel}, ${rt.name}, ${block.checkIn} — ${block.checkOut}${
													block.comment ? `, ${block.comment}` : ''
												}`}
												data-block-id={block.id}
												data-block-reason={block.reason}
												data-band-room-type-id={rt.id}
												data-row-idx={rowIdx}
												data-col-idx={ariaColIdx}
												data-slot="block-band"
											>
												<span className="truncate font-medium" data-slot="block-band-label">
													{reasonLabel}
												</span>
											</div>
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
				<BookingCreateSheet
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

			{/* G9 (2026-05-16) — PropertyBlockCreateSheet mounted at chessboard
			    level так single instance handles toolbar trigger. Empty initial
			    roomType так operator picks freely per Bnovo modal canon. */}
			<PropertyBlockCreateSheet
				open={blockCreateOpen}
				onOpenChange={setBlockCreateOpen}
				propertyId={propertyId}
			/>
		</main>
	)
}

function formatDateHeader(iso: string): string {
	const d = new Date(`${iso}T12:00:00Z`)
	const day = d.getUTCDate()
	const weekday = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getUTCDay()] ?? ''
	return `${day}\n${weekday}`
}
