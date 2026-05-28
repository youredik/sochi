import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { authClient, sessionQueryOptions } from '../../../lib/auth-client.ts'
import { broadcastLogout } from '../../../lib/broadcast-auth.ts'
import { logger } from '../../../lib/logger.ts'
import { type LocalizedError, mapAuthError } from '../lib/errors.ts'

type BAError = {
	message?: string | undefined
	status?: number | undefined
	code?: string | undefined
}

/**
 * Build the optional second-arg `fetchOptions` for Better Auth client calls
 * that need to inject a captcha token into the request body.
 *
 * Why a 2nd arg `{ body }` and not a 1st-arg field: BA's typed endpoints
 * (`signIn.magicLink`) strip unknown fields via `z.core.$strip`. The 2nd-arg
 * pattern from `better-call` merges additional fields into the outgoing body
 * BEFORE strict parse, so the backend `before` hook (captcha-gate.ts) reads
 * `captchaToken` from raw `ctx.body` before BA's z.parse drops it.
 */
function captchaFetchOptions(
	captchaToken: string | undefined,
): { body: { captchaToken: string } } | undefined {
	if (!captchaToken) return undefined
	return { body: { captchaToken } }
}

/**
 * Sign in via magic-link — sole auth entrypoint after passwordless canon shift
 * 2026-05-13 per `[[auth-passwordless-canon]]`. Posts the email к
 * `/api/auth/sign-in/magic-link`; backend sends an email with a one-time
 * verify URL valid for `MAGIC_LINK_TTL_SECONDS` (5 min). The user clicks the
 * link → BA verify endpoint sets the session cookie → 302 to `callbackURL`.
 *
 * No success-navigation here: this mutation's job is only to dispatch the
 * email. The route guard at `_app/` handles the post-verify redirect to the
 * tenant home after the verify hop sets the cookie. For SIGNUP variants, the
 * caller passes `callbackURL=/welcome?n=...` so the welcome page collects the
 * organization name AFTER session is established.
 *
 * callbackURL MUST be absolute (caller's responsibility). BA prepends
 * `BETTER_AUTH_URL` (backend :8787) к relative paths → the verify hop 302s
 * into the backend route table and 404s. The MagicLinkForm component always
 * builds an absolute URL via `window.location.origin`.
 */
export function useSignInMagicLink() {
	return useMutation<
		void,
		LocalizedError,
		{ email: string; callbackURL: string; captchaToken?: string | undefined }
	>({
		mutationFn: async ({ email, callbackURL, captchaToken }) => {
			const { error } = await authClient.signIn.magicLink(
				{ email, callbackURL },
				captchaFetchOptions(captchaToken),
			)
			if (error) throw mapAuthError(error as BAError)
		},
		onError: (err) => {
			logger.warn('auth.signInMagicLink failed', { code: err.title })
		},
	})
}

// Round 14.6.2 — `useCreateOrganization` hook DELETED (was only consumed by
// the legacy `WelcomeForm` which is also deleted). Org creation moved
// inline to `routes/welcome.tsx` beforeLoad: `authClient.organization.create
// ({ name: DEFAULT_WELCOME_ORG_NAME, slug: 'org-<base36>' })` runs during
// the navigation guard, no React component round-trip. Canon
// `feedback_aggressive_delegacy`.

/**
 * Sign out, invalidate session cache, broadcast to peer tabs, redirect to
 * /login. Non-network failures still run cleanup (defensive) — stale cookie
 * on server is less bad than stuck UI.
 */
export function useSignOut() {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	return useMutation<void, LocalizedError, void>({
		mutationFn: async () => {
			try {
				await authClient.signOut()
			} catch (err) {
				logger.warn('auth.signOut network error (continuing cleanup)', {
					err: String(err),
				})
			}
		},
		onSuccess: async () => {
			broadcastLogout()
			// G11 v2 (2026-05-16): operator session end → wipe local cache.
			// Per R1+R2 ≥ 2026-05-15 canon: persister cache contains operational
			// metadata only (no PII per «don't cache PII» canon) — clear для
			// fresh-tenant safety on next login. Best-effort.
			const { clearOfflineCache } = await import('@/lib/offline/persister')
			try {
				await clearOfflineCache()
				queryClient.clear()
			} catch (err) {
				logger.warn('auth.signOut: offline cache wipe failed', { err: String(err) })
			}
			await queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
			void navigate({ to: '/login', search: { redirect: undefined }, reloadDocument: true })
		},
		onError: (err) => {
			logger.error('auth.signOut failed', { title: err.title })
			toast.error(err.title)
		},
	})
}
