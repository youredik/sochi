import { createFileRoute, redirect } from '@tanstack/react-router'
import { MagicLinkForm } from '../features/auth/components/magic-link-form.tsx'
import { PasskeySigninButton } from '../features/auth/components/passkey-signin-button.tsx'
import { sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * Login route — public. Inverse guard: if an active session already exists,
 * bounce to `/` (or to `search.redirect` if the user was redirected here
 * from a protected route). `reloadDocument` on the return hop so the router
 * context rehydrates cleanly после auth state change.
 *
 * **Passwordless canon 2026-05-13** per `[[auth-passwordless-canon]]`: two
 * auth surfaces only — MagicLinkForm primary (email → ссылка для входа) +
 * PasskeySigninButton secondary (returning users with enrolled passkey).
 * Email+password fallback was dropped wholesale.
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
			<p className="mt-1 text-muted-foreground text-sm">
				Программа для гостевых домов и мини-отелей
			</p>
			<div className="mt-8">
				<MagicLinkForm callbackPath={redirectTarget ?? '/'} />
			</div>
			<div className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
				<span className="bg-border h-px flex-1" />
				<span>или</span>
				<span className="bg-border h-px flex-1" />
			</div>
			<div className="mt-4">
				<PasskeySigninButton />
			</div>
		</main>
	)
}
