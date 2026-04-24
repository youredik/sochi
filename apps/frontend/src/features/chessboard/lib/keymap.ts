/**
 * Reservation-grid keyboard navigation — pure functions (M5e.3).
 *
 * Implements W3C ARIA APG "Grid" pattern keymap verbatim (fetched
 * 2026-04-24, unchanged from 2024 spec):
 *
 *   ArrowLeft/Right    — one cell in row (no wrap per data-grid rule)
 *   ArrowUp/Down       — one cell across rows (no wrap)
 *   Home               — first cell in current row
 *   End                — last cell in current row
 *   Ctrl+Home          — first cell in grid
 *   Ctrl+End           — last cell in grid
 *   PageUp/PageDown    — author-chosen row-count jump (we use 5 rows)
 *
 * Activation (Enter/Space) is handled natively by `<button>` cells —
 * browsers dispatch `click` on Enter/Space → our onClick fires.
 *
 * Colspan-aware navigation: booking bands span N visible dates via
 * `aria-colspan={N}` starting at aria-colindex K. Right from K jumps to
 * K+N (the cell AFTER the span); Left from K+N lands back on the band.
 * Up/Down from a col covered by a band land on the band at its starting
 * col (screen readers never announce a "middle" column of a colspan).
 *
 * Pure + total — every position pre-computation lives in `GridNavModel`.
 * Callers build the model once per render from their row/band data,
 * then query it cheaply per keystroke.
 */

export type NavAction =
	| 'left'
	| 'right'
	| 'up'
	| 'down'
	| 'home'
	| 'end'
	| 'ctrl-home'
	| 'ctrl-end'
	| 'page-up'
	| 'page-down'

export interface FocusPosition {
	readonly rowIdx: number // 0-based row (0 = first roomType row)
	readonly colIdx: number // aria-colindex STARTING position of the focused cell
}

/**
 * Per-row navigation skeleton. `cellStarts` = sorted aria-colindex
 * positions for the row (every position where a cell BEGINS — empty
 * cells are width-1, bands are width-N but only the start counts).
 * `cellSpans` = parallel array: span of the cell starting at cellStarts[i].
 */
export interface RowNav {
	readonly cellStarts: readonly number[] // ascending
	readonly cellSpans: readonly number[] // same length as cellStarts
}

export interface GridNavModel {
	readonly rows: readonly RowNav[]
	readonly pageStep: number // rows to jump on PageUp/PageDown
}

/**
 * Map a raw `KeyboardEvent` to a NavAction (or null if the key isn't
 * a recognized navigation key). Ignores repeat events? — NO, APG spec
 * intentionally allows key-repeat to keep moving focus; we surface
 * every keydown.
 *
 * Modifier strictness: Ctrl+Home/End match only when ctrlKey OR metaKey
 * (macOS Cmd = the same semantic in every 2026 browser). Other nav
 * keys require NO modifiers — prevents collision with browser shortcuts
 * (Ctrl+ArrowLeft = word-jump in address bar; Shift+Home = select).
 */
export function keyToAction(event: {
	key: string
	ctrlKey: boolean
	metaKey: boolean
	shiftKey: boolean
	altKey: boolean
}): NavAction | null {
	// Reject Shift/Alt-modified navigation — those are select-extend or
	// OS shortcuts, not grid navigation.
	if (event.shiftKey || event.altKey) return null
	const ctrl = event.ctrlKey || event.metaKey
	switch (event.key) {
		case 'ArrowLeft':
			return ctrl ? null : 'left'
		case 'ArrowRight':
			return ctrl ? null : 'right'
		case 'ArrowUp':
			return ctrl ? null : 'up'
		case 'ArrowDown':
			return ctrl ? null : 'down'
		case 'Home':
			return ctrl ? 'ctrl-home' : 'home'
		case 'End':
			return ctrl ? 'ctrl-end' : 'end'
		case 'PageUp':
			return ctrl ? null : 'page-up'
		case 'PageDown':
			return ctrl ? null : 'page-down'
		default:
			return null
	}
}

/**
 * Compute the next focus position given the current one + the nav
 * action. Returns the SAME position if the action would move off-grid
 * (no wrap, clamping is APG-correct for data grids).
 *
 * `colIdx` in the input MAY be a "middle" column of a colspan band
 * (e.g. user came from Up-arrow landing on a cell that logically maps
 * to a band region). Up/Down resolve to the band's START; Left/Right
 * also resolve first, then advance.
 */
