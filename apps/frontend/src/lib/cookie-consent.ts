/**
 * Cookie consent — 152-ФЗ ст.6 + ст.18 opt-in canon (Sprint C+ Round 6
 * Legal P0 fix 2026-05-24).
 *
 * РКН 2026 clarification: cookies, позволяющие идентификацию (включая Yandex
 * Метрику с IP+cookie+device-fingerprint), попадают под 152-ФЗ → требуется
 * информированное явное согласие до загрузки скрипта. Implied-consent banner
 * = nonexistent legal cover.
 *
 * Штрафы 2026 (КоАП ст. 13.11):
 *   - Аналитика без opt-in:   150-300к ₽
 *   - Реклам-cookies без opt-in: 300-700к ₽ (ч.4)
 *
 * Categories:
 *   - `necessary` (always on): session, CSRF, auth — без согласия (legitimate
 *     interest per 152-ФЗ ст.6 ч.1 п.5 «исполнение договора»)
 *   - `analytics` (opt-in): Yandex Metrika — requires explicit accept
 *   - `marketing` (opt-in): future advertising — currently NOT used
 *
 * Storage: localStorage `horeca-cookie-consent` (`v2026-05-24` schema with
 * categories + timestamp).
 *
 * Module level state mirrors the storage value AFTER initial read, so SPA
 * downstream (Metrika initializer) can poll или subscribe.
 */

const STORAGE_KEY = 'horeca-cookie-consent'
const SCHEMA_VERSION = '2026-05-24'

export type ConsentCategory = 'necessary' | 'analytics' | 'marketing'

export interface ConsentState {
	readonly version: string
	readonly grantedAt: string // ISO timestamp
	readonly categories: Record<ConsentCategory, boolean>
}

const NEVER_DECIDED: ConsentState = {
	version: SCHEMA_VERSION,
	grantedAt: '',
	categories: { necessary: true, analytics: false, marketing: false },
}

let cachedState: ConsentState | null = null
type ConsentChangeListener = (state: ConsentState) => void
const listeners = new Set<ConsentChangeListener>()

function isConsentState(raw: unknown): raw is ConsentState {
	if (raw === null || typeof raw !== 'object') return false
	const obj = raw as { version?: unknown; grantedAt?: unknown; categories?: unknown }
	if (typeof obj.version !== 'string') return false
	if (typeof obj.grantedAt !== 'string') return false
	if (obj.categories === null || typeof obj.categories !== 'object') return false
	const cats = obj.categories as Record<string, unknown>
	return (
		typeof cats.necessary === 'boolean' &&
		typeof cats.analytics === 'boolean' &&
		typeof cats.marketing === 'boolean'
	)
}

/** Read current consent from storage. Returns NEVER_DECIDED if not set. */
export function getConsent(): ConsentState {
	if (cachedState !== null) return cachedState
	if (typeof window === 'undefined') return NEVER_DECIDED
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY)
		if (raw === null) return NEVER_DECIDED
		const parsed: unknown = JSON.parse(raw)
		if (!isConsentState(parsed)) return NEVER_DECIDED
		// Schema migration safeguard — old version → re-prompt
		if (parsed.version !== SCHEMA_VERSION) return NEVER_DECIDED
		cachedState = parsed
		return parsed
	} catch {
		return NEVER_DECIDED
	}
}

/** True if user has made a decision (accept/reject), false if banner needed. */
export function hasDecided(): boolean {
	return getConsent().grantedAt !== ''
}

/** True if specific category granted. Always true for `necessary`. */
export function isGranted(category: ConsentCategory): boolean {
	if (category === 'necessary') return true
	return getConsent().categories[category] === true
}

/** Set consent state атомарно (accept-all / reject-all / custom). */
export function setConsent(categories: Partial<Record<ConsentCategory, boolean>>): void {
	const next: ConsentState = {
		version: SCHEMA_VERSION,
		grantedAt: new Date().toISOString(),
		categories: {
			necessary: true,
			analytics: categories.analytics === true,
			marketing: categories.marketing === true,
		},
	}
	cachedState = next
	if (typeof window !== 'undefined') {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
		} catch {
			// Quota / private-mode — silent. Banner re-shows next session.
		}
	}
	for (const fn of listeners) fn(next)
}

/** Subscribe к consent changes — used by Metrika init waiter. */
export function onConsentChange(fn: ConsentChangeListener): () => void {
	listeners.add(fn)
	return () => {
		listeners.delete(fn)
	}
}

/** Test-only — clears module + storage state. */
export function __resetForTesting(): void {
	cachedState = null
	listeners.clear()
	if (typeof window !== 'undefined') {
		try {
			window.localStorage.removeItem(STORAGE_KEY)
		} catch {
			// ignore
		}
	}
}
