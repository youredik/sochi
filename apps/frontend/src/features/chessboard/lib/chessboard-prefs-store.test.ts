/**
 * chessboard-prefs-store — strict tests (M9.3).
 *
 * **Pre-done audit:**
 *   Initial state:
 *     [I1] default windowDays === 15
 *     [I2] default viewMode === 'day'
 *     [I3] storage key === 'horeca-chessboard-prefs' (must match canon)
 *
 *   Mutation:
 *     [M1] setWindowDays(3) updates atomically
 *     [M2] setWindowDays(7) round-trip
 *     [M3] setWindowDays(30) round-trip
 *     [M4] setWindowDays('fit') round-trip — non-numeric value preserved
 *     [M5] setViewMode('month') round-trip
 *     [M6] setViewMode('day') round-trip
 *
 *   Persistence:
 *     [P1] partialize keeps only windowDays + viewMode
 */
import { beforeEach, describe, expect, it } from 'bun:test'

const STORAGE_KEY = 'horeca-chessboard-prefs'

// G6.bis (2026-05-15) — flake fix: previously installed file-local
// localStorage stub via `Object.defineProperty`, which collided с the
// twin stub в `chessboard-window-selector.test.tsx` (later-loaded file
// overwrote the earlier-loaded stub). Result: P1 read from one stub's
// Map while writes hit a different Map. Now using happy-dom's native
// `window.localStorage` (registered by `bun-preload.ts` GlobalRegistrator)
// + explicit `clear()` в beforeEach. Single source of truth.
const { useChessboardPrefsStore } = await import('./chessboard-prefs-store')

beforeEach(() => {
	window.localStorage.clear()
	useChessboardPrefsStore.setState({ windowDays: 15, viewMode: 'day' })
})

describe('chessboard-prefs-store — Initial state', () => {
	it('[I1] default windowDays is 15', () => {
		expect(useChessboardPrefsStore.getState().windowDays).toBe(15)
	})

	it('[I2] default viewMode is day', () => {
		expect(useChessboardPrefsStore.getState().viewMode).toBe('day')
	})

	it('[I3] storage key is exactly "horeca-chessboard-prefs"', () => {
		expect(useChessboardPrefsStore.persist.getOptions().name).toBe(STORAGE_KEY)
	})
})

describe('chessboard-prefs-store — Mutation', () => {
	it('[M1] setWindowDays(3) atomically', () => {
		useChessboardPrefsStore.getState().setWindowDays(3)
		expect(useChessboardPrefsStore.getState().windowDays).toBe(3)
	})

	it('[M2] setWindowDays(7) round-trip', () => {
		useChessboardPrefsStore.getState().setWindowDays(7)
		expect(useChessboardPrefsStore.getState().windowDays).toBe(7)
	})

	it('[M3] setWindowDays(30) round-trip', () => {
		useChessboardPrefsStore.getState().setWindowDays(30)
		expect(useChessboardPrefsStore.getState().windowDays).toBe(30)
	})

	it('[M4] setWindowDays("fit") preserves string value', () => {
		useChessboardPrefsStore.getState().setWindowDays('fit')
		expect(useChessboardPrefsStore.getState().windowDays).toBe('fit')
	})

	it('[M5] setViewMode("month") round-trip', () => {
		useChessboardPrefsStore.getState().setViewMode('month')
		expect(useChessboardPrefsStore.getState().viewMode).toBe('month')
	})

	it('[M6] setViewMode("day") round-trip', () => {
		useChessboardPrefsStore.getState().setViewMode('day')
		expect(useChessboardPrefsStore.getState().viewMode).toBe('day')
	})
})

describe('chessboard-prefs-store — Persistence', () => {
	it('[P1] partialize keeps only windowDays + viewMode (no setters)', () => {
		useChessboardPrefsStore.getState().setWindowDays(7)
		useChessboardPrefsStore.getState().setViewMode('month')
		const raw = localStorage.getItem(STORAGE_KEY)
		expect(raw).not.toBeNull()
		const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> }
		expect(Object.keys(parsed.state).sort()).toEqual(['viewMode', 'windowDays'])
	})
})
