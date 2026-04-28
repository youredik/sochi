import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type WindowDays = 3 | 7 | 15 | 30 | 'fit'
export type ViewMode = 'day' | 'month'

interface ChessboardPrefsState {
	windowDays: WindowDays
	viewMode: ViewMode
	setWindowDays: (windowDays: WindowDays) => void
	setViewMode: (viewMode: ViewMode) => void
}

/**
 * Chessboard user preferences — Zustand persist (per-user-per-device).
 *
 * Storage key `horeca-chessboard-prefs` — НЕ конфликт с `horeca-theme`.
 *
 * Per Round 2 research finding (canonical 2026 для per-user state): NOT URL
 * search params (theme + windowDays — per-user preferences, не shareable
 * URL state). Round 5 self-audit fix C4 reverted my earlier подстраивание под
 * neighbor's M8.A.6 routes.
 *
 * Bnovo-parity: 5 windowDays options (3/7/15/30/fit) + Day/Month viewMode
 * (per `help.bnovo.ru/knowledgebase/planing/` — verified Round 2/3 research).
 *
 * lazy createJSONStorage — same pattern что theme-store.ts (avoid happy-dom
 * test env Storage API capture issue, Iteration 7 self-audit lesson).
 */
export const useChessboardPrefsStore = create<ChessboardPrefsState>()(
	persist(
		(set) => ({
			windowDays: 15,
			viewMode: 'day',
			setWindowDays: (windowDays) => set({ windowDays }),
			setViewMode: (viewMode) => set({ viewMode }),
		}),
		{
			name: 'horeca-chessboard-prefs',
			storage: createJSONStorage(() => localStorage),
			partialize: (state) => ({ windowDays: state.windowDays, viewMode: state.viewMode }),
		},
	),
)
