import { passkeyClient } from '@better-auth/passkey/client'
import type { auth as ServerAuth } from '@horeca/backend/auth'
import { queryOptions } from '@tanstack/react-query'
import {
	inferAdditionalFields,
	magicLinkClient,
	organizationClient,
} from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * Better Auth 1.6.x React client.
 *
 * - `baseURL` resolves to `VITE_API_URL` when set, otherwise same-origin
 *   (Vite dev proxy forwards `/api/*` to Hono; prod CDN binds
 *   `app.*.ru → api.*.ru`).
 * - `inferAdditionalFields<typeof ServerAuth>` keeps client types in lockstep
 *   with server `additionalFields` config even when none are defined today
 *   — insurance against silent future drift (BA 1.6 docs).
 * - `useSession()` is nanostore-backed → client-initiated mutations propagate
 *   to every subscriber automatically (better-auth.com/docs/concepts/client
 *   2026-04-23).
 *
 * Only exports consumed elsewhere today live on the public surface. Further
 * surface (session-list, passkey, two-factor) is added lazily when routes
 * need it so the API stays accidental-coupling-free.
 */
/**
 * Same-origin canonical default 2026-05-21 (paired с `lib/api.ts` fix).
 *
 * BA's `createAuthClient` requires non-empty baseURL для fetch URL construction.
 * `import.meta.env.VITE_API_URL` undefined в CI build → BA fallback к broken
 * state → `/api/auth/get-session` → ERR_CONNECTION_REFUSED. Empirically caught
 * via `demo-funnel-smoke.spec.ts [E1]` 2026-05-21.
 *
 * `window.location.origin` в browser → same-origin URLs (`https://demo.sepshn.ru/api/auth/...`)
 * → API Gateway routes back к backend. SSR/test fallback → localhost (нет window).
 */
const authBaseURL: string =
	import.meta.env.VITE_API_URL ??
	(typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787')

export const authClient = createAuthClient({
	baseURL: authBaseURL,
	plugins: [
		organizationClient(),
		// Better Auth magic-link client — companion to server-side `magicLink()`
		// plugin in `apps/backend/src/auth.ts`. Exposes `authClient.signIn.magicLink`
		// with type inference from server endpoint.
		magicLinkClient(),
		// M9.5 Phase D — passkey client (WebAuthn enrollment + signin).
		// Uses native `navigator.credentials` API под капотом (@simplewebauthn/
		// browser 13.x). Conditional Mediation UI supported via opts (autofill).
		passkeyClient(),
		inferAdditionalFields<typeof ServerAuth>(),
	],
})

/**
 * Canonical session query. Single keyed source so router `beforeLoad` guards,
 * layout chrome and page components never drift. `ensureQueryData` in guards
 * means at most one /get-session call per `staleTime` window per navigation.
 */
export const sessionQueryOptions = queryOptions({
	queryKey: ['auth', 'session'] as const,
	queryFn: async () => {
		const result = await authClient.getSession()
		if (result.error) {
			throw new Error(result.error.message ?? 'Не удалось получить сессию')
		}
		return result.data
	},
	staleTime: 30_000,
})
