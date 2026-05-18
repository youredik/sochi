import { experimental_createQueryPersister } from '@tanstack/react-query-persist-client'
import { del, get, set } from 'idb-keyval'

/**
 * G11 v2 (2026-05-16) — TanStack Query persister per R1+R2 deep-dive
 * ≥ 2026-05-15 canon:
 *
 *   - **`experimental_createQueryPersister`** (5.100.x stable API)
 *   - **`idb-keyval` storage** (TanStack maintainer canon #9585)
 *   - **`maxAge: 7 days`** matches gcTime (weekend offline coverage)
 *   - **`buster: VITE_GIT_SHA`** per-deploy invalidation
 *   - **PII fields stripped from persist** — per 2026 canon «don't cache
 *     PII at all» (matches Cloudbeds/Mews production behavior — PII
 *     fetched on-demand при detail panel open). Eliminates 152-ФЗ surface.
 *   - **`networkMode: 'offlineFirst'`** в QueryClient defaults
 *
 * v1 had AES-GCM encryption layer + per-tenant DEK derivation —
 * dropped per «don't cache PII» canon. Simpler architecture + zero
 * 152-ФЗ compliance surface vs encrypted-but-still-stored.
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
 * 152-ФЗ PII fields — stripped before persist. Match the set от existing
 * `guestSnapshot` shape + booking shape. NEVER cached в IndexedDB; fetched
 * on-demand when operator opens detail panel.
 *
 * Per R2 ≥ 2026-05-16 canon: «don't cache PII at all» — matches Cloudbeds/
 * Mews production. Operator sees «Гость #B-12345 — данные паспорта
 * недоступны офлайн» when offline, fresh fetch fills in when online.
 */
const PII_FIELD_NAMES = new Set([
	'firstName',
	'lastName',
	'middleName',
	'passportSeries',
	'passportNumber',
	'documentNumber',
	'dateOfBirth',
	'citizenship',
	'phone',
	'email',
])

/** Recursively walk a value, replacing PII field values с `null` placeholder
 *  so the structural shape stays intact (no schema crash on hydrate). */
function stripPiiFromTree(value: unknown): unknown {
	if (value === null || value === undefined) return value
	if (Array.isArray(value)) return value.map(stripPiiFromTree)
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const k of Object.keys(obj)) {
			if (PII_FIELD_NAMES.has(k)) {
				// Marker indicates «загружаем» к UI; null avoids type confusion.
				out[k] = null
			} else {
				out[k] = stripPiiFromTree(obj[k])
			}
		}
		return out
	}
	return value
}

/**
 * Predicate — return `false` to EXCLUDE а query from IndexedDB persistence.
 *
 * **G11 v3 (2026-05-18) — auth/session exclusion fix.**
 * Pre-fix bug: anonymous `/login` probe wrote `data: null` к persister.
 * After fresh magic-link verify set cookie + redirected к `/`, the
 * `_app.tsx` beforeLoad called `ensureQueryData(sessionQueryOptions)`
 * which got the cached `null` (within 30s `staleTime`) → redirected
 * back к `/login` despite a valid server session. Manifested empirically
 * for 2 users (5 valid sessions accumulated в DB per user, all unused).
 *
 * Rationale for **scoped** queryKey match `['auth', 'session']` (NOT
 * prefix-block `['auth', ...]`): future BA features may add
 * `['auth', 'devices']` (passkey list) OR `['auth', 'sessions']` (active
 * device list) — operationally fine к persist для offline UX. Only the
 * authoritative SESSION state is sensitive к persisted-null poisoning.
 *
 * Adversarial guard: tests pin this exact shape (see persister.test.ts).
 */
export function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
	if (queryKey.length < 2) return true
	return !(queryKey[0] === 'auth' && queryKey[1] === 'session')
}

/**
 * Create persister с per-deploy buster + 7-day maxAge + PII-strip serialize.
 * `buster` falls back к literal 'dev' когда VITE_GIT_SHA undefined.
 */
export function createOfflineQueryPersister() {
	const buster = import.meta.env.VITE_GIT_SHA ?? 'dev'
	return experimental_createQueryPersister({
		storage: idbKeyvalStorage,
		maxAge: SEVEN_DAYS_MS,
		buster,
		// G11 v3 (2026-05-18): exclude `['auth', 'session']` from persist.
		// See `shouldPersistQuery` jsdoc для full rationale.
		filters: {
			predicate: (query) => shouldPersistQuery(query.queryKey),
		},
		serialize: (persistedQuery) => {
			// Strip PII fields BEFORE JSON.stringify — eliminates 152-ФЗ
			// surface. Cache contains operational metadata only (IDs, dates,
			// statuses, channels, taxes). PII fetched on-demand by detail panel.
			const stripped = stripPiiFromTree(persistedQuery)
			return JSON.stringify(stripped)
		},
	})
}

/**
 * Purge ALL persisted queries — called on logout per session-end canon
 * (operator session end → wipe local cache, even though no PII).
 */
export async function clearOfflineCache(): Promise<void> {
	if (typeof window === 'undefined') return
	// idb-keyval stores в default DB 'keyval-store'. Drop the whole DB.
	await window.indexedDB.deleteDatabase('keyval-store')
}
