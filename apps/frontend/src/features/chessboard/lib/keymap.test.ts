import { describe, expect, it } from 'vitest'
import {
	type FocusPosition,
	type GridNavModel,
	keyToAction,
	type NavAction,
	nextFocusPosition,
	type RowNav,
} from './keymap.ts'

/**
 * Strict tests for reservation-grid keyboard navigation. Invariants:
 *   1. `keyToAction` — every APG-spec key maps correctly; NO modifier
 *      combinations surface false positives (Shift+Arrow = browser
 *      select, not navigation).
 *   2. `nextFocusPosition` is PURE + TOTAL over (model, current,
 *      action) — never throws, clamps off-grid to current.
 *   3. Colspan invariants:
 *      a. Right from band START jumps past the span (to first cell
 *         after). NEVER stops at a "middle" column.
 *      b. Left from cell-after-band lands on band START.
 *      c. Up/Down from col covered by a band lands on band START.
 *   4. Ctrl+Home/End always land on absolute corners, ignoring row
 *      bands.
 *   5. PageUp/PageDown clamp to grid edges.
 *   6. No-modifier navigation keys DON'T accept Shift/Alt/Ctrl (Ctrl
 *      only on Home/End).
 */

// ---------- Fixtures ----------

// Row with NO bands: 5 empty cells at aria-colindex 2..6 (colindex=1 is
// rowheader, not navigable).
const emptyRow: RowNav = {
	cellStarts: [2, 3, 4, 5, 6],
	cellSpans: [1, 1, 1, 1, 1],
}

// Row with ONE band: cells 2, 3, [4 span=3 = covers 4,5,6], 7, 8
const bandMidRow: RowNav = {
	cellStarts: [2, 3, 4, 7, 8],
	cellSpans: [1, 1, 3, 1, 1],
}

// Row with band STARTING at column 2 (left edge)
const bandStartRow: RowNav = {
	cellStarts: [2, 4, 5, 6],
	cellSpans: [2, 1, 1, 1], // band covers 2,3
}

// Row with band at END (right edge)
const bandEndRow: RowNav = {
	cellStarts: [2, 3, 4, 5],
	cellSpans: [1, 1, 1, 2], // band covers 5,6
}

const model3Rows: GridNavModel = {
	rows: [emptyRow, bandMidRow, bandEndRow],
	pageStep: 5,
}

// ---------- keyToAction ----------

describe('keyToAction — APG spec mapping', () => {
	it.each([
		['ArrowLeft', 'left'],
		['ArrowRight', 'right'],
		['ArrowUp', 'up'],
		['ArrowDown', 'down'],
		['Home', 'home'],
		['End', 'end'],
		['PageUp', 'page-up'],
		['PageDown', 'page-down'],
	] as const)('bare %s → %s', (key, expected) => {
		expect(
			keyToAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }),
		).toBe(expected)
	})

	it('Ctrl+Home → ctrl-home', () => {
		expect(
			keyToAction({ key: 'Home', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }),
		).toBe('ctrl-home')
	})

	it('Ctrl+End → ctrl-end', () => {
		expect(
			keyToAction({ key: 'End', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }),
		).toBe('ctrl-end')
	})

	it('Cmd+Home (macOS) → ctrl-home (metaKey equivalent)', () => {
		expect(
			keyToAction({ key: 'Home', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }),
		).toBe('ctrl-home')
	})

	describe('adversarial: modifiers on non-Ctrl-compatible keys reject', () => {
		it.each([
			'ArrowLeft',
			'ArrowRight',
			'ArrowUp',
			'ArrowDown',
			'PageUp',
			'PageDown',
		] as const)('Ctrl+%s → null (browser word-jump / tab-switch)', (key) => {
			expect(
				keyToAction({ key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }),
			).toBeNull()
		})

		it.each([
			'ArrowLeft',
			'ArrowRight',
			'ArrowUp',
			'ArrowDown',
			'Home',
			'End',
			'PageUp',
			'PageDown',
		] as const)('Shift+%s → null (browser select-extend)', (key) => {
			expect(
				keyToAction({ key, ctrlKey: false, metaKey: false, shiftKey: true, altKey: false }),
			).toBeNull()
		})

		it.each([
			'ArrowLeft',
			'ArrowRight',
			'ArrowUp',
			'ArrowDown',
			'Home',
			'End',
		] as const)('Alt+%s → null (OS shortcut)', (key) => {
			expect(
				keyToAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: true }),
			).toBeNull()
		})
	})

	it.each([
		'Enter',
		' ',
		'Escape',
		'Tab',
		'F2',
		'a',
		'1',
	] as const)('non-nav key %s → null (cell-level handler responsibility)', (key) => {
		expect(
			keyToAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }),
		).toBeNull()
	})
})

