import { createFileRoute, redirect } from '@tanstack/react-router'
import { orgListQueryOptions } from '../features/tenancy/hooks/use-active-org.ts'
import { sessionQueryOptions } from '../lib/auth-client.ts'

const TG_URL = import.meta.env.VITE_CONTACT_TG_URL ?? 'https://t.me/sepshn'
const EMAIL = import.meta.env.VITE_CONTACT_EMAIL ?? 'hi@sepshn.ru'

/**
 * / — public landing route. Replaces the prior `_app.index.tsx`
 * redirect-helper. Auth-aware beforeLoad:
 *   • no session → render LandingPage component (public)
 *   • session + active org → redirect к /o/{slug} (preserves существующее
 *     поведение `to: '/'` redirects из signup.tsx / welcome.tsx /
 *     _app.o.$orgSlug.tsx — залогиненные пользователи продолжают попадать
 *     домой, не на landing)
 *   • session + no active org → /o-select (там _app.tsx подхватит и
 *     обработает edge-cases: zero orgs → /welcome, single org → setActive)
 *
 * Минимальный «credibility surface» — 1 экран, 2 контакт-канала, без 12
 * секций. См. plans/customer-discovery-plan.md §10 для обоснования.
 */
export const Route = createFileRoute('/')({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
		if (!session?.session) return
		const activeId = session.session.activeOrganizationId
		if (!activeId) {
			throw redirect({ to: '/o-select' })
		}
		const orgs = await context.queryClient.ensureQueryData(orgListQueryOptions)
		const org = orgs.find((o) => o.id === activeId)
		if (!org) {
			throw redirect({ to: '/o-select' })
		}
		throw redirect({ to: '/o/$orgSlug', params: { orgSlug: org.slug } })
	},
	component: LandingPage,
})

function LandingPage() {
	return (
		<main className="flex min-h-svh flex-col">
			<div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-16">
				<div className="text-2xl font-semibold tracking-tight">Сэпшн</div>

				<h1 className="mt-16 text-3xl font-semibold leading-tight tracking-tight md:text-4xl">
					Программа для управления гостевым домом или мини-отелем.
				</h1>

				<p className="mt-4 text-base text-muted-foreground md:text-lg">Сделано в Сочи.</p>

				<p className="mt-16 text-base">Свяжитесь любым удобным способом:</p>

				<div className="mt-4 flex flex-wrap gap-3">
					<a
						href={TG_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex h-11 items-center justify-center rounded-lg bg-primary px-6 text-base font-medium text-primary-foreground transition hover:opacity-90"
					>
						Telegram
					</a>
					<a
						href={`mailto:${EMAIL}`}
						className="border-border inline-flex h-11 items-center justify-center rounded-lg border px-6 text-base font-medium transition hover:bg-muted"
					>
						Email
					</a>
				</div>
			</div>

			<footer className="border-border border-t px-6 py-6 text-center text-sm text-muted-foreground">
				© 2026 Сэпшн · {EMAIL}
			</footer>
		</main>
	)
}
