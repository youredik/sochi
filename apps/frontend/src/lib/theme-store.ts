import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type Theme = 'light' | 'dark' | 'system'

interface ThemeState {
	theme: Theme
	setTheme: (theme: Theme) => void
}

/**
 * Theme store — 3-way light/dark/system choice persisted в localStorage.
 *
 * Why Zustand + persist (vs raw Context):
 *   - Cross-tree subscribers (ModeToggle in header + ThemeProvider in main.tsx +
 *     future per-route theme readers) — Zustand selector pattern избегает
 *     re-render всего дерева при каждом theme switch.
 *   - Persist round-trip без бойлерплейта — native localStorage с partialize
 *     для transient-free serialization.
 *
 * Storage key `horeca-theme` — match'ится с inline FOUC-script в index.html.
 * НЕ менять без одновременного обновления script (silent FOUC regression).
 *
 * Race-fix v5.0.10+ verified (concurrent rehydrate → no double-init);
 * наш zustand 5.0.12 — выше floor.
 */
export const useThemeStore = create<ThemeState>()(
	persist(
		(set) => ({
			theme: 'system',
			setTheme: (theme) => set({ theme }),
		}),
		{
			name: 'horeca-theme',
			// Lazy storage adapter — resolves localStorage per-call, не per module-init.
			// Без этого Zustand v5 захватывает undefined storage когда импорт случается
			// до hydration window (test env, early SSR refs).
			storage: createJSONStorage(() => localStorage),
			partialize: (state) => ({ theme: state.theme }),
		},
	),
)
