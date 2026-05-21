import type { AppType } from '@horeca/backend/app'
import { hc } from 'hono/client'

/**
 * Typed RPC client for the HoReCa backend.
 *
 * Types are inferred from backend's `AppType` — every route, param, query, and
 * response is type-checked at compile time. Never hand-roll `fetch()` for our
 * own API; always go through `api` so the frontend stays in lockstep with the
 * backend contract.
 *
 * `credentials: 'include'` sends the Better Auth session cookie on every call,
 * which lets authenticated domain routes (under /api/v1) work from the browser.
 */
/**
 * Same-origin canonical default 2026-05-21 (CRITICAL production fix):
 *
 *   - **prod**: `VITE_API_URL` unset → relative URLs (`/api/...`) → API
 *     Gateway routes к backend container на demo.sepshn.ru. Same-origin
 *     keeps Better Auth session cookie SameSite=Lax viable.
 *   - **dev**: same relative URLs → Vite proxy в `vite.config.ts:proxy['/api']`
 *     forwards к `http://localhost:8787` backend.
 *   - **dev override**: `VITE_API_URL=http://localhost:8787` explicit для
 *     edge cases (cross-origin testing).
 *
 * Previously fell back к `'http://localhost:8787'` literal — production
 * builds baked localhost reference в bundle → all fresh-signup users
 * received «Something went wrong» on /o/{slug}/ guard because frontend
 * hit ERR_CONNECTION_REFUSED localhost. Empirically discovered via
 * `demo-funnel-smoke.spec.ts [E1]` 2026-05-21.
 */
const API_URL = import.meta.env.VITE_API_URL ?? ''

export const api = hc<AppType>(API_URL, {
	fetch: (input: RequestInfo | URL, init?: RequestInit) =>
		fetch(input, {
			...init,
			credentials: 'include',
		}),
})
