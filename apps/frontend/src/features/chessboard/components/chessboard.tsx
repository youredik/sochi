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
import { bandPosition, ROW_HEADER_WIDTH } from '../lib/layout'
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
	//
	// G11 v3.5 (2026-05-18) — **Lane assignment via interval-graph coloring**.
	// Pre-fix `bandByStart: Map<colStart, band>` silently overwrote bookings
	// с identical checkIn → одна booking dropped on render. Plus CSS Grid
	// auto-place spawned implicit rows для overlapping bands w/o `gridRow` →
	// cross-row contamination via `display:contents`. Per agent research
	// ≥ 2026-05-18 + Apaleo/Mews/Bnovo industry canon.
	//
	// Algorithm: sort bookings by (checkIn, id); for each, assign lowest-free
	// lane such that no earlier band в that lane overlaps (laneEnds[lane] >
	// colStart blocks). Result: explicit `lane` per band → explicit `gridRow`
	// в render. No more silent drops, no more cross-row drift.
	const rowsLayout = useMemo(
		() =>
			roomTypes.map((rt) => {
				const rowBookings = bookings.filter((b) => b.roomTypeId === rt.id)
				type Band = {
					id: string
					status: (typeof rowBookings)[number]['status']
					checkIn: string
					checkOut: string
					assignedRoomId: string | null
					channelCode: (typeof rowBookings)[number]['channelCode']
					guestMask: string | null
					isForeignCitizen: boolean
					registrationStatus: (typeof rowBookings)[number]['registrationStatus']
					tourismTaxMicros: (typeof rowBookings)[number]['tourismTaxMicros']
					colStart: number
					span: number
					truncatedLeft: boolean
					truncatedRight: boolean
					lane: number
				}
				const positioned: Array<{
					b: (typeof rowBookings)[number]
					pos: NonNullable<ReturnType<typeof bandPosition>>
				}> = []
				for (const b of rowBookings) {
					const pos = bandPosition(b, windowFrom, windowTo)
					if (pos) positioned.push({ b, pos })
				}
				// Sort by checkIn ASC (colStart proxy), id ASC для deterministic
				// tiebreak (same-checkIn overlapping bookings always get same lane
				// assignment across re-renders → React reconciliation stable).
				positioned.sort((a, b) => {
					if (a.pos.colStart !== b.pos.colStart) return a.pos.colStart - b.pos.colStart
					return a.b.id < b.b.id ? -1 : 1
				})
				const laneEnds: number[] = []
				const bands: Band[] = []
				for (const { b, pos } of positioned) {
					// Find lowest lane чьё last-end <= colStart (no overlap)
					let lane = 0
					while (lane < laneEnds.length && (laneEnds[lane] ?? 0) > pos.colStart) {
						lane += 1
					}
					laneEnds[lane] = pos.colEnd
					bands.push({
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
						colStart: pos.colStart,
						span: pos.colEnd - pos.colStart,
						truncatedLeft: pos.truncatedLeft,
						truncatedRight: pos.truncatedRight,
						lane,
					})
				}
				const maxLane = Math.max(1, laneEnds.length)

				// G9 (2026-05-16) — OOO block bands (per-room, placed on
				// roomType row). Skip cells already occupied by booking band
				// (booking wins visually — operator sees "double-trouble" via
				// availability check banner). Multi-block-per-cell collapses
				// к latest (rare overlap edge — Bnovo accepts same trade-off).
				// Booking-covered cells (any lane) — used к suppress block overlap.
				const bookingCovered = new Set<number>()
				for (const band of bands) {
					for (let i = band.colStart; i < band.colStart + band.span; i++) {
						bookingCovered.add(i)
					}
				}

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
				const blockCovered = new Set<number>()
				for (const blk of rowBlocks) {
					const pos = bandPosition(
						{ checkIn: blk.startDate, checkOut: blk.endDate },
						windowFrom,
						windowTo,
					)
					if (!pos) continue
					// Skip к next slot if a booking already covers this colStart
					if (bookingCovered.has(pos.colStart)) continue
					if (blockCovered.has(pos.colStart)) continue
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
					for (let i = pos.colStart; i < pos.colEnd; i++) blockCovered.add(i)
				}

				return { rt, bands, blockByStart, maxLane, bookingCovered, blockCovered }
			}),
		[roomTypes, bookings, blocks, roomTypeByRoomId, windowFrom, windowTo],
	)

	// Compute cumulative grid-row offsets per roomType. Row 1 = header,
	// row 2..N = each roomType spans `maxLane` grid rows.
	const rowsWithOffsets = useMemo(() => {
		let cumulativeRow = 2
		return rowsLayout.map((row) => {
			const gridRowOffset = cumulativeRow
			cumulativeRow += row.maxLane
			return { ...row, gridRowOffset }
		})
	}, [rowsLayout])

	const navModel: GridNavModel = useMemo(() => {
		const rows: RowNav[] = rowsLayout.map(({ bands, bookingCovered, blockCovered }) => {
			const starts: number[] = []
			const spans: number[] = []
			// Bands in lane 0 act as «primary» row-keyboard targets per APG canon
			// (Sarah Higley 2026 «Grids Part 2»). Other lanes are reachable via
			// arrow-down within same column.
			const lane0Bands = new Map<number, number>() // colStart → span
			for (const band of bands) {
				if (band.lane === 0) lane0Bands.set(band.colStart, band.span)
			}
			for (let colIdx = 0; colIdx < dates.length; colIdx++) {
				const span = lane0Bands.get(colIdx)
				if (span !== undefined) {
					starts.push(colIdx + 2)
					spans.push(span)
				} else if (!bookingCovered.has(colIdx) && !blockCovered.has(colIdx)) {
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
						scrollPaddingLeft: `${ROW_HEADER_WIDTH}px`,
					}}
					onKeyDown={handleKeyDown}
				>
					<div
						className="grid text-xs"
						style={{
							// G11 v3.3 (2026-05-18) — `minmax(180px, 180px)` defends
							// track против Chrome 130+ `@container` constrained-context
							// collapse (per CSS Grid Level 2 §11 free-space algorithm +
							// agent research ≥ 2026-05-17). Bare `180px` reduced к
							// min-content (~60px) когда `180 + N×40` exceeded container,
							// label «Люкс 1 10 номеров» wrapped к 4 lines, row-height
							// blowout cascade. Day columns `minmax(0, 1fr)` (NOT `40px`)
							// per WebKit 1fr-collapse fix — JS fit math already enforces
							// 40px floor by construction. See `lib/layout.ts` constants.
							gridTemplateColumns: `minmax(${ROW_HEADER_WIDTH}px, ${ROW_HEADER_WIDTH}px) repeat(${dates.length}, minmax(0, 1fr))`,
							// G11 v3.5 (2026-05-18) — Lock implicit-row height к 40px so
							// lane-stacked overlapping bands have predictable height.
							// Each lane = one CSS grid row. Per agent research §1 + MDN
							// `grid-auto-rows` canon: without this, implicit rows fall к
							// `auto` → tall band content (truncated label wrapping) silently
							// grows row, cascade-affecting all rows downstream via
							// `display: contents` row wrappers.
							//
							// G11 v3.6 (2026-05-18 second fix) — Header row needs explicit
							// 48px минимум (2-line «18\nпн» content + p-2 padding overflows
							// 40px). Empirically caught когда text-xs line-height collapsed
							// header content в lane 2 area covering bands. `gridTemplateRows`
							// specifies row 1 = 48px; subsequent rows fall к gridAutoRows.
							gridTemplateRows: '48px',
							gridAutoRows: '40px',
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
						{rowsWithOffsets.map(
							(
								{ rt, bands, blockByStart, maxLane, bookingCovered, blockCovered, gridRowOffset },
								rowIdx,
							) => (
								<div key={rt.id} role="row" aria-rowindex={rowIdx + 2} className="contents">
									{/* G7 drop-target rowheader. G11 v3.5 (2026-05-18) — spans
								    `maxLane` grid rows so visible height matches lane stack. */}
									<div
										className="border-border bg-background data-[drop-active=true]:bg-status-confirmed/15 data-[drop-active=true]:outline data-[drop-active=true]:outline-2 data-[drop-active=true]:outline-status-confirmed data-[drop-noop=true]:bg-status-past/15 data-[drop-noop=true]:outline data-[drop-noop=true]:outline-2 data-[drop-noop=true]:outline-status-past sticky left-0 z-10 min-w-0 overflow-hidden border-r border-b p-2 font-medium transition-colors"
										role="rowheader"
										aria-colindex={1}
										data-row-room-type-id={rt.id}
										data-row-room-type-name={rt.name}
										style={{
											gridColumn: 1,
											gridRow: `${gridRowOffset} / span ${maxLane}`,
										}}
									>
										<div className="truncate" title={rt.name}>
											{rt.name}
										</div>
										<div className="text-muted-foreground truncate text-[10px]">
											{rt.inventoryCount} {rt.inventoryCount === 1 ? 'номер' : 'номеров'}
										</div>
									</div>
									{/* Empty cells per date — span ALL lanes of this row (gridRow
								    spans maxLane). Bands overlay specific lanes via higher
								    z-index. Click on empty cell → create booking. */}
									{dates.map((d, colIdx) => {
										const ariaColIdx = colIdx + 2
										// Suppress empty cell когда entire row covered by band на col
										// (any lane) AND row is single-lane — no operator interaction
										// possible. Multi-lane rows always render empty backdrop.
										if (maxLane === 1 && bookingCovered.has(colIdx)) return null
										if (maxLane === 1 && blockCovered.has(colIdx)) return null
										const tabStop = isTabStop(rowIdx, ariaColIdx)
										return (
											<button
												key={`${rt.id}:empty:${ariaColIdx}`}
												type="button"
												className={`border-border hover:bg-muted/60 focus-visible:outline-ring border-b text-left transition-colors focus:outline-2 focus:outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[box-shadow:0_0_0_4px_var(--background)] ${
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
												style={{
													gridColumn: ariaColIdx,
													gridRow: `${gridRowOffset} / span ${maxLane}`,
												}}
												onClick={() =>
													setClickedCell({ roomTypeId: rt.id, roomTypeName: rt.name, date: d })
												}
												onFocus={() => setFocus({ rowIdx, colIdx: ariaColIdx })}
											/>
										)
									})}
									{/* Booking bands — explicit gridColumn + gridRow per band.
								    Lane assigned via interval-graph coloring. z-index above
								    empty backdrop. */}
									{bands.map((band) => {
										const ariaColIdx = band.colStart + 2
										const style = paletteFor({
											booking: {
												status: band.status,
												checkIn: band.checkIn,
												assignedRoomId: band.assignedRoomId,
											},
											todayIso: today,
										})
										const channel = band.channelCode ? channelIndicator(band.channelCode) : null
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
												key={`${rt.id}:band:${band.id}`}
												bookingId={band.id}
												statusLabel={style.label}
												roomTypeName={rt.name}
												checkIn={band.checkIn}
												checkOut={band.checkOut}
												channelLabel={channel?.label ?? null}
												guestFullName={band.guestMask}
												mvdLabel={mvdBadge?.label ?? null}
												taxRub={taxRub}
											>
												{({ popoverId, onMouseEnter, onMouseLeave, onFocus, onBlur }) => (
													<button
														type="button"
														className={`focus-visible:outline-ring border-border data-[band-status=confirmed]:cursor-grab data-[dragging=true]:cursor-grabbing data-[dragging=true]:opacity-50 relative flex min-w-0 items-center overflow-hidden border-b px-2 text-[11px] focus:outline-2 focus:outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[box-shadow:0_0_0_4px_var(--background)] ${style.bg} ${style.text}`}
														// G11 v3.5 (2026-05-18) — Explicit gridColumn + gridRow.
														// gridRow = gridRowOffset + band.lane pins band к its
														// assigned lane within the row's lane stack. min-w-0 на
														// button defends против label-overflow pushing track wider
														// (DEV.to/CSS-Tricks canon — flex/grid children need
														// explicit min-w-0 для ellipsis к engage).
														style={{
															gridColumn: `${ariaColIdx} / span ${band.span}`,
															gridRow: gridRowOffset + band.lane,
															zIndex: 1,
														}}
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
														data-band-lane={band.lane}
														data-row-idx={rowIdx}
														data-col-idx={ariaColIdx}
														tabIndex={tabStop ? 0 : -1}
														onClick={() => setEditingBookingId(band.id)}
														onMouseEnter={onMouseEnter}
														onMouseLeave={onMouseLeave}
														onBlur={onBlur}
														onFocus={(e) => {
															onFocus(e)
															setFocus({ rowIdx, colIdx: ariaColIdx })
														}}
													>
														<span className="truncate" data-band-label>
															{band.truncatedLeft ? '…' : ''}
															{visibleLabel}
															{band.truncatedRight ? '…' : ''}
														</span>
														{channel ? (
															<span
																aria-hidden="true"
																className={`pointer-events-none absolute top-1 right-1 size-1.5 rounded-full ${channel.dotClass}`}
																data-channel-dot={band.channelCode}
															/>
														) : null}
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
									})}
									{/* OOO block bands — render at lane 0 (booking-covered cells
								    suppressed via bookingCovered guard above). */}
									{Array.from(blockByStart.entries()).map(([colIdx, block]) => {
										const ariaColIdx = colIdx + 2
										const reasonLabel = propertyBlockReasonLabels[block.reason]
										return (
											<div
												key={`${rt.id}:block:${block.id}`}
												className="border-border bg-slate-200 [background-image:repeating-linear-gradient(45deg,_rgba(100,116,139,0.25)_0_8px,_transparent_8px_16px)] border-b border-slate-400 flex min-w-0 items-center overflow-hidden px-2 text-[11px] text-slate-900"
												style={{
													gridColumn: `${ariaColIdx} / span ${block.span}`,
													gridRow: gridRowOffset,
													zIndex: 1,
												}}
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
									})}
								</div>
							),
						)}
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
