import { createFileRoute, redirect } from '@tanstack/react-router'
import { DEFAULT_WELCOME_ORG_NAME } from '../features/auth/lib/welcome-defaults.ts'
import { authClient, sessionQueryOptions } from '../lib/auth-client.ts'
import { logger } from '../lib/logger.ts'
import { orgListQueryOptions } from '../features/tenancy/hooks/use-active-org.ts'
import { resolveWelcomeRedirect } from '../lib/welcome-redirect.ts'

/**
 * Post-magic-link signup completion route — auto-creates the user's first
 * organization (`DEFAULT_WELCOME_ORG_NAME` placeholder + `org-<base36>`
 * slug) and redirects к the cabinet, where dashboard's beforeLoad sends
 * the user к the 2-step setup wizard (IdentifyStep ИНН lookup overrides
 * placeholder name via DaData party).
 *
 * Round 14.6.2 refactor (2026-05-28) — flow shift per «DaData party
 * wins» canon 2026-05-22 (см. `identify-step.tsx:60-69`):
 *
 *   Old (3 redundant orgName entries):
 *     1. /signup form: email + orgName + 152-ФЗ checkbox
 *     2. /welcome form: confirm orgName (prefilled from `?n=…`)
 *     3. /setup IdentifyStep: ИНН → DaData → org.update({name})
 *        ⇒ overwrites #1 and #2; first two entries were always
 *        thrown away.
 *
 *   New (single source of truth for hotel name = DaData party):
 *     1. /signup form: ONLY email + 152-ФЗ
 *     2. /welcome beforeLoad: auto-create org placeholder + redirect
 *     3. /setup IdentifyStep: ИНН → DaData → org.update({name}) ⇒
 *        legal entity name from FNS registry; URL slug stays
 *        `org-<base36>` per URL stability canon.
 *
 * Three flows converge here:
 *   1. **Fresh signup happy path** — MagicLinkSignUpForm dispatches verify
 *      link с `callbackURL=/welcome`. User clicks link → BA mints user JIT
 *      → 302 к /welcome → here we auto-create org → /o/{slug}/.
 *   2. **`/login` JIT path** — never-before-seen email + `disableSignUp:false`
 *      mints user during verify, lands here с no org → same auto-create
 *      branch.
 *   3. **RETURN-VISIT path** (2026-05-21 bug fix per demo-funnel-smoke [E2]):
 *      existing user, expired cookie, re-signup → /welcome callback.
 *      Without explicit org-list check, user would create DUPLICATE empty
 *      org каждый раз. Decision tree's `set-active-and-redirect` branch
 *      sends them back к their existing tenant.
 *
 * Routing decision logic extracted в `lib/welcome-redirect.ts` (pure
 * function + strict tests). Route binding (этот файл) handles I/O
 * orchestration + side effects (setActive call, org.create call).
 *
 * Failure handling: org.create network error → component renders fallback
 * с retry instruction. We don't crash the route — the user can refresh + retry.
 */

interface CreateOrgFailureSearch {
	readonly error?: 'create_failed' | undefined
}

export const Route = createFileRoute('/welcome')({
	validateSearch: (search: Record<string, unknown>): CreateOrgFailureSearch =>
		search.error === 'create_failed' ? { error: 'create_failed' } : {},
	beforeLoad: async ({ context, search }) => {
		// If we just bounced back here from a failed auto-create, don't loop —
		// render the fallback page (component handles UX). User refresh retries.
		if (search.error === 'create_failed') return

		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		// Skip orgs fetch если no session (decision не зависит от orgs в этом
		// случае) — экономит 1 HTTP roundtrip для unauth path.
		const orgs = session?.session
			? await context.queryClient.ensureQueryData(orgListQueryOptions).catch(() => null)
			: null

		const decision = resolveWelcomeRedirect({ session, orgs })

		switch (decision.kind) {
			case 'redirect-login':
				throw redirect({ to: '/login', search: { redirect: undefined } })
			case 'redirect-home':
				throw redirect({ to: '/' })
			case 'set-active-and-redirect':
				await authClient.organization.setActive({ organizationId: decision.orgId })
				await context.queryClient.invalidateQueries({
					queryKey: sessionQueryOptions.queryKey,
				})
				throw redirect({
					to: '/o/$orgSlug',
					params: { orgSlug: decision.orgSlug },
					reloadDocument: true,
				})
			case 'auto-create-org': {
				const slug = `org-${Date.now().toString(36)}`
				// Wrap ONLY the network call в try/catch — TanStack `redirect()`
				// throws a sentinel object что routing framework intercepts; if
				// we catch it ourselves the redirect никогда не happens (caught
				// 2026-05-28 empirical browser smoke test).
				let createdSlug: string
				try {
					const result = await authClient.organization.create({
						name: DEFAULT_WELCOME_ORG_NAME,
						slug,
					})
					if (result.error) {
						logger.warn('welcome.autoCreateOrg failed', {
							status: result.error.status,
							code: result.error.code,
						})
						throw redirect({ to: '/welcome', search: { error: 'create_failed' } })
					}
					createdSlug = result.data?.slug ?? slug
				} catch (err) {
					// Re-throw TanStack redirect sentinels (success or error).
					if (err && typeof err === 'object' && ('isRedirect' in err || 'to' in err)) {
						throw err
					}
					logger.warn('welcome.autoCreateOrg threw', {
						message: err instanceof Error ? err.message : 'unknown',
					})
					throw redirect({ to: '/welcome', search: { error: 'create_failed' } })
				}
				await context.queryClient.invalidateQueries({
					queryKey: sessionQueryOptions.queryKey,
				})
				await context.queryClient.invalidateQueries({
					queryKey: orgListQueryOptions.queryKey,
				})
				throw redirect({
					to: '/o/$orgSlug',
					params: { orgSlug: createdSlug },
					reloadDocument: true,
				})
			}
		}
	},
	component: WelcomePage,
})

function WelcomePage() {
	const { error } = Route.useSearch()
	if (error === 'create_failed') {
		return (
			<main className="mx-auto max-w-sm px-6 py-16">
				<h1 className="text-2xl font-semibold tracking-tight">Что-то пошло не так</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					Не удалось создать кабинет автоматически. Обновите страницу — попробуем ещё раз. Если
					ошибка повторится, напишите в поддержку.
				</p>
				<a
					href="/welcome"
					className="mt-6 inline-block rounded-md border border-input px-4 py-2 text-sm hover:bg-accent"
				>
					Повторить
				</a>
			</main>
		)
	}
	// beforeLoad always redirects on the happy path — this loading state shows
	// briefly during the synchronous beforeLoad await chain.
	return (
		<main
			className="mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center"
			aria-busy="true"
		>
			<h1 className="text-2xl font-semibold tracking-tight">Готовим кабинет…</h1>
			<p className="mt-2 text-muted-foreground text-sm">
				Создаём вашу гостиницу. Через секунду перенесём вас на следующий шаг.
			</p>
		</main>
	)
}
