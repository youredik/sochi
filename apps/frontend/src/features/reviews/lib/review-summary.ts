/**
 * Pure review-inbox summary derivation (AI review-reply 2026-05-30).
 *
 * Хозяину одной кнопкой: сколько отзывов, средний рейтинг, разбивка тональности,
 * топ-темы. Чистая детерминированная функция (no Date.now, no Math.random) —
 * полностью unit-тестируема и переиспользуема (дашборд, email-дайджест, MCP).
 *
 * Вход структурный (не привязан к RPC-типу) — принимает любой объект с нужными
 * полями, поэтому ReviewDto подходит по структуре без импорта тяжёлого клиента.
 */

import type { ReviewSentiment, ReviewStatus } from './review-format.ts'

export interface SummarizableReview {
	readonly ratingOverall: number | null
	readonly aiSentiment: ReviewSentiment | null
	readonly aiTopics: readonly string[] | null
	readonly status: ReviewStatus
}

export interface TopicCount {
	readonly topic: string
	readonly count: number
}

export interface ReviewSummary {
	readonly total: number
	readonly newCount: number
	readonly draftedCount: number
	readonly publishedCount: number
	readonly ratedCount: number
	/** Средний рейтинг по оценённым отзывам, округл. до 0.1; null если оценок нет. */
	readonly avgRating: number | null
	readonly sentiment: {
		readonly positive: number
		readonly negative: number
		readonly mixed: number
	}
	/** Топ-3 темы по частоте (убыв.), тай-брейк по алфавиту для детерминизма. */
	readonly topTopics: readonly TopicCount[]
}

const TOP_TOPICS_LIMIT = 3

export function summarizeReviews(reviews: readonly SummarizableReview[]): ReviewSummary {
	let newCount = 0
	let draftedCount = 0
	let publishedCount = 0
	let ratingSum = 0
	let ratedCount = 0
	const sentiment = { positive: 0, negative: 0, mixed: 0 }
	const topicCounts = new Map<string, number>()

	for (const r of reviews) {
		if (r.status === 'new') newCount++
		else if (r.status === 'drafted') draftedCount++
		else if (r.status === 'published') publishedCount++

		if (r.ratingOverall !== null) {
			ratingSum += r.ratingOverall
			ratedCount++
		}

		if (r.aiSentiment !== null) sentiment[r.aiSentiment]++

		if (r.aiTopics !== null) {
			for (const topic of r.aiTopics) {
				topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
			}
		}
	}

	const avgRating = ratedCount === 0 ? null : Math.round((ratingSum / ratedCount) * 10) / 10

	const topTopics = [...topicCounts.entries()]
		.map(([topic, count]) => ({ topic, count }))
		.sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic, 'ru'))
		.slice(0, TOP_TOPICS_LIMIT)

	return {
		total: reviews.length,
		newCount,
		draftedCount,
		publishedCount,
		ratedCount,
		avgRating,
		sentiment,
		topTopics,
	}
}
