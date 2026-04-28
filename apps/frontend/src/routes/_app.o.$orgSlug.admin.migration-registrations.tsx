/**
 * Admin migration registrations console — `/o/{orgSlug}/admin/migration-registrations`.
 *
 * Per `project_m8_a_6_ui_canonical.md` (М8.A.6 UI canonical 2026 research):
 *   - Tenant-wide list (TanStack Table 8.21).
 *   - URL-addressable Sheet drill-down (?id=mreg_xxx) — operator deep-links.
 *   - Cancel button с reason TextField (RBAC manage gate).
 *   - operatorNote autosave debounced (1500ms).
 *
 * a11y per `project_axe_a11y_gate.md`:
 *   - Single <main> + <h1>.
 *   - Sheet uses Radix Dialog → focus trap + Esc close built-in.
 *   - Table <caption className="sr-only"> + <th scope="col">.
 */
import { hasPermission } from '@horeca/shared'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import * as React from 'react'
import { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { MigrationRegistrationDetailSheet } from '../features/admin-migration-registrations/components/migration-registration-detail-sheet.tsx'
import { MigrationRegistrationsTable } from '../features/admin-migration-registrations/components/migration-registrations-table.tsx'
import { migrationRegistrationsListQueryOptions } from '../features/admin-migration-registrations/hooks/use-migration-registrations.ts'
import { meQueryOptions } from '../lib/use-can.ts'

const PAGE_LIMIT = 100

const adminMigrationRegistrationsSearchSchema = z.object({
	id: z
		.string()
		.regex(/^mreg_[a-z0-9]+$/i, 'Ожидается mreg_*')
		.optional(),
})

type AdminMigrationRegistrationsSearch = z.infer<typeof adminMigrationRegistrationsSearchSchema>

export const Route = createFileRoute('/_app/o/$orgSlug/admin/migration-registrations')({
	validateSearch: (input: Record<string, unknown>): AdminMigrationRegistrationsSearch =>
		adminMigrationRegistrationsSearchSchema.parse(input),
	beforeLoad: async ({ context: { queryClient }, params }) => {
		const me = await queryClient.ensureQueryData(meQueryOptions)
		if (!hasPermission(me.role, { migrationRegistration: ['read'] })) {
			throw redirect({ to: '/o/$orgSlug', params: { orgSlug: params.orgSlug } })
		}
	},
	loader: async ({ context: { queryClient } }) => {
		await queryClient.ensureQueryData(migrationRegistrationsListQueryOptions(PAGE_LIMIT))
	},
	pendingComponent: AdminMigrationRegistrationsSkeleton,
	errorComponent: AdminMigrationRegistrationsErrorPanel,
	pendingMs: 200,
	pendingMinMs: 500,
	component: AdminMigrationRegistrationsRoute,
})

function AdminMigrationRegistrationsSkeleton() {
	return (
		<main aria-busy="true" aria-live="polite" className="container mx-auto p-6">
			<div className="space-y-6">
				<div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
				<div className="h-96 animate-pulse rounded bg-muted" />
			</div>
		</main>
	)
}

function AdminMigrationRegistrationsErrorPanel({ error }: { error: Error }) {
	return (
		<main className="container mx-auto p-6">
			<Alert variant="destructive" role="alert">
				<AlertTitle>Не удалось загрузить регистрации</AlertTitle>
				<AlertDescription>
					{error.message || 'Попробуйте обновить страницу через несколько секунд.'}
				</AlertDescription>
			</Alert>
		</main>
	)
}

function AdminMigrationRegistrationsRoute() {
	const search = Route.useSearch()
	const navigate = Route.useNavigate()
	const headingId = React.useId()

	const me = useSuspenseQuery(meQueryOptions).data
	const canManage = hasPermission(me.role, { migrationRegistration: ['manage'] })

	const { data: items } = useSuspenseQuery(migrationRegistrationsListQueryOptions(PAGE_LIMIT))

	const closeSheet = React.useCallback(
		() => navigate({ search: (s: AdminMigrationRegistrationsSearch) => ({ ...s, id: undefined }) }),
		[navigate],
	)

	const openSheet = React.useCallback(
		(id: string) => navigate({ search: (s: AdminMigrationRegistrationsSearch) => ({ ...s, id }) }),
		[navigate],
	)

	return (
		<main className="container mx-auto p-6 space-y-6" aria-labelledby={headingId}>
			<header className="space-y-1">
				<h1 id={headingId} className="text-2xl font-semibold tracking-tight">
					Миграционный учёт МВД
				</h1>
				<p className="text-sm text-muted-foreground">
					Регистрация иностранных гостей в ЕПГУ через канал «Скала-ЕПГУ» (Постановление №1668).
					Создаются автоматически при заселении (status «in_house»). Дедлайн отправки — 24 часа от
					check-in.
				</p>
			</header>

			<MigrationRegistrationsTable items={items} onRowClick={openSheet} />

			{search.id ? (
				<React.Suspense fallback={null}>
					<MigrationRegistrationDetailSheet
						id={search.id}
						canManage={canManage}
						onClose={closeSheet}
					/>
				</React.Suspense>
			) : null}
		</main>
	)
}
