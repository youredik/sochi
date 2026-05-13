import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { authClient, sessionQueryOptions } from '../../../lib/auth-client.ts'
import { broadcastLogout } from '../../../lib/broadcast-auth.ts'
import { logger } from '../../../lib/logger.ts'
import { type LocalizedError, mapAuthError } from '../lib/errors.ts'
import { slugify } from '../lib/slugify.ts'

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
 * (`signIn.email`, `signUp.email`, `signIn.magicLink`) strip unknown fields
 * via `z.core.$strip`. The 2nd-arg pattern from `better-call` merges
 * additional fields into the outgoing body BEFORE strict parse, so the
 * backend `before` hook (captcha-gate.ts) reads `captchaToken` from raw
 * `ctx.body` before BA's z.parse drops it.
 */
function captchaFetchOptions(
	captchaToken: string | undefined,
): { body: { captchaToken: string } } | undefined {
	if (!captchaToken) return undefined
	return { body: { captchaToken } }
}

/** Sign in with email + password. On success: invalidate session + navigate to home. */
export function useSignInEmail() {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	return useMutation<
		void,
		LocalizedError,
		{
			email: string
			password: string
			redirect?: string | undefined
			captchaToken?: string | undefined
		}
	>({
		mutationFn: async ({ email, password, captchaToken }) => {
			const { error } = await authClient.signIn.email(
				{ email, password },
				captchaFetchOptions(captchaToken),
			)
			if (error) throw mapAuthError(error as BAError)
		},
		onSuccess: async (_data, vars) => {
			await queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
			void navigate({ to: vars.redirect ?? '/', reloadDocument: Boolean(vars.redirect) })
		},
		onError: (err) => {
			logger.warn('auth.signIn failed', { code: (err as LocalizedError).title })
		},
	})
}

/**
 * Sign in via magic-link — passwordless. Posts the email to
 * `/api/auth/sign-in/magic-link`; backend sends an email with a one-time
 * verify URL valid for `MAGIC_LINK_TTL_SECONDS` (5 min). The user clicks the
 * link → BA verify endpoint sets the session cookie → 302 to `callbackURL`.
 *
 * No success-navigation here: this mutation's job is only to dispatch the
 * email. The route guard at `_app/` handles the post-verify redirect to the
 * tenant home after the verify hop sets the cookie.
 *
 * callbackURL MUST be absolute (caller's responsibility). BA prepends
 * `BETTER_AUTH_URL` (backend :8787) to relative paths → the verify hop
 * 302s into the backend route table and 404s. The MagicLinkForm component
 * always builds an absolute URL via `window.location.origin`.
 */
export function useSignInMagicLink() {
	return useMutation<
		void,
		LocalizedError,
		{ email: string; callbackURL: string; captchaToken?: string | undefined }
	>({
		mutationFn: async ({ email, callbackURL, captchaToken }) => {
			// biome-ignore lint/style/useNamingConvention: Better Auth API contract (callbackURL)
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

/**
 * Sign up with email + password AND create the first organization in a
 * single flow. Better Auth's `autoSignIn: true` on the server creates a
 * session during `signUp.email`; we then call `organization.create` which
 * triggers our `afterCreateOrganization` hook (populates
 * `organizationProfile` + attaches 14-day trial) and the session's
 * `activeOrganizationId` updates via BA's databaseHooks.
 */
export function useSignUp() {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	return useMutation<
		{ orgSlug: string },
		LocalizedError,
		{
			name: string
			email: string
			password: string
			orgName: string
			consentPersonalData: boolean
			captchaToken?: string | undefined
		}
	>({
		mutationFn: async ({ name, email, password, orgName, consentPersonalData, captchaToken }) => {
			if (!consentPersonalData) {
				throw {
					title: 'Требуется согласие на обработку персональных данных',
					description: 'Отметьте галочку согласия с политикой конфиденциальности.',
				} satisfies LocalizedError
			}
			const signUpRes = await authClient.signUp.email(
				{ name, email, password },
				captchaFetchOptions(captchaToken),
			)
			if (signUpRes.error) throw mapAuthError(signUpRes.error as BAError)

			const slug = slugify(orgName)
			const orgRes = await authClient.organization.create({
				name: orgName,
				slug: slug.length > 0 ? slug : `org-${Date.now().toString(36)}`,
			})
			if (orgRes.error) throw mapAuthError(orgRes.error as BAError)

			const createdSlug = orgRes.data?.slug ?? slug
			return { orgSlug: createdSlug }
		},
		onSuccess: async ({ orgSlug }) => {
			await queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
			toast.success('Аккаунт и организация созданы')
			void navigate({ to: '/o/$orgSlug', params: { orgSlug }, reloadDocument: true })
		},
		onError: (err) => {
			logger.warn('auth.signUp failed', { code: err.title })
		},
	})
}

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
			await queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
			void navigate({ to: '/login', search: { redirect: undefined }, reloadDocument: true })
		},
		onError: (err) => {
			logger.error('auth.signOut failed', { title: err.title })
			toast.error(err.title)
		},
	})
}
