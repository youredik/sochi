/**
 * Widget client store — Zustand v5 c persist middleware.
 *
 * **Scope canon** (per fresh 2026 research):
 *   - Shareable booking state (checkIn/checkOut/adults/children/roomTypeId/
 *     ratePlanId) lives в TanStack Router search params (canonical 2026 — see
 *     `retainSearchParams` middleware). NOT in this store.
 *   - This store holds ONLY local UI state that doesn't need to survive
 *     URL-based sharing: e.g. "user dismissed the demo banner" toggle,
 *     "last selected currency display" preference, photo-gallery lightbox state.
 *
 * **Why Zustand persist + localStorage**:
 *   - Anonymous user (no auth) → no server-side preferences.
 *   - Cross-session retention для UX continuity ("I dismissed banner once").
 *   - TTL via partialize (not in Zustand persist API directly — manual
 *     timestamp check on rehydrate).
 *
 * Per M9.widget.1 `feedback` canon + 2026 fresh research (TanStack Router
 * docs, Zustand persist middleware): combined approach. Search params for
 * shareable state, store for ephemeral UI state.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export interface WidgetUiState {
	/** Set of tenant slugs где user скрыл demo banner. */
	readonly dismissedDemoBanners: ReadonlySet<string>
	/** Last viewed tenant slug — для recovery после tab restart. */
	readonly lastViewedTenantSlug: string | null
	/** Hydration epoch ms — для TTL invalidation (older than 30d → reset). */
	readonly hydratedAt: number
}

export interface WidgetUiActions {
	dismissDemoBanner: (slug: string) => void
	rememberTenantVisit: (slug: string) => void
	resetUi: () => void
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const STORAGE_KEY = 'sochi-widget-ui-v1'

const INITIAL_STATE: WidgetUiState = {
	dismissedDemoBanners: new Set(),
	lastViewedTenantSlug: null,
	hydratedAt: 0,
}

export const useWidgetUiStore = create<WidgetUiState & WidgetUiActions>()(
	persist(
		(set) => ({
			...INITIAL_STATE,
			dismissDemoBanner: (slug) =>
				set((s) => {
					const next = new Set(s.dismissedDemoBanners)
					next.add(slug)
					return { dismissedDemoBanners: next, hydratedAt: Date.now() }
				}),
			rememberTenantVisit: (slug) => set({ lastViewedTenantSlug: slug, hydratedAt: Date.now() }),
			resetUi: () => set({ ...INITIAL_STATE, hydratedAt: Date.now() }),
		}),
		{
			name: STORAGE_KEY,
			version: 1,
			storage: createJSONStorage(() => localStorage, {
				replacer: (_k, v) => (v instanceof Set ? { __set: [...v] } : v),
				reviver: (_k, v) => {
					if (
						v !== null &&
						typeof v === 'object' &&
						'__set' in (v as object) &&
						Array.isArray((v as { __set: unknown[] }).__set)
					) {
						return new Set((v as { __set: string[] }).__set)
					}
					return v
				},
			}),
			partialize: (state) => ({
				dismissedDemoBanners: state.dismissedDemoBanners,
				lastViewedTenantSlug: state.lastViewedTenantSlug,
				hydratedAt: state.hydratedAt,
			}),
			onRehydrateStorage: () => (state, error) => {
				if (error) return
				if (!state) return
				if (state.hydratedAt > 0 && Date.now() - state.hydratedAt > TTL_MS) {
					// TTL expired → reset to defaults (manual TTL because Zustand persist
					// doesn't ship a TTL primitive — empirical 2026-04 from docs).
					// Bypass readonly via type cast — Zustand passes mutable internal state.
					const mutable = state as unknown as {
						dismissedDemoBanners: Set<string>
						lastViewedTenantSlug: string | null
						hydratedAt: number
					}
					mutable.dismissedDemoBanners = new Set()
					mutable.lastViewedTenantSlug = null
					mutable.hydratedAt = 0
				}
			},
		},
	),
)

/** Internal export ТОЛЬКО для unit tests. Не использовать в UI коде. */
export const _internals = { TTL_MS, STORAGE_KEY, INITIAL_STATE }
