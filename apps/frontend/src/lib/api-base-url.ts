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