export function nextFocusPosition(
	model: GridNavModel,
	current: FocusPosition,
	action: NavAction,
): FocusPosition {
	if (model.rows.length === 0) return current

	// Absolute-position actions ignore current position entirely — handle
	// FIRST so stale/invalid `current.rowIdx` (e.g. caller had row 5 in
	// state but roomType was deleted, shrinking grid to 3 rows) still
	// lands correctly. Without this, ctrl-home/end would fall through to
	// the `if (!row) return current` guard and silently no-op.
	if (action === 'ctrl-home') {
		const firstRow = model.rows[0]
		const firstCol = firstRow?.cellStarts[0]
		return firstCol !== undefined ? { rowIdx: 0, colIdx: firstCol } : current
	}
	if (action === 'ctrl-end') {
		const lastRowIdx = model.rows.length - 1
		const lastRow = model.rows[lastRowIdx]
		const lastCol = lastRow?.cellStarts[lastRow.cellStarts.length - 1]
		return lastCol !== undefined ? { rowIdx: lastRowIdx, colIdx: lastCol } : current
	}

	const row = model.rows[current.rowIdx]
	if (!row) return current

	// Normalize current.colIdx to the START of its containing cell.
	const startColIdx = resolveContainingStart(row, current.colIdx)
	// Index within cellStarts of the current cell.
	const currentIdx = row.cellStarts.indexOf(startColIdx)

	// Narrow the action type — ctrl-home/ctrl-end are already handled via
	// early returns above, so the switch handles only the remaining 8.
	const relativeAction: Exclude<NavAction, 'ctrl-home' | 'ctrl-end'> = action
	switch (relativeAction) {
		case 'left': {
			if (currentIdx <= 0) return { rowIdx: current.rowIdx, colIdx: startColIdx }
			const prevStart = row.cellStarts[currentIdx - 1]
			return prevStart !== undefined ? { rowIdx: current.rowIdx, colIdx: prevStart } : current
		}
		case 'right': {
			if (currentIdx < 0 || currentIdx >= row.cellStarts.length - 1) {
				return { rowIdx: current.rowIdx, colIdx: startColIdx }
			}
			const nextStart = row.cellStarts[currentIdx + 1]
			return nextStart !== undefined ? { rowIdx: current.rowIdx, colIdx: nextStart } : current
		}
		case 'up':
			return moveVertically(model, current.rowIdx, startColIdx, -1)
		case 'down':
			return moveVertically(model, current.rowIdx, startColIdx, +1)
		case 'home': {
			const first = row.cellStarts[0]
			return first !== undefined ? { rowIdx: current.rowIdx, colIdx: first } : current
		}
		case 'end': {
			const last = row.cellStarts[row.cellStarts.length - 1]
			return last !== undefined ? { rowIdx: current.rowIdx, colIdx: last } : current
		}
		case 'page-up':
			return moveVertically(model, current.rowIdx, startColIdx, -model.pageStep)
		case 'page-down':
			return moveVertically(model, current.rowIdx, startColIdx, +model.pageStep)
	}
}

function moveVertically(
	model: GridNavModel,
	fromRowIdx: number,
	colIdx: number,
	delta: number,
): FocusPosition {
	const targetRowIdx = clamp(fromRowIdx + delta, 0, model.rows.length - 1)
	const targetRow = model.rows[targetRowIdx]
	if (!targetRow) return { rowIdx: fromRowIdx, colIdx }
	// Land on the cell in target row that CONTAINS `colIdx` — either an
	// empty cell at exactly colIdx, or a band that spans over it.
	const resolved = resolveContainingStart(targetRow, colIdx)
	return { rowIdx: targetRowIdx, colIdx: resolved }
}

/**
 * Given a row's nav data and a column index, return the starting
 * aria-colindex of the cell that contains that column. If colIdx is a
 * cell start exactly, returns colIdx. If colIdx is inside a band's
 * span, returns the band's start. If colIdx is past all cells, returns
 * the last cell's start.
 *
 * Assumes cellStarts is ascending and cellSpans >= 1.
 */
function resolveContainingStart(row: RowNav, colIdx: number): number {
	let last = row.cellStarts[0] ?? colIdx
	for (let i = 0; i < row.cellStarts.length; i++) {
		const start = row.cellStarts[i]
		const span = row.cellSpans[i]
		if (start === undefined || span === undefined) continue
		if (colIdx < start) return last // colIdx fell between last cell's end and this start — shouldn't happen with dense cells
		if (colIdx >= start && colIdx < start + span) return start
		last = start
	}
	return last
}

function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n
}
