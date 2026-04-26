/**
 * Admin notifications console — `/o/{orgSlug}/admin/notifications`.
 *
 * Per memory `project_mcp_server_strategic.md` (Apr 2026 PMS canon):
 *   - Table-first list (TanStack Table 8) with status/kind/recipient/date filters.
 *   - **URL-addressable Sheet drill-down** (`?id=ntf_xxx`) — operator can deep-link.
 *   - Manual retry button (RBAC-gated `notification:retry`).
 *   - Cursor-based pagination.
 *
 * **A11y per axe-core 4.11:**
 *   - Single `<main>` + `<h1>`.
 *   - Filter controls labelled (`<Label htmlFor>` × `<Input id>`).
 *   - Table `<caption className="sr-only">` + `<th scope="col">`.
 *   - Sheet uses Radix Dialog under the hood — focus trap built-in.
 */
import { hasPermission, notificationKindSchema, notificationStatusSchema } from '@horeca/shared'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import * as React from 'react'
import { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { NotificationDetailSheet } from '../features/admin-notifications/components/notification-detail-sheet.tsx'
import {
	NotificationsFilterBar,
	type NotificationsFilterValue,
} from '../features/admin-notifications/components/notifications-filter-bar.tsx'
import { NotificationsTable } from '../features/admin-notifications/components/notifications-table.tsx'
import { notificationsListQueryOptions } from '../features/admin-notifications/hooks/use-notifications.ts'
import { meQueryOptions } from '../lib/use-can.ts'

const PAGE_LIMIT = 50

const adminNotificationsSearchSchema = z
	.object({
		status: notificationStatusSchema.optional(),
		kind: notificationKindSchema.optional(),
		recipient: z.string().min(1).max(320).optional(),
		from: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD')
			.optional(),
		to: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD')
			.optional(),
		cursor: z.string().min(1).max(200).optional(),
		// URL-addressable Sheet drill-down: when set, sheet is open.
		id: z
			.string()
			.regex(/^ntf_[a-z0-9]+$/i, 'Ожидается ntf_*')
			.optional(),
	})
	.refine((v) => !v.from || !v.to || v.from <= v.to, {
		message: 'from должен быть <= to',
	})

type AdminNotificationsSearch = z.infer<typeof adminNotificationsSearchSchema>

export const Route = createFileRoute('/_app/o/$orgSlug/admin/notifications')({
	validateSearch: (input: Record<string, unknown>): AdminNotificationsSearch =>
		adminNotificationsSearchSchema.parse(input),
	loaderDeps: ({ search }) => ({
		status: search.status,
		kind: search.kind,
		recipient: search.recipient,
		from: search.from,
		to: search.to,
		cursor: search.cursor,
	}),
	beforeLoad: async ({ context: { queryClient }, params }) => {
		const me = await queryClient.ensureQueryData(meQueryOptions)
		if (!hasPermission(me.role, { notification: ['read'] })) {
			throw redirect({ to: '/o/$orgSlug', params: { orgSlug: params.orgSlug } })
		}
	},
	loader: async ({ context: { queryClient }, deps }) => {
		await queryClient.ensureQueryData(
			notificationsListQueryOptions({
				limit: PAGE_LIMIT,
				...(deps.status ? { status: deps.status } : {}),
				...(deps.kind ? { kind: deps.kind } : {}),
				...(deps.recipient ? { recipient: deps.recipient } : {}),
				...(deps.from ? { from: deps.from } : {}),
				...(deps.to ? { to: deps.to } : {}),
				...(deps.cursor ? { cursor: deps.cursor } : {}),
			}),
		)
	},
	pendingComponent: AdminNotificationsSkeleton,
	errorComponent: AdminNotificationsErrorPanel,
	pendingMs: 200,
	pendingMinMs: 500,
	component: AdminNotificationsRoute,
})

function AdminNotificationsSkeleton() {
	return (
		<main aria-busy="true" aria-live="polite" className="container mx-auto p-6">
			<div className="space-y-6">
				<div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
				<div className="h-12 w-full animate-pulse rounded bg-muted" />
				<div className="h-96 animate-pulse rounded bg-muted" />
			</div>
		</main>
	)
}

function AdminNotificationsErrorPanel({ error }: { error: Error }) {
	return (
		<main className="container mx-auto p-6">
			<Alert variant="destructive" role="alert">
				<AlertTitle>Не удалось загрузить уведомления</AlertTitle>
				<AlertDescription>
					{error.message || 'Попробуйте обновить страницу через несколько секунд.'}
				</AlertDescription>
			</Alert>
		</main>
	)
}

function AdminNotificationsRoute() {
	const { orgSlug } = Route.useParams()
	const search = Route.useSearch()
	const navigate = Route.useNavigate()
	const headingId = React.useId()

	const queryParams = {
		limit: PAGE_LIMIT,
		...(search.status ? { status: search.status } : {}),
		...(search.kind ? { kind: search.kind } : {}),
		...(search.recipient ? { recipient: search.recipient } : {}),
		...(search.from ? { from: search.from } : {}),
		...(search.to ? { to: search.to } : {}),
		...(search.cursor ? { cursor: search.cursor } : {}),
	}
	const page = useSuspenseQuery(notificationsListQueryOptions(queryParams)).data

	const filterValue: NotificationsFilterValue = {
		status: search.status ?? null,
		kind: search.kind ?? null,
		recipient: search.recipient ?? null,
		from: search.from ?? null,
		to: search.to ?? null,
	}

	return (
		<main className="container mx-auto p-6 space-y-6" aria-labelledby={headingId}>
			<header className="space-y-1">
				<h1 id={headingId} className="text-2xl font-semibold tracking-tight">
					Уведомления
				</h1>
				<p className="text-sm text-muted-foreground">
					{page.items.length === 0
						? 'нет уведомлений с такими фильтрами'
						: `${page.items.length} уведомлений на странице${page.nextCursor ? ' (есть ещё)' : ''}`}
				</p>
			</header>

			<section aria-label="Фильтры">
				<NotificationsFilterBar
					value={filterValue}
					onChange={(next) => {
						navigate({
							search: {
								...(next.status ? { status: next.status } : {}),
								...(next.kind ? { kind: next.kind } : {}),
								...(next.recipient ? { recipient: next.recipient } : {}),
								...(next.from ? { from: next.from } : {}),
								...(next.to ? { to: next.to } : {}),
								// reset cursor on filter change — page 1.
							},
							replace: true,
						})
					}}
				/>
			</section>

			<section aria-label="История уведомлений">
				<NotificationsTable
					items={page.items}
					onRowClick={(id) => {
						navigate({
							search: { ...search, id },
							replace: false,
						})
					}}
				/>
			</section>

			{page.nextCursor ? (
				<nav aria-label="Пагинация">
					<Button
						variant="outline"
						onClick={() => {
							if (page.nextCursor)
								navigate({
									search: { ...search, cursor: page.nextCursor },
									replace: true,
								})
						}}
					>
						Дальше →
					</Button>
				</nav>
			) : null}

			<nav aria-label="Навигация">
				<Button asChild variant="ghost" size="sm">
					<Link to="/o/$orgSlug" params={{ orgSlug }}>
						← Дашборд
					</Link>
				</Button>
			</nav>

			{search.id ? (
				<React.Suspense fallback={null}>
					<NotificationDetailSheet
						id={search.id}
						open
						onOpenChange={(open) => {
							if (!open) {
								// Strip `id` from URL — preserves other filters.
								const next = { ...search }
								delete (next as { id?: string }).id
								navigate({ search: next, replace: false })
							}
						}}
					/>
				</React.Suspense>
			) : null}
		</main>
	)
}
