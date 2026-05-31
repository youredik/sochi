import type { Property } from '@horeca/shared'
import { useId, useMemo, useState } from 'react'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '../../../components/ui/select.tsx'
import { Skeleton } from '../../../components/ui/skeleton.tsx'
import { userMessageFor } from '../../../lib/user-message.ts'
import { useReviews } from '../hooks/use-reviews.ts'
import { summarizeReviews } from '../lib/review-summary.ts'
import { ReviewCard } from './review-card.tsx'
import { ReviewsSummaryCard } from './reviews-summary-card.tsx'

export function ReviewsPage({ properties }: { properties: readonly Property[] }) {
	const headingId = useId()
	return (
		<main aria-labelledby={headingId} className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
			<header className="space-y-1">
				<h1 id={headingId} className="text-xl font-semibold tracking-tight">
					Отзывы
				</h1>
				<p className="text-sm text-muted-foreground">
					Отзывы гостей из каналов. ИИ готовит черновик ответа — отредактируйте и опубликуйте.
				</p>
			</header>

			{properties.length === 0 ? (
				<p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
					Сначала добавьте объект размещения — после этого здесь появятся отзывы из каналов.
				</p>
			) : (
				<ReviewsInner properties={properties} />
			)}
		</main>
	)
}

function ReviewsInner({ properties }: { properties: readonly Property[] }) {
	// properties гарантированно непусто (проверено в ReviewsPage) → fallback '' не
	// срабатывает в рантайме (нужен только для сужения типа без non-null assertion).
	const [selectedId, setSelectedId] = useState(properties[0]?.id ?? '')
	const query = useReviews(selectedId)
	const reviews = query.data ?? []
	const summary = useMemo(() => summarizeReviews(reviews), [reviews])

	return (
		<div className="space-y-6">
			{properties.length > 1 && (
				<Select value={selectedId} onValueChange={setSelectedId}>
					<SelectTrigger className="w-full sm:w-72" aria-label="Выбор объекта">
						<SelectValue placeholder="Выберите объект" />
					</SelectTrigger>
					<SelectContent>
						{properties.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}

			{query.isPending ? (
				<div className="space-y-4" role="status" aria-busy="true" aria-label="Загрузка отзывов">
					<Skeleton className="h-28 w-full" />
					<Skeleton className="h-40 w-full" />
					<Skeleton className="h-40 w-full" />
				</div>
			) : query.isError ? (
				<p className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
					{userMessageFor(query.error, 'Не удалось загрузить отзывы')}
				</p>
			) : reviews.length === 0 ? (
				<p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
					Отзывов пока нет. Они появятся здесь, как только гости оставят их в каналах.
				</p>
			) : (
				<div className="space-y-4">
					<ReviewsSummaryCard summary={summary} />
					{reviews.map((review) => (
						<ReviewCard key={review.id} review={review} propertyId={selectedId} />
					))}
				</div>
			)}
		</div>
	)
}
