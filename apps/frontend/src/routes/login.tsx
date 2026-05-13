import { createFileRoute, redirect } from '@tanstack/react-router'
import { MagicLinkForm } from '../features/auth/components/magic-link-form.tsx'
import { sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * Login route — public. Inverse guard: if an active session already exists,
 * bounce to `/` (or to `search.redirect` if the user was redirected here
 * from a protected route). `reloadDocument` on the return hop so the router
 * context rehydrates cleanly после auth state change.
 *
 * **Passwordless canon 2026-05-13** per `[[auth-passwordless-canon]]`:
 * MagicLinkForm is the sole sign-in entrypoint here. Password fallback was
 * dropped wholesale (email+password flow disabled in BA config; SignInForm
 * component deleted). Passkey upgrades surface via the auth-passkey-button
 * после first sign-in — visible on /o/$slug/account/security, не on /login.
 */
export const Route = createFileRoute('/login')({
	validateSearch: (search: Record<string, unknown>) => ({
		redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
	}),
	beforeLoad: async ({ context, search }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		if (session?.session) {
			throw redirect({ to: search.redirect ?? '/', reloadDocument: Boolean(search.redirect) })
		}
	},
	component: LoginPage,
})

function LoginPage() {
	const { redirect: redirectTarget } = Route.useSearch()
	return (
		<main className="mx-auto max-w-sm px-6 py-16">
			<h1 className="text-2xl font-semibold tracking-tight">Вход</h1>
			<p className="mt-1 text-muted-foreground text-sm">HoReCa-портал для Сочи</p>
			<div className="mt-8">
				<MagicLinkForm callbackPath={redirectTarget ?? '/'} />
			</div>
		</main>
	)
}
