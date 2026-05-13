import { createFileRoute, redirect } from '@tanstack/react-router'
import { MagicLinkForm } from '../features/auth/components/magic-link-form.tsx'
import { SignInForm } from '../features/auth/components/sign-in-form.tsx'
import { sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * Login route — public. Inverse guard: if an active session already
 * exists, bounce to `/` (or to `search.redirect` if the user was
 * redirected here from a protected route). `reloadDocument` on the return
 * hop so the router context rehydrates cleanly after auth state change.
 *
 * Visual hierarchy: magic-link is the primary CTA (one-click passwordless,
 * RU hospitality SMB users don't want to remember another password). The
 * email+password path stays available behind a `<details>` disclosure so
 * existing accounts and password-manager workflows are not broken.
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
			<details className="group mt-6">
				<summary className="cursor-pointer list-none text-sm text-muted-foreground transition-colors hover:text-foreground">
					<span className="underline underline-offset-4 group-open:no-underline">
						Другие способы входа
					</span>
				</summary>
				<div className="mt-4">
					<SignInForm redirect={redirectTarget} />
				</div>
			</details>
		</main>
	)
}