// ---------- nextFocusPosition: baseline (no bands) ----------

describe('nextFocusPosition — baseline empty-cell navigation', () => {
	const pos = (rowIdx: number, colIdx: number): FocusPosition => ({ rowIdx, colIdx })

	it('right: moves one cell, clamps at last col', () => {
		expect(nextFocusPosition(model3Rows, pos(0, 2), 'right')).toEqual(pos(0, 3))
		expect(nextFocusPosition(model3Rows, pos(0, 6), 'right')).toEqual(pos(0, 6)) // clamped
	})

	it('left: moves one cell, clamps at first col', () => {
		expect(nextFocusPosition(model3Rows, pos(0, 5), 'left')).toEqual(pos(0, 4))
		expect(nextFocusPosition(model3Rows, pos(0, 2), 'left')).toEqual(pos(0, 2)) // clamped
	})

	it('up: moves to previous row, same col', () => {
		expect(nextFocusPosition(model3Rows, pos(1, 3), 'up')).toEqual(pos(0, 3))
	})

	it('down: moves to next row, same col', () => {
		expect(nextFocusPosition(model3Rows, pos(0, 3), 'down')).toEqual(pos(1, 3))
	})

	it('up at row 0 clamps (no wrap)', () => {
		expect(nextFocusPosition(model3Rows, pos(0, 3), 'up')).toEqual(pos(0, 3))
	})

	it('down at last row clamps (no wrap)', () => {
		expect(nextFocusPosition(model3Rows, pos(2, 3), 'down')).toEqual(pos(2, 3))
	})

	it('home: first cell of row', () => {
		expect(nextFocusPosition(model3Rows, pos(0, 5), 'home')).toEqual(pos(0, 2))
	})

	it('end: last cell of row', () => {
		expect(nextFocusPosition(model3Rows, pos(0, 3), 'end')).toEqual(pos(0, 6))
	})

	it('ctrl-home: absolute top-left of grid', () => {
		expect(nextFocusPosition(model3Rows, pos(2, 5), 'ctrl-home')).toEqual(pos(0, 2))
	})

	it('ctrl-end: absolute bottom-right of grid', () => {
		expect(nextFocusPosition(model3Rows, pos(0, 2), 'ctrl-end')).toEqual(pos(2, 5))
	})
})

// ---------- nextFocusPosition: colspan invariants ----------

describe('nextFocusPosition — colspan-band invariants', () => {
	const pos = (rowIdx: number, colIdx: number): FocusPosition => ({ rowIdx, colIdx })

	it('Right from band start jumps past the WHOLE span (not into the middle)', () => {
		// bandMidRow: cells at 2, 3, [4 span=3], 7, 8. Right from 4 → 7 (not 5).
		expect(nextFocusPosition(model3Rows, pos(1, 4), 'right')).toEqual(pos(1, 7))
	})

	it('Left from cell-after-band lands on band START (not the last "middle" column)', () => {
		// bandMidRow: Left from 7 → 4 (the band's start, not 6).
		expect(nextFocusPosition(model3Rows, pos(1, 7), 'left')).toEqual(pos(1, 4))
	})

	it('Up from col 5 (covered by band in target row) lands on band START 4', () => {
		// Row 1 has band at 4 span=3. We're in row 2 at col 5, pressing Up.
		expect(nextFocusPosition(model3Rows, pos(2, 5), 'up')).toEqual(pos(1, 4))
	})

	it('Down from col 6 (covered by band in target row) lands on band START 4', () => {
		// From row 0 col 6, Down to row 1 which has band at 4 span=3 covering 6.
		expect(nextFocusPosition(model3Rows, pos(0, 6), 'down')).toEqual(pos(1, 4))
	})

	it('band at LEFT edge: Home lands on band (which IS the first cell)', () => {
		const leftEdgeModel: GridNavModel = { rows: [bandStartRow], pageStep: 5 }
		expect(nextFocusPosition(leftEdgeModel, pos(0, 5), 'home')).toEqual(pos(0, 2))
	})

	it('band at RIGHT edge: End lands on band (the last cell start)', () => {
		const rightEdgeModel: GridNavModel = { rows: [bandEndRow], pageStep: 5 }
		expect(nextFocusPosition(rightEdgeModel, pos(0, 2), 'end')).toEqual(pos(0, 5))
	})

	it('Right from right-edge band clamps (not off grid)', () => {
		const rightEdgeModel: GridNavModel = { rows: [bandEndRow], pageStep: 5 }
		expect(nextFocusPosition(rightEdgeModel, pos(0, 5), 'right')).toEqual(pos(0, 5))
	})

	it('starts at middle-of-band colIdx: resolves to band start first, THEN navigates', () => {
		// Edge case: user programmatically has colIdx=5 (middle of band at 4 span=3).
		// Right from there should land at 7 (past band), not 6 (next middle).
		expect(nextFocusPosition(model3Rows, pos(1, 5), 'right')).toEqual(pos(1, 7))
		// Left from middle colIdx resolves to band start, then steps left.
		expect(nextFocusPosition(model3Rows, pos(1, 5), 'left')).toEqual(pos(1, 3))
	})
})

