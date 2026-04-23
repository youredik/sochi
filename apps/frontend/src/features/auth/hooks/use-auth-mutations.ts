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

/** Sign in with email + password. On success: invalidate session + navigate to home. */
export function useSignInEmail() {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	return useMutation<
		void,
		LocalizedError,
		{ email: string; password: string; redirect?: string | undefined }
	>({
		mutationFn: async ({ email, password }) => {
			const { error } = await authClient.signIn.email({ email, password })
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
		}
	>({
		mutationFn: async ({ name, email, password, orgName, consentPersonalData }) => {
			if (!consentPersonalData) {
				throw {
					title: 'Требуется согласие на обработку персональных данных',
					description: 'Отметьте галочку согласия с политикой конфиденциальности.',
				} satisfies LocalizedError
			}
			const signUpRes = await authClient.signUp.email({ name, email, password })
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
