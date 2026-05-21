/**
 * Same-origin canonical baseURL для frontend → backend communication.
 *
 * **CRITICAL production bug fix 2026-05-21**: previous pattern `?? 'http://localhost:8787'`
 * baked localhost reference в prod bundle когда CI build env didn't set
 * `VITE_API_URL`. Result: all fresh-signup users hit ERR_CONNECTION_REFUSED
 * localhost → ErrorBoundary → «Something went wrong!». Empirically caught
 * через `demo-funnel-smoke.spec.ts [E1]`.
 *
 * Resolution priority:
 *   1. `VITE_API_URL` env var if set — explicit override для cross-origin
 *      testing OR cross-subdomain prod patterns (`app.example.ru → api.example.ru`)
 *   2. `window.location.origin` в browser — same-origin canonical:
 *      - prod: `https://demo.sepshn.ru` → API Gateway routes /api/* → backend
 *      - dev: `http://localhost:5273` → Vite proxy в vite.config.ts forwards
 *        /api/* → localhost:8787 backend
 *      - Same-origin keeps Better Auth session cookie SameSite=Lax viable —
 *        нет CORS-кошмаров cross-subdomain auth
 *   3. `http://localhost:8787` literal — last-resort fallback для SSR /
 *      test environments где `window` undefined. Never reaches user browser.
 *
 * Used by:
 *   - `lib/api.ts` (Hono RPC client)
 *   - `lib/auth-client.ts` (Better Auth React client)
 *   - `features/chessboard/.../use-booking-events-stream.ts` (SSE EventSource —
 *     требует absolute URL)
 *   - `features/admin-tax/.../use-tourism-tax-report.ts` (XLSX download href)
 *   - `features/content-wizard/.../use-media.ts` (file upload fetch)
 *   - `features/observability/setup-otel.ts` через `getApiTracePropagationPatterns()`
 *     — OTel `propagateTraceHeaderCorsUrls` derives регекс из same base
 *
 * Sibling sweep canon per `feedback_self_review_finds_halfmeasure` — все
 * baseURL fallback sites должны использовать этот helper, не duplicate
 * the `?? 'localhost'` pattern (which was the bug).
 */
export function getApiBaseUrl(): string {
	const explicit = import.meta.env.VITE_API_URL
	if (explicit) return explicit
	if (typeof window !== 'undefined') return window.location.origin
	return 'http://localhost:8787'
}

/**
 * Escape `s` for safe inclusion в a RegExp literal. Stand-alone copy
 * (no `escape-string-regexp` dep — single use-site, 5-line implementation
 * not worth +pkg footprint).
 */
function escapeForRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * OTel trace-propagation regex list — controls which fetch URLs get the
 * `traceparent` W3C header attached by `FetchInstrumentation`. Used by
 * `setup-otel.ts` so trace propagation auto-adapts к the SAME base as
 * actual API fetches — single source of truth, не hand-maintained
 * `[/localhost:8787/, /\.horeca\.ru$/]` array (which silently broke after
 * brand rename Сэпшн в мае 2026 — `\.horeca\.ru$` had `$` anchor что
 * никогда не matched real URLs с path).
 *
 * Matches by HOST substring (not anchored) — covers both same-origin
 * relative-resolved URLs (`https://demo.sepshn.ru/api/...`) и explicit
 * VITE_API_URL cross-origin (`http://localhost:8787/api/...`).
 *
 * Returns `[]` если base не parseable как URL (degenerate dev config) —
 * propagation просто off, fetches still work, just no distributed-trace
 * stitching. Better fail-soft than crash on tracer init.
 */
export function getApiTracePropagationPatterns(): readonly RegExp[] {
	const base = getApiBaseUrl()
	try {
		const host = new URL(base).host
		return [new RegExp(escapeForRegExp(host))]
	} catch {
		return []
	}
}