// ---------- nextFocusPosition: PageUp/PageDown ----------

describe('nextFocusPosition — PageUp/PageDown', () => {
	const manyRows: GridNavModel = {
		rows: Array.from({ length: 20 }, () => emptyRow),
		pageStep: 5,
	}
	const pos = (rowIdx: number, colIdx: number): FocusPosition => ({ rowIdx, colIdx })

	it('page-down jumps by pageStep rows', () => {
		expect(nextFocusPosition(manyRows, pos(2, 3), 'page-down')).toEqual(pos(7, 3))
	})

	it('page-up jumps by pageStep rows', () => {
		expect(nextFocusPosition(manyRows, pos(10, 3), 'page-up')).toEqual(pos(5, 3))
	})

	it('page-down clamps at last row', () => {
		expect(nextFocusPosition(manyRows, pos(18, 3), 'page-down')).toEqual(pos(19, 3))
	})

	it('page-up clamps at first row', () => {
		expect(nextFocusPosition(manyRows, pos(2, 3), 'page-up')).toEqual(pos(0, 3))
	})
})

// ---------- nextFocusPosition: adversarial ----------

describe('nextFocusPosition — adversarial + edge cases', () => {
	const pos = (rowIdx: number, colIdx: number): FocusPosition => ({ rowIdx, colIdx })

	it('empty grid (zero rows): returns current position unchanged', () => {
		const emptyModel: GridNavModel = { rows: [], pageStep: 5 }
		for (const action of [
			'left',
			'right',
			'up',
			'down',
			'home',
			'end',
			'ctrl-home',
			'ctrl-end',
			'page-up',
			'page-down',
		] as const) {
			expect(nextFocusPosition(emptyModel, pos(0, 0), action)).toEqual(pos(0, 0))
		}
	})

	it('row with single cell: every nav is a no-op within that row', () => {
		const singleCellModel: GridNavModel = {
			rows: [{ cellStarts: [2], cellSpans: [1] }],
			pageStep: 5,
		}
		expect(nextFocusPosition(singleCellModel, pos(0, 2), 'left')).toEqual(pos(0, 2))
		expect(nextFocusPosition(singleCellModel, pos(0, 2), 'right')).toEqual(pos(0, 2))
		expect(nextFocusPosition(singleCellModel, pos(0, 2), 'home')).toEqual(pos(0, 2))
		expect(nextFocusPosition(singleCellModel, pos(0, 2), 'end')).toEqual(pos(0, 2))
	})

	it('purity: same input → same output, no side effects', () => {
		const current = pos(1, 4)
		const a = nextFocusPosition(model3Rows, current, 'right')
		const b = nextFocusPosition(model3Rows, current, 'right')
		expect(a).toEqual(b)
		// Input untouched
		expect(current).toEqual(pos(1, 4))
	})

	it('exhaustive: every action on every row/col in the 3-row model yields a valid cell', () => {
		// Property: result.colIdx is ALWAYS in the target row's cellStarts.
		for (let r = 0; r < model3Rows.rows.length; r++) {
			const row = model3Rows.rows[r]
			if (!row) continue
			for (const start of row.cellStarts) {
				for (const action of [
					'left',
					'right',
					'up',
					'down',
					'home',
					'end',
					'ctrl-home',
					'ctrl-end',
				] as const) {
					const result = nextFocusPosition(model3Rows, pos(r, start), action)
					const targetRow = model3Rows.rows[result.rowIdx]
					expect(targetRow).toBeDefined()
					expect(targetRow?.cellStarts).toContain(result.colIdx)
				}
			}
		}
	})
})

