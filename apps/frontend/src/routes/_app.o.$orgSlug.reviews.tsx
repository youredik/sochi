/**
 * Reviews — `/o/{orgSlug}/reviews`.
 *
 * AI review-reply inbox (2026-05-30): отзывы гостей из каналов (Островок /
 * Яндекс / Авито) → YandexGPT-черновик ответа → правка → публикация обратно
 * в канал. Backend: `domains/review`. RBAC: `review:read` gate (sidebar +
 * requirePermission middleware).
 *
 * Route plumbing (зеркалит receivables-канон):
 *   - `beforeLoad`: prefetch properties; redirect → /setup если 0.
 *   - `loader`: prefetch reviews первого объекта (мгновенный первый кадр).
 *   - `pendingComponent` + `errorComponent`.
 *   - Тело: `useSuspenseQuery(properties)` + `<ReviewsPage>` (внутри —
 *     обычный `useQuery` для списка, чтобы переключение объекта было плавным
 *     без full-page suspense).
 *
 * A11y: `<main>` + единственный `<h1 aria-labelledby>` живут в `ReviewsPage`;
 * pending/error компоненты тоже отдают свой `<main>` (single-main invariant).
 */
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { ErrorState } from '../components/error-state.tsx'
import { ReviewsPage } from '../features/reviews/components/reviews-page.tsx'
import { propertiesQueryOptions } from '../features/receivables/hooks/use-receivables.ts'
import {
	provisionDemoReviews,
	reviewsQueryKey,
	reviewsQueryOptions,
} from '../features/reviews/hooks/use-reviews.ts'
import { meQueryOptions } from '../lib/use-can.ts'

export const Route = createFileRoute('/_app/o/$orgSlug/reviews')({
	beforeLoad: async ({ context: { queryClient }, params }) => {
		const list = await queryClient.ensureQueryData(propertiesQueryOptions)
		if (list.length === 0) {
			throw redirect({ to: '/o/$orgSlug/setup', params: { orgSlug: params.orgSlug } })
		}
	},
	loader: async ({ context: { queryClient } }) => {
		const properties = await queryClient.ensureQueryData(propertiesQueryOptions)
		const first = properties[0]
		if (!first) return
		const reviews = await queryClient.ensureQueryData(reviewsQueryOptions(first.id))
		// Only when the inbox is empty: a demo-org gets the canonical demo set
		// provisioned ONCE under its real property via an idempotent POST (write
		// semantics — the list GET stays safe). Once reviews exist we skip the
		// request entirely, so it never fires on every navigation / hover-preload.
		if (reviews.length === 0) {
			const me = await queryClient.ensureQueryData(meQueryOptions)
			if (me.mode === 'demo') {
				await provisionDemoReviews(first.id)
				await queryClient.refetchQueries({ queryKey: reviewsQueryKey(first.id) })
			}
		}
	},
	pendingComponent: ReviewsSkeleton,
	errorComponent: ReviewsErrorPanel,
	pendingMs: 200,
	pendingMinMs: 500,
	component: ReviewsRoute,
})

function ReviewsSkeleton() {
	return (
		<main
			aria-busy="true"
			aria-live="polite"
			className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6"
		>
			<div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
			<div className="h-28 animate-pulse rounded bg-muted" />
			<div className="h-40 animate-pulse rounded bg-muted" />
			<div className="h-40 animate-pulse rounded bg-muted" />
		</main>
	)
}

function ReviewsErrorPanel({ error }: { error: Error }) {
	return (
		<main className="mx-auto w-full max-w-3xl p-4 sm:p-6">
			<ErrorState
				title="Не удалось загрузить отзывы"
				error={error}
				onRetry={() => {
					window.location.reload()
				}}
			/>
		</main>
	)
}

function ReviewsRoute() {
	const properties = useSuspenseQuery(propertiesQueryOptions).data
	return <ReviewsPage properties={properties} />
}
