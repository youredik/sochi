import {
	ReviewAiUnavailableError,
	ReviewNotFoundError,
	ReviewPublishFailedError,
	ReviewReplyRequiredError,
} from '../../errors/domain.ts'
import { generateReviewReply } from '../../lib/ai/review-reply.ts'
import type { YandexAiStudioConfig } from '../../lib/ai/yandex-ai-studio.ts'
import { seedDemoReviewsCore } from './review.demo-seed.ts'
import type { ReviewRepo } from './review.repo.ts'
import type { ReviewPublisher } from './review.publisher.ts'
import type { ChannelReview, ReviewSeedInput } from './review.types.ts'

export interface ReviewServiceDeps {
	readonly reviewRepo: ReviewRepo
	readonly publisher: ReviewPublisher
	readonly aiConfig: YandexAiStudioConfig
	/** Имя объекта для подписи ответа — инжектится (фабрика → propertyService). */
	readonly resolvePropertyName: (tenantId: string, propertyId: string) => Promise<string | null>
	/**
	 * Демо-ли тенант (organizationProfile.mode='demo'). Когда задан и у demo-org
	 * 0 отзывов — `list` лениво сеет канонический демо-набор под реальную property
	 * (always-on demo — фича должна быть видна визитёру). Prod → false → чистый read.
	 */
	readonly isDemoTenant?: (tenantId: string) => Promise<boolean>
	/** Инъекция времени для детерминированных тестов. */
	readonly now?: () => Date
}

/**
 * Review service — список / ИИ-черновик / правки / публикация. Чистый DI: repo,
 * AI-config, publisher-seam, resolvePropertyName, now — всё инжектится → полностью
 * тестируемо без сети/БД. Read-after-write возвращается в памяти (без re-read).
 */
export function createReviewService(deps: ReviewServiceDeps) {
	const nowFn = deps.now ?? (() => new Date())

	async function getOrThrow(tenantId: string, id: string): Promise<ChannelReview> {
		const review = await deps.reviewRepo.getById(tenantId, id)
		if (review === null) throw new ReviewNotFoundError(id)
		return review
	}

	return {
		/** Все отзывы объекта, новые сверху. Чистый read — GET остаётся safe-методом. */
		list(tenantId: string, propertyId: string): Promise<ChannelReview[]> {
			return deps.reviewRepo.listByProperty(tenantId, propertyId)
		},

		/**
		 * Идемпотентный демо-провизионинг: сеет канонический демо-набор отзывов под
		 * property, ЕСЛИ org в demo-режиме И отзывов ещё 0. WRITE-семантика —
		 * вызывается POST-эндпоинтом из reviews route loader (а НЕ сидится в GET,
		 * что нарушало бы «GET safe» — MDN/REST канон). Не-demo / уже есть → no-op.
		 */
		async provisionDemoReviews(
			tenantId: string,
			propertyId: string,
		): Promise<{ provisioned: number }> {
			if (deps.isDemoTenant === undefined || !(await deps.isDemoTenant(tenantId))) {
				return { provisioned: 0 }
			}
			const existing = await deps.reviewRepo.listByProperty(tenantId, propertyId)
			if (existing.length > 0) return { provisioned: 0 }
			const { created } = await seedDemoReviewsCore(deps.reviewRepo, tenantId, propertyId, nowFn())
			return { provisioned: created }
		},

		get: getOrThrow,

		/**
		 * Идемпотентный ingest отзыва из канала: тот же (channelCode, externalId)
		 * → существующая запись (без дубля). Путь для реального webhook-приёма +
		 * демо-сида.
		 */
		async ingest(tenantId: string, input: ReviewSeedInput): Promise<ChannelReview> {
			const existing = await deps.reviewRepo.findByExternal(
				tenantId,
				input.channelCode,
				input.externalId,
			)
			if (existing !== null) return existing
			const id = await deps.reviewRepo.create(tenantId, input, nowFn())
			return getOrThrow(tenantId, id)
		},

		/**
		 * ИИ-черновик: YandexGPT за один вызов размечает тональность+темы и пишет
		 * ответ. Сохраняет (status→'drafted') и возвращает обновлённый отзыв.
		 * Любой не-ok исход AI → `ReviewAiUnavailableError` (503, можно повторить).
		 */
		async generateReply(tenantId: string, id: string): Promise<ChannelReview> {
			const review = await getOrThrow(tenantId, id)
			const propertyName =
				(await deps.resolvePropertyName(tenantId, review.propertyId)) ?? 'наш объект размещения'
			const ai = await generateReviewReply(
				review.content,
				{ propertyName, channel: review.channelCode },
				deps.aiConfig,
			)
			if (ai.kind !== 'ok') {
				const detail =
					ai.kind === 'not_configured'
						? ai.reason
						: ai.kind === 'unparseable'
							? 'model returned unparseable output'
							: ai.message
				throw new ReviewAiUnavailableError(detail)
			}
			const at = nowFn()
			await deps.reviewRepo.saveAi(
				tenantId,
				id,
				{
					sentiment: ai.result.sentiment,
					topics: ai.result.topics,
					suggestedReply: ai.result.reply,
				},
				at,
			)
			return {
				...review,
				aiSentiment: ai.result.sentiment,
				aiTopics: ai.result.topics,
				suggestedReply: ai.result.reply,
				status: 'drafted',
				aiGeneratedAt: at.toISOString(),
				updatedAt: at.toISOString(),
			}
		},

		/** Сохранить правки хозяина без публикации. */
		async saveDraft(tenantId: string, id: string, hostReply: string): Promise<ChannelReview> {
			const trimmed = hostReply.trim()
			if (trimmed.length === 0) throw new ReviewReplyRequiredError()
			const review = await getOrThrow(tenantId, id)
			const at = nowFn()
			await deps.reviewRepo.saveReply(tenantId, id, trimmed, at)
			return { ...review, hostReply: trimmed, status: 'drafted', updatedAt: at.toISOString() }
		},

		/**
		 * Опубликовать ответ: сохраняем финальный текст, шлём в канал через
		 * publisher-seam, затем фиксируем status='published' + publishedAt.
		 * Канал отклонил → `ReviewPublishFailedError` (502), статус не меняется.
		 */
		async publish(tenantId: string, id: string, hostReply: string): Promise<ChannelReview> {
			const trimmed = hostReply.trim()
			if (trimmed.length === 0) throw new ReviewReplyRequiredError()
			const review = await getOrThrow(tenantId, id)
			await deps.reviewRepo.saveReply(tenantId, id, trimmed, nowFn())
			const published = await deps.publisher.publish({
				channelCode: review.channelCode,
				externalId: review.externalId,
				propertyId: review.propertyId,
				reply: trimmed,
			})
			if (!published.ok) throw new ReviewPublishFailedError(published.reason)
			const at = nowFn()
			await deps.reviewRepo.markPublished(tenantId, id, trimmed, at)
			return {
				...review,
				hostReply: trimmed,
				status: 'published',
				publishedAt: at.toISOString(),
				updatedAt: at.toISOString(),
			}
		},
	}
}

export type ReviewService = ReturnType<typeof createReviewService>