// ---------- Adversarial: invalid FocusPosition inputs ----------

describe('nextFocusPosition — adversarial invalid input guards (never throw)', () => {
	const pos = (rowIdx: number, colIdx: number): FocusPosition => ({ rowIdx, colIdx })

	it('rowIdx >= rows.length: every action returns current (no crash, no undefined)', () => {
		// Caller race: grid shrinks (roomType deleted) while focus state holds
		// stale rowIdx. Must not throw — just no-op.
		const stale = pos(99, 3)
		for (const action of [
			'left',
			'right',
			'up',
			'down',
			'home',
			'end',
			'ctrl-home',
			'ctrl-end',
			'page-up',
			'page-down',
		] as const) {
			const result = nextFocusPosition(model3Rows, stale, action)
			// ctrl-home/end are absolute — they IGNORE current and jump to
			// known corners. All other actions clamp to current position.
			if (action === 'ctrl-home') {
				expect(result).toEqual(pos(0, 2))
			} else if (action === 'ctrl-end') {
				expect(result.rowIdx).toBe(2)
			} else {
				expect(result).toEqual(stale)
			}
		}
	})

	it('negative rowIdx: same safety as >= length', () => {
		const stale = pos(-5, 3)
		const result = nextFocusPosition(model3Rows, stale, 'right')
		// Left/right/up/down on an invalid row → no-op (returns current).
		// This is defensive: in practice React state never produces negative
		// rowIdx, but pure functions must not trust inputs.
		expect(result).toEqual(stale)
	})

	it('colIdx out of range (past last cell): resolveContainingStart picks last cell, then navigates', () => {
		// model3Rows row 0 has cellStarts [2,3,4,5,6]. colIdx=99 → resolves
		// to last start (6). Left from "6" → 5.
		expect(nextFocusPosition(model3Rows, pos(0, 99), 'left')).toEqual(pos(0, 5))
	})

	it('colIdx below first cell (e.g. 0 or 1): resolves to first cell, then navigates', () => {
		// row 0 cellStarts [2,3,4,5,6]. colIdx=1 → resolves to first start (2).
		expect(nextFocusPosition(model3Rows, pos(0, 1), 'right')).toEqual(pos(0, 3))
	})

	it('model with zero-span cells in a row: does not infinite-loop or throw', () => {
		// Pathological input — cellSpans[i]=0 shouldn't happen but pure fn
		// must be total. Loop in resolveContainingStart advances i each
		// iteration regardless of span, so no infinite loop.
		const degenerate: GridNavModel = {
			rows: [{ cellStarts: [2, 3], cellSpans: [0, 1] }],
			pageStep: 5,
		}
		expect(() => nextFocusPosition(degenerate, pos(0, 2), 'right')).not.toThrow()
	})

	it('current position ON a row that exists in model (valid): sanity — no-op for safety clamps elsewhere', () => {
		// Anti-regression: ensure the out-of-bounds guards don't break valid
		// inputs. This is the happy-path sibling of the adversarial tests.
		expect(nextFocusPosition(model3Rows, pos(0, 3), 'right')).toEqual(pos(0, 4))
	})
})

// ---------- Cross-cutting: action enum coverage ----------

describe('NavAction enum coverage (hunt missing action handler)', () => {
	const ALL_ACTIONS: readonly NavAction[] = [
		'left',
		'right',
		'up',
		'down',
		'home',
		'end',
		'ctrl-home',
		'ctrl-end',
		'page-up',
		'page-down',
	]

	it('has exactly 10 actions (APG spec surface)', () => {
		expect(ALL_ACTIONS).toHaveLength(10)
	})

	it('every action produces a defined result (no thrown errors, no undefined)', () => {
		const pos: FocusPosition = { rowIdx: 0, colIdx: 2 }
		for (const action of ALL_ACTIONS) {
			const result = nextFocusPosition(model3Rows, pos, action)
			expect(result).toBeDefined()
			expect(typeof result.rowIdx).toBe('number')
			expect(typeof result.colIdx).toBe('number')
		}
	})
})
