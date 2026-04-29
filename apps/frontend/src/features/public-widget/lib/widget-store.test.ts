/**
 * widget-store — strict tests for Zustand persist + TTL behavior.
 *
 * Adversarial coverage:
 *   - Set serialization roundtrip (replacer/reviver)
 *   - TTL invalidation on stale rehydrate
 *   - Cross-tenant isolation of dismissed-banner state
 *   - Reset clears everything
 *
 * happy-dom 20.x doesn't ship a localStorage by default in Vitest 4 runtime;
 * stub it just like `chessboard-window-selector.test.tsx` (Map-backed).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const storageData = new Map<string, string>()
const stub: Storage = {
	getItem: (k) => storageData.get(k) ?? null,
	setItem: (k, v) => {
		storageData.set(k, v)
	},
	removeItem: (k) => {
		storageData.delete(k)
	},
	clear: () => {
		storageData.clear()
	},
	key: (i) => Array.from(storageData.keys())[i] ?? null,
	get length() {
		return storageData.size
	},
}
Object.defineProperty(globalThis, 'localStorage', {
	value: stub,
	writable: true,
	configurable: true,
})

const { _internals, useWidgetUiStore } = await import('./widget-store.ts')

describe('widget-store', () => {
	beforeEach(() => {
		storageData.clear()
		useWidgetUiStore.getState().resetUi()
	})

	afterEach(() => {
		storageData.clear()
	})

	test('initial state is empty (no banners dismissed, no last tenant)', () => {
		const s = useWidgetUiStore.getState()
		expect(s.dismissedDemoBanners.size).toBe(0)
		expect(s.lastViewedTenantSlug).toBeNull()
	})

	test('dismissDemoBanner adds slug to set', () => {
		useWidgetUiStore.getState().dismissDemoBanner('demo-sirius')
		const s = useWidgetUiStore.getState()
		expect(s.dismissedDemoBanners.has('demo-sirius')).toBe(true)
		expect(s.dismissedDemoBanners.size).toBe(1)
	})

	test('dismissDemoBanner is per-tenant (not global)', () => {
		useWidgetUiStore.getState().dismissDemoBanner('tenant-a')
		const s = useWidgetUiStore.getState()
		expect(s.dismissedDemoBanners.has('tenant-a')).toBe(true)
		expect(s.dismissedDemoBanners.has('tenant-b')).toBe(false)
	})

	test('dismissDemoBanner is idempotent (set semantics)', () => {
		useWidgetUiStore.getState().dismissDemoBanner('demo-sirius')
		useWidgetUiStore.getState().dismissDemoBanner('demo-sirius')
		expect(useWidgetUiStore.getState().dismissedDemoBanners.size).toBe(1)
	})

	test('rememberTenantVisit updates lastViewedTenantSlug', () => {
		useWidgetUiStore.getState().rememberTenantVisit('demo-sirius')
		expect(useWidgetUiStore.getState().lastViewedTenantSlug).toBe('demo-sirius')
	})

	test('resetUi clears all state', () => {
		useWidgetUiStore.getState().dismissDemoBanner('a')
		useWidgetUiStore.getState().rememberTenantVisit('b')
		useWidgetUiStore.getState().resetUi()
		const s = useWidgetUiStore.getState()
		expect(s.dismissedDemoBanners.size).toBe(0)
		expect(s.lastViewedTenantSlug).toBeNull()
	})

	test('Set serialization roundtrip — JSON storage preserves Set on rehydrate', async () => {
		useWidgetUiStore.getState().dismissDemoBanner('demo-a')
		useWidgetUiStore.getState().dismissDemoBanner('demo-b')
		// Trigger persist → wait microtask
		await new Promise((r) => setTimeout(r, 10))
		const raw = localStorage.getItem(_internals.STORAGE_KEY)
		expect(raw).toBeTruthy()
		const parsed = JSON.parse(raw ?? '{}')
		// Replacer wraps Set as { __set: [...] }
		expect(parsed.state.dismissedDemoBanners.__set).toEqual(
			expect.arrayContaining(['demo-a', 'demo-b']),
		)
		// Now rehydrate via fresh store invocation:
		await useWidgetUiStore.persist.rehydrate()
		const rehydrated = useWidgetUiStore.getState()
		expect(rehydrated.dismissedDemoBanners.has('demo-a')).toBe(true)
		expect(rehydrated.dismissedDemoBanners.has('demo-b')).toBe(true)
	})

	test('TTL: rehydrate stale state (hydratedAt > 30d ago) → reset to defaults', async () => {
		// Manually write stale storage entry
		const staleHydratedAt = Date.now() - _internals.TTL_MS - 1000 // 30d + 1s ago
		localStorage.setItem(
			_internals.STORAGE_KEY,
			JSON.stringify({
				state: {
					dismissedDemoBanners: { __set: ['stale-tenant'] },
					lastViewedTenantSlug: 'stale-tenant',
					hydratedAt: staleHydratedAt,
				},
				version: 1,
			}),
		)
		await useWidgetUiStore.persist.rehydrate()
		const s = useWidgetUiStore.getState()
		expect(s.dismissedDemoBanners.size).toBe(0)
		expect(s.lastViewedTenantSlug).toBeNull()
	})

	test('TTL: fresh state (within 30d) survives rehydrate', async () => {
		const recent = Date.now() - 86_400_000 // 1d ago
		localStorage.setItem(
			_internals.STORAGE_KEY,
			JSON.stringify({
				state: {
					dismissedDemoBanners: { __set: ['fresh-tenant'] },
					lastViewedTenantSlug: 'fresh-tenant',
					hydratedAt: recent,
				},
				version: 1,
			}),
		)
		await useWidgetUiStore.persist.rehydrate()
		const s = useWidgetUiStore.getState()
		expect(s.dismissedDemoBanners.has('fresh-tenant')).toBe(true)
		expect(s.lastViewedTenantSlug).toBe('fresh-tenant')
	})

	test('hydratedAt updates on every action (mutation indicator)', () => {
		const before = useWidgetUiStore.getState().hydratedAt
		useWidgetUiStore.getState().dismissDemoBanner('x')
		const after = useWidgetUiStore.getState().hydratedAt
		expect(after).toBeGreaterThanOrEqual(before)
		expect(after).toBeGreaterThan(0)
	})

	test('storage key version isolated (key has v1 suffix)', () => {
		expect(_internals.STORAGE_KEY).toMatch(/-v1$/)
	})
})
