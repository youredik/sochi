import {
	Loader2Icon,
	RefreshCwIcon,
	SaveIcon,
	SendIcon,
	SparklesIcon,
	StarIcon,
} from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '../../../components/ui/card.tsx'
import { Textarea } from '../../../components/ui/textarea.tsx'
import { cn } from '../../../lib/utils.ts'
import {
	useGenerateReply,
	usePublishReply,
	useSaveDraft,
	type ReviewDto,
} from '../hooks/use-reviews.ts'
import {
	channelLabel,
	formatReviewDate,
	sentimentMeta,
	statusMeta,
	type ReviewSentiment,
	type ReviewStatus,
} from '../lib/review-format.ts'

const MAX_RATING = 5
const STAR_POSITIONS = Array.from({ length: MAX_RATING }, (_, i) => i + 1)
const REPLY_MAX = 4000

function RatingStars({ rating }: { rating: number | null }) {
	if (rating === null) {
		return <span className="text-muted-foreground text-xs">Без оценки</span>
	}
	return (
		<span
			role="img"
			className="inline-flex items-center gap-0.5"
			aria-label={`Оценка ${rating} из ${MAX_RATING}`}
		>
			{STAR_POSITIONS.map((position) => (
				<StarIcon
					key={position}
					aria-hidden
					className={cn(
						'size-4',
						position <= rating
							? 'fill-amber-400 text-amber-400'
							: 'fill-muted text-muted-foreground/40',
					)}
				/>
			))}
		</span>
	)
}

export function ReviewCard({ review, propertyId }: { review: ReviewDto; propertyId: string }) {
	const generate = useGenerateReply(propertyId)
	const saveDraft = useSaveDraft(propertyId)
	const publish = usePublishReply(propertyId)
	const replyFieldId = useId()

	// Редактируемый текст ответа: правки хозяина приоритетнее ИИ-черновика.
	const sourceText = review.hostReply ?? review.suggestedReply ?? ''
	const [draft, setDraft] = useState(sourceText)

	// Синхронизируем поле, когда снизу пришёл новый черновик (ИИ сгенерировал /
	// сохранение прошло). Мутации запускаются только по действию пользователя,
	// поэтому перезатирания «на лету» не происходит.
	useEffect(() => {
		setDraft(sourceText)
	}, [sourceText])

	const status = review.status as ReviewStatus
	const isPublished = status === 'published'
	const hasDraft = review.suggestedReply !== null || review.hostReply !== null
	const trimmed = draft.trim()
	const busy = generate.isPending || saveDraft.isPending || publish.isPending
	const sMeta = statusMeta(status)

	return (
		<Card aria-label={`Отзыв от ${review.guestName}`}>
			<CardHeader>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<CardTitle className="text-base">{review.guestName}</CardTitle>
					<div className="flex flex-wrap items-center gap-2">
						<RatingStars rating={review.ratingOverall} />
						<Badge variant="outline">{channelLabel(review.channelCode)}</Badge>
						<Badge variant={sMeta.variant}>{sMeta.label}</Badge>
					</div>
				</div>
				<CardDescription>
					{formatReviewDate(review.reviewedAt)}
					{review.aiSentiment !== null && (
						<>
							{' · '}
							<span className="inline-flex items-center gap-1.5 align-middle">
								<Badge variant={sentimentMeta(review.aiSentiment as ReviewSentiment).variant}>
									{sentimentMeta(review.aiSentiment as ReviewSentiment).label}
								</Badge>
								{(review.aiTopics ?? []).map((topic) => (
									<Badge key={topic} variant="secondary">
										{topic}
									</Badge>
								))}
							</span>
						</>
					)}
				</CardDescription>
			</CardHeader>

			<CardContent className="space-y-4">
				<blockquote className="border-l-2 pl-3 text-sm text-muted-foreground italic">
					{review.content}
				</blockquote>

				{!hasDraft ? (
					<Button
						type="button"
						onClick={() => generate.mutate({ id: review.id })}
						disabled={busy}
						className="w-full sm:w-auto"
					>
						{generate.isPending ? (
							<>
								<Loader2Icon className="animate-spin" aria-hidden /> ИИ пишет ответ…
							</>
						) : (
							<>
								<SparklesIcon aria-hidden /> Подготовить ответ ИИ
							</>
						)}
					</Button>
				) : (
					<div className="space-y-2">
						<label htmlFor={replyFieldId} className="text-sm font-medium">
							Ответ гостю
						</label>
						<Textarea
							id={replyFieldId}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							rows={4}
							maxLength={REPLY_MAX}
							readOnly={isPublished}
							placeholder="Текст ответа…"
							aria-describedby={`${replyFieldId}-hint`}
						/>
						<p id={`${replyFieldId}-hint`} className="text-xs text-muted-foreground">
							{isPublished
								? `Опубликован ${formatReviewDate(review.publishedAt ?? review.updatedAt)}.`
								: 'Черновик подготовлен ИИ (YandexGPT). Отредактируйте перед публикацией.'}
						</p>

						{!isPublished && (
							<div className="flex flex-wrap gap-2 pt-1">
								<Button
									type="button"
									onClick={() => publish.mutate({ id: review.id, reply: trimmed })}
									disabled={busy || trimmed.length === 0}
								>
									{publish.isPending ? (
										<Loader2Icon className="animate-spin" aria-hidden />
									) : (
										<SendIcon aria-hidden />
									)}
									Опубликовать
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={() => saveDraft.mutate({ id: review.id, reply: trimmed })}
									disabled={busy || trimmed.length === 0}
								>
									{saveDraft.isPending ? (
										<Loader2Icon className="animate-spin" aria-hidden />
									) : (
										<SaveIcon aria-hidden />
									)}
									Сохранить черновик
								</Button>
								<Button
									type="button"
									variant="ghost"
									onClick={() => generate.mutate({ id: review.id })}
									disabled={busy}
								>
									{generate.isPending ? (
										<Loader2Icon className="animate-spin" aria-hidden />
									) : (
										<RefreshCwIcon aria-hidden />
									)}
									Перегенерировать
								</Button>
							</div>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	)
}
