/**
 * AI review reply + sentiment — Sepshn feature prototype (research 2026-05-30,
 * см. `project_ai_features_landscape_2026_05_30.md` приоритет #1).
 *
 * Берёт отзыв гостя (Островок / Авито / Яндекс) и за ОДИН вызов Yandex AI Studio:
 *   1. классифицирует тональность + темы;
 *   2. генерирует вежливый персональный ответ от лица отеля.
 *
 * Прямой аналог TravelLine TL:Reputation / Авито «умных отзывов», но целиком на
 * Yandex-стеке (канон «всё ИИ — только Yandex AI Studio»). Построено поверх
 * закалённого `chatCompletion` (PII-щит, SSRF, timeout, length-cap, логирование).
 *
 * Чистое разделение для тестируемости + дальнейшей встройки в обработку отзывов
 * из каналов: `buildReviewReplyMessages` (промпт) → `chatCompletion` → `parseReviewReply`.
 */

import { type ChatCompletionResult, type ChatMessage, chatCompletion } from './yandex-ai-studio.ts'
import type { YandexAiStudioConfig } from './yandex-ai-studio.ts'

/** Тональность отзыва. */
export type ReviewSentiment = 'positive' | 'negative' | 'mixed'

/** Канонический набор тем для малого гостеприимства РФ. */
export const REVIEW_TOPICS = [
	'чистота',
	'шум',
	'персонал',
	'цена',
	'локация',
	'удобства',
	'завтрак',
	'заселение',
	'другое',
] as const
export type ReviewTopic = (typeof REVIEW_TOPICS)[number]

export interface ReviewReply {
	readonly sentiment: ReviewSentiment
	readonly topics: readonly ReviewTopic[]
	/** Готовый ответ от лица отеля — хост проверяет одной кнопкой и публикует. */
	readonly reply: string
}

export interface ReviewContext {
	/** Название объекта размещения — подставляется в подпись ответа. */
	readonly propertyName: string
	/** Канал отзыва (для тона/контекста) — опционально. */
	readonly channel?: string
}

export type GenerateReviewReplyResult =
	| {
			readonly kind: 'ok'
			readonly result: ReviewReply
			readonly model: string
			readonly outputTokens: number
	  }
	| { readonly kind: 'not_configured'; readonly reason: string }
	| { readonly kind: 'rejected'; readonly message: string }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'unparseable'; readonly raw: string }

/**
 * Системный промпт — сердце фичи. Роль «менеджер отеля», тёплый RU-тон, правила
 * работы с негативом (признать → действие → приглашение, без споров), строгий
 * JSON на выходе. Темы ограничены каноническим списком, чтобы аналитика была
 * агрегируемой (сводка «8 жалоб на шум за месяц»).
 */
export function buildSystemPrompt(ctx: ReviewContext): string {
	return [
		`Ты — вежливый и профессиональный менеджер объекта размещения «${ctx.propertyName}».`,
		'Твоя задача — ответить на отзыв гостя и разметить его.',
		'',
		'Правила ОТВЕТА:',
		'- Пиши по-русски, тепло и по-человечески, от первого лица множественного числа («мы»).',
		'- Сначала поблагодари за отзыв.',
		'- Если отзыв положительный — искренне порадуйся и пригласи вернуться.',
		'- Если есть критика — спокойно признай проблему, КРАТКО скажи, что уже делается для',
		'  исправления, и пригласи снова. Не оправдывайся, не спорь, не обвиняй гостя.',
		'- Будь конкретным, живым, без канцелярита и шаблонов. Длина — 2–4 предложения.',
		'- НЕ выдумывай фактов и не обещай того, что нельзя гарантировать.',
		'',
		`Также определи тональность (одно из: positive, negative, mixed) и темы из списка: ${REVIEW_TOPICS.join(', ')}.`,
		'',
		'Верни СТРОГО валидный JSON БЕЗ markdown и без пояснений, в формате:',
		'{"sentiment": "...", "topics": ["..."], "reply": "..."}',
	].join('\n')
}

/** Собирает messages для chatCompletion: system (роль+правила) + user (текст отзыва). */
export function buildReviewReplyMessages(reviewText: string, ctx: ReviewContext): ChatMessage[] {
	return [
		{ role: 'system', text: buildSystemPrompt(ctx) },
		{ role: 'user', text: `Отзыв гостя:\n${reviewText.trim()}` },
	]
}

/**
 * Робастный парсер ответа модели: извлекает JSON-объект даже если модель обернула
 * его в текст/markdown, валидирует форму, нормализует темы к каноническому списку.
 * Возвращает `null`, если структура не извлекается (caller → fallback).
 */
export function parseReviewReply(raw: string): ReviewReply | null {
	const jsonText = extractJsonObject(raw)
	if (jsonText === null) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(jsonText)
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const obj = parsed as Record<string, unknown>

	const sentiment = obj.sentiment
	if (sentiment !== 'positive' && sentiment !== 'negative' && sentiment !== 'mixed') return null

	const reply = typeof obj.reply === 'string' ? obj.reply.trim() : ''
	if (reply.length === 0) return null

	const topicSet = new Set<ReviewTopic>()
	if (Array.isArray(obj.topics)) {
		for (const t of obj.topics) {
			if (typeof t === 'string' && (REVIEW_TOPICS as readonly string[]).includes(t)) {
				topicSet.add(t as ReviewTopic)
			}
		}
	}
	// Тем не нашлось среди канонических → «другое» (никогда не пустой массив).
	const topics = topicSet.size > 0 ? [...topicSet] : (['другое'] as ReviewTopic[])

	return { sentiment, topics, reply }
}

/** Вырезает первый сбалансированный {...}-блок из текста (модель иногда добавляет прозу). */
function extractJsonObject(text: string): string | null {
	const start = text.indexOf('{')
	if (start === -1) return null
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i]
		if (inString) {
			if (escaped) escaped = false
			else if (ch === '\\') escaped = true
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') inString = true
		else if (ch === '{') depth += 1
		else if (ch === '}') {
			depth -= 1
			if (depth === 0) return text.slice(start, i + 1)
		}
	}
	return null
}

/**
 * Полный путь: промпт → Yandex AI Studio → разобранный {sentiment, topics, reply}.
 * Все нештатные исходы (нет ключей / PII / ошибка сети / неразбираемый ответ)
 * возвращаются явными вариантами — caller решает, как деградировать.
 */
export async function generateReviewReply(
	reviewText: string,
	ctx: ReviewContext,
	config: YandexAiStudioConfig,
): Promise<GenerateReviewReplyResult> {
	const messages = buildReviewReplyMessages(reviewText, ctx)
	const completion: ChatCompletionResult = await chatCompletion(
		{ messages, temperature: 0.4, maxTokens: 700 },
		config,
	)
	switch (completion.kind) {
		case 'not_configured':
			return { kind: 'not_configured', reason: completion.reason }
		case 'rejected':
			return { kind: 'rejected', message: completion.message }
		case 'error':
			return { kind: 'error', message: `${completion.status}: ${completion.message}` }
		case 'ok': {
			const parsed = parseReviewReply(completion.text)
			if (parsed === null) return { kind: 'unparseable', raw: completion.text }
			return {
				kind: 'ok',
				result: parsed,
				model: completion.model,
				outputTokens: completion.usage.outputTokens,
			}
		}
	}
}
