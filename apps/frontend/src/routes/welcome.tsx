import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useCreateOrganization } from '../features/auth/hooks/use-auth-mutations.ts'
import { slugify } from '../features/auth/lib/slugify.ts'
import { api } from '../lib/api.ts'
import { sessionQueryOptions } from '../lib/auth-client.ts'

/**
 * Post-magic-link signup completion route.
 *
 * Flow (passwordless canon 2026-05-13):
 *   1. User submits MagicLinkSignUpForm на /signup with email + orgName.
 *   2. BA dispatches magic-link with `callbackURL=/welcome?n=<orgName>`.
 *   3. User clicks email link → BA verify creates user JIT + sets cookie →
 *      302 to /welcome?n=…
 *   4. This route: confirms session exists (else bounce to /login), reads
 *      orgName from query, lets user confirm, creates organization, navigates
 *      to /o/$slug/setup для 2-screen onboarding wizard.
 *
 * Why a separate confirmation step here (instead of auto-create в beforeLoad):
 *   - Magic-link query params are technically tampering-vulnerable (anyone
 *     intercepting the email could change `n=…`). Confirming через explicit
 *     submit keeps the user-in-the-loop for the value that ends up
 *     persistent (organization.name).
 *   - If the user types a wrong name on /signup, this is their chance to fix
 *     it before commit — better than a separate «edit organization» trip
 *     after onboarding.
 *
 * Existing-org guard: if the authenticated user already has at least one
 * organization, redirect к home. Prevents accidental re-creates when someone
 * lands on /welcome by clicking an old magic-link.
 */
export const Route = createFileRoute('/welcome')({
	validateSearch: (search: Record<string, unknown>) => ({
		n: typeof search.n === 'string' ? search.n : undefined,
	}),
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		// Unauthenticated visitor — bounce к login. Magic-link verify не yet
		// happened OR session cookie expired.
		if (!session?.session) {
			throw redirect({ to: '/login', search: { redirect: undefined } })
		}
		// User already has an active org — / route guard sends them to their
		// org home. Avoid double-create on stale magic-link click.
		if (session.session.activeOrganizationId) {
			throw redirect({ to: '/' })
		}
	},
	component: WelcomePage,
})

function WelcomePage() {
	const { n: queryOrgName } = Route.useSearch()
	const orgNameId = useId()
	const slugId = useId()
	const errorId = useId()
	const [orgName, setOrgName] = useState((queryOrgName ?? '').trim())
	const create = useCreateOrganization()

	// Belt-and-braces sanity guard: even though beforeLoad already verified
	// session.activeOrganizationId is null, an authenticated-but-orgful user
	// landing here directly would hit a double-create. The properties list
	// is also a cheap signal for "first-time user".
	const propertiesQuery = useQuery({
		queryKey: ['properties'] as const,
		queryFn: async () => {
			const res = await api.api.v1.properties.$get({ query: {} })
			if (!res.ok) return [] // tenantMiddleware blocks → empty по факту
			const body = (await res.json()) as { data: Array<{ id: string }> }
			return body.data
		},
		staleTime: 30_000,
	})

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		create.mutate({ orgName: orgName.trim() })
	}

	const error = create.error
	const slugPreview = slugify(orgName)

	return (
		<main className="mx-auto max-w-sm px-6 py-16">
			<h1 className="text-2xl font-semibold tracking-tight">Почти готово</h1>
			<p className="mt-1 text-muted-foreground text-sm">
				Email подтверждён. Создадим вашу гостиницу — это последний шаг до Шахматки.
			</p>

			{propertiesQuery.data && propertiesQuery.data.length > 0 ? (
				<div
					role="alert"
					className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					<p className="font-medium">У вас уже есть гостиница</p>
					<p className="mt-1 opacity-80">
						Похоже, эта учётная запись уже использовала /welcome — переходим домой.
					</p>
				</div>
			) : null}

			<form onSubmit={handleSubmit} className="mt-8 space-y-4" noValidate>
				{error ? (
					<div
						id={errorId}
						role="alert"
						aria-live="polite"
						className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
					>
						<p className="font-medium">{error.title}</p>
						{error.description ? <p className="mt-1 opacity-80">{error.description}</p> : null}
					</div>
				) : null}

				<div className="space-y-1.5">
					<Label htmlFor={orgNameId}>Название гостиницы</Label>
					<Input
						id={orgNameId}
						type="text"
						autoComplete="organization"
						required
						minLength={2}
						maxLength={80}
						value={orgName}
						onChange={(e) => setOrgName(e.target.value)}
						aria-describedby={slugId}
						placeholder="Гостиница Ромашка"
					/>
					<p id={slugId} className="text-xs text-muted-foreground">
						Адрес кабинета: <span className="font-mono">/o/{slugPreview || '…'}</span>
					</p>
				</div>

				<Button
					type="submit"
					size="lg"
					className="w-full"
					disabled={create.isPending || orgName.trim().length < 2}
				>
					{create.isPending ? 'Создаём…' : 'Создать гостиницу →'}
				</Button>
			</form>
		</main>
	)
}
