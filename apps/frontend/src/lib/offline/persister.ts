import { experimental_createQueryPersister } from '@tanstack/react-query-persist-client'
import { del, get, set } from 'idb-keyval'

/**
 * G11 v3 (2026-05-18) — TanStack Query persister per **split-query 152-ФЗ
 * canon** (research ≥ 2026-05-18: TanStack TkDodo offline-react-query +
 * Booking.com Reservations API IDs-first + 152-ФЗ ст. 5 ч. 5 data-
 * minimization + Стахановец 2026 enforcement 3% revenue fines).
 *
 *   - **`experimental_createQueryPersister`** (5.100.x stable API)
 *   - **`idb-keyval` storage** (TanStack maintainer canon #9585)
 *   - **`maxAge: 7 days`** matches gcTime (weekend offline coverage)
 *   - **`buster: VITE_GIT_SHA`** per-deploy invalidation
 *   - **`filters.predicate`** excludes auth/session + meta.persist=false
 *
 * **PII handling pivot from G11 v2** (was: `stripPiiFromTree` rewriting
 * field values к null — REJECTED because lied к TypeScript `string` type
 * contract → downstream `.trim()` crashes on rehydrate). Replaced с:
 *
 *   1. **Grid query projects к narrow `GridBooking`** (no `guestSnapshot`)
 *      ON RECEIVE — see `use-grid-data.ts:queryFn`. Raw PII is function-
 *      local, garbage-collected после queryFn returns. TanStack stores
 *      only the projected shape с `guestMask` + `isForeignCitizen`
 *      (single-bit derived flags, not PII per 152-ФЗ ст. 3).
 *   2. **PII-bearing queries** (`['booking', id]` detail, `['unassigned',
 *      propertyId]`) tag themselves с `meta: { persist: false }`. Persister
 *      `filters.predicate` respects this hint — query stays in-memory only,
 *      never written к IndexedDB. Fresh server fetch every consume.
 *   3. **Auth-session** continues excluded via exact queryKey match (G11 v3
 *      original fix — `['auth', 'session']` cached null poisoned magic-link
 *      verify flow).
 *
 * Per research counter-arguments verified — null-strip / empty-string-strip
 * / encrypt-at-rest все rejected. Split-query is the canonical 2026 SaaS
 * pattern (Booking.com / Apaleo / Mews ship это shape).
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/** AsyncStorage interface adapter — TanStack persister expects this shape. */
const idbKeyvalStorage = {
	getItem: async (key: string): Promise<string | null> => {
		const v = await get<string>(key)
		return v ?? null
	},
	setItem: async (key: string, value: string): Promise<void> => {
		await set(key, value)
	},
	removeItem: async (key: string): Promise<void> => {
		await del(key)
	},
}

/**
 * Predicate — return `false` to EXCLUDE a query from IndexedDB persistence.
 *
 * Exclusion rules (any one match → skip persist):
 *   - `query.meta.persist === false` — explicit per-query opt-out (canonical
 *     TanStack TkDodo pattern; queries with PII data tag themselves).
 *   - Exact `['auth', 'session']` queryKey match (G11 v3 auth-cache poisoning
 *     fix — cached anonymous-probe null bounced fresh magic-link verify).
 *
 * Scoped (NOT prefix-block) для `['auth', 'session']`: future BA surfaces
 * `['auth', 'devices']` (passkey list), `['auth', 'sessions']` (active
 * devices) — operationally offline-friendly, OK persist. Adversarial guard:
 * 9 strict unit tests pin both edges (see persister.test.ts).
 */
export function shouldPersistQuery(
	queryKey: readonly unknown[],
	meta?: Record<string, unknown> | undefined,
): boolean {
	if (meta && meta.persist === false) return false
	if (queryKey.length < 2) return true
	return !(queryKey[0] === 'auth' && queryKey[1] === 'session')
}

/**
 * Create persister с per-deploy buster + 7-day maxAge + queryKey/meta filter.
 * No `serialize` override needed — JSON.stringify default works because
 * grid query already projects к no-PII shape, and PII-bearing queries
 * opt out via `meta: { persist: false }` filter.
 */
export function createOfflineQueryPersister() {
	const buster = import.meta.env.VITE_GIT_SHA ?? 'dev'
	return experimental_createQueryPersister({
		storage: idbKeyvalStorage,
		maxAge: SEVEN_DAYS_MS,
		buster,
		filters: {
			predicate: (query) => shouldPersistQuery(query.queryKey, query.meta),
		},
	})
}

/**
 * Purge ALL persisted queries — called on logout per session-end canon
 * (operator session end → wipe local cache, defense-in-depth).
 */
export async function clearOfflineCache(): Promise<void> {
	if (typeof window === 'undefined') return
	// idb-keyval stores в default DB 'keyval-store'. Drop the whole DB.
	await window.indexedDB.deleteDatabase('keyval-store')
}
