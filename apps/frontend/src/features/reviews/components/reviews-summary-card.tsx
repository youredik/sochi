import { StarIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '../../../components/ui/badge.tsx'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '../../../components/ui/card.tsx'
import type { ReviewSummary } from '../lib/review-summary.ts'

function Stat({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="space-y-1">
			<div className="text-2xl font-semibold tabular-nums">{children}</div>
			<div className="text-xs text-muted-foreground">{label}</div>
		</div>
	)
}

export function ReviewsSummaryCard({ summary }: { summary: ReviewSummary }) {
	const { sentiment } = summary
	const hasSentiment = sentiment.positive + sentiment.negative + sentiment.mixed > 0

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Сводка по отзывам</CardTitle>
				<CardDescription>
					{summary.newCount > 0
						? `${summary.newCount} ${pluralReviews(summary.newCount)} ждут ответа`
						: 'Все отзывы обработаны'}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
					<Stat label="Средняя оценка">
						{summary.avgRating === null ? (
							<span className="text-muted-foreground">—</span>
						) : (
							<span className="inline-flex items-center gap-1">
								{summary.avgRating.toLocaleString('ru-RU', { minimumFractionDigits: 1 })}
								<StarIcon className="size-5 fill-amber-400 text-amber-400" aria-hidden />
							</span>
						)}
					</Stat>
					<Stat label="Всего отзывов">{summary.total}</Stat>
					<Stat label="Ждут ответа">{summary.newCount}</Stat>
					<Stat label="Опубликовано">{summary.publishedCount}</Stat>
				</div>

				{hasSentiment && (
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-xs text-muted-foreground">Тональность:</span>
						{sentiment.positive > 0 && (
							<Badge variant="default">Позитив · {sentiment.positive}</Badge>
						)}
						{sentiment.mixed > 0 && (
							<Badge variant="secondary">Смешанный · {sentiment.mixed}</Badge>
						)}
						{sentiment.negative > 0 && (
							<Badge variant="destructive">Негатив · {sentiment.negative}</Badge>
						)}
					</div>
				)}

				{summary.topTopics.length > 0 && (
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-xs text-muted-foreground">Частые темы:</span>
						{summary.topTopics.map((t) => (
							<Badge key={t.topic} variant="outline">
								{t.topic} · {t.count}
							</Badge>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	)
}

function pluralReviews(n: number): string {
	const mod10 = n % 10
	const mod100 = n % 100
	if (mod10 === 1 && mod100 !== 11) return 'отзыв'
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'отзыва'
	return 'отзывов'
}
