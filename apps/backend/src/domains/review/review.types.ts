import type { ReviewSentiment, ReviewTopic } from '../../lib/ai/review-reply.ts'

export type { ReviewSentiment, ReviewTopic }

/**
 * 'new'       — пришёл из канала, ИИ ещё не размечал.
 * 'drafted'   — есть ИИ-черновик ответа и/или правки хозяина; не опубликован.
 * 'published' — ответ опубликован обратно в канал.
 */
export type ReviewStatus = 'new' | 'drafted' | 'published'

export interface ChannelReview {
	readonly id: string
	readonly tenantId: string
	readonly channelCode: string
	readonly externalId: string
	readonly propertyId: string
	readonly guestName: string
	readonly ratingOverall: number | null
	readonly content: string
	readonly aiSentiment: ReviewSentiment | null
	readonly aiTopics: readonly ReviewTopic[] | null
	/** Черновик ответа от ИИ (хозяин редактирует перед публикацией). */
	readonly suggestedReply: string | null
	/** Финальный ответ хозяина (после правок). */
	readonly hostReply: string | null
	readonly status: ReviewStatus
	readonly reviewedAt: string
	readonly aiGeneratedAt: string | null
	readonly publishedAt: string | null
	readonly createdAt: string
	readonly updatedAt: string
}

/** Вход для ingest/seed отзыва из канала. */
export interface ReviewSeedInput {
	readonly channelCode: string
	readonly externalId: string
	readonly propertyId: string
	readonly guestName: string
	readonly ratingOverall: number | null
	readonly content: string
	/** ISO-8601 дата отзыва в канале. */
	readonly reviewedAt: string
}
