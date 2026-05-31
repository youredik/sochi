import { logger } from '../../logger.ts'

export interface ReviewPublishInput {
	readonly channelCode: string
	readonly externalId: string
	readonly propertyId: string
	readonly reply: string
}

export type ReviewPublishResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string }

/**
 * Seam для публикации ответа хозяина обратно в канал (Островок / Авито / Яндекс).
 * Service зависит ТОЛЬКО от этого интерфейса — реальные per-channel издатели
 * подключаются без изменения бизнес-логики (адаптерный канон, как channel-mocks).
 */
export interface ReviewPublisher {
	publish(input: ReviewPublishInput): Promise<ReviewPublishResult>
}

/**
 * Mock-издатель — behaviour-faithful: логирует и возвращает ok. Используется для
 * демо и пока каналы не открыли публичные review-reply API (на 2026 у Островка/
 * Авито их нет в открытом доступе — см. research). Реальные издатели слотятся
 * сюда же без касания service.
 */
export function createMockReviewPublisher(): ReviewPublisher {
	return {
		async publish(input: ReviewPublishInput): Promise<ReviewPublishResult> {
			logger.info(
				{
					event: 'review.publish.mock',
					channel: input.channelCode,
					externalId: input.externalId,
					replyLen: input.reply.length,
				},
				'review reply published (mock)',
			)
			return { ok: true }
		},
	}
}
