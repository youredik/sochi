import type { AppType } from '@horeca/backend/app'
import { hc } from 'hono/client'
import { getApiBaseUrl } from './api-base-url.ts'

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
// Base URL via shared helper — same-origin canon 2026-05-21 per `lib/api-base-url.ts`.
const API_URL = getApiBaseUrl()

export const api = hc<AppType>(API_URL, {
	fetch: (input: RequestInfo | URL, init?: RequestInit) =>
		fetch(input, {
			...init,
			credentials: 'include',
		}),
})
