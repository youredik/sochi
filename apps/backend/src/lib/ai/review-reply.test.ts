/**
 * Strict unit tests для AI review-reply прототипа. Без сети — `generateReviewReply`
 * тестируется через DI `fetchImpl` (mock-ответ Yandex AI Studio), парсинг и промпт
 * — как чистые функции.
 */

import { describe, expect, test } from 'bun:test'
import {
	buildReviewReplyMessages,
	buildSystemPrompt,
	generateReviewReply,
	parseReviewReply,
	REVIEW_TOPICS,
} from './review-reply.ts'
import type { YandexAiStudioConfig } from './yandex-ai-studio.ts'

const CTX = { propertyName: 'Гостевой дом «Сириус»' }

/** Mock Yandex AI Studio HTTP-ответ с заданным текстом completion. */
function mockConfig(completionText: string): YandexAiStudioConfig {
	const fetchImpl = (async () =>
		new Response(
			JSON.stringify({
				result: {
					alternatives: [{ message: { text: completionText } }],
					usage: { inputTextTokens: '120', completionTokens: '80' },
				},
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)) as unknown as typeof fetch
	return { apiKey: 'test-key', folderId: 'test-folder', model: 'yandexgpt/latest', fetchImpl }
}

describe('buildSystemPrompt / messages', () => {
	test('system prompt несёт роль, имя объекта, список тем и требование JSON', () => {
		const sys = buildSystemPrompt(CTX)
		expect(sys).toContain('Гостевой дом «Сириус»')
		expect(sys).toContain('менеджер')
		expect(sys).toContain('JSON')
		expect(sys).toContain('sentiment')
		for (const topic of REVIEW_TOPICS) expect(sys).toContain(topic)
	})

	test('messages = system + user с текстом отзыва', () => {
		const msgs = buildReviewReplyMessages('Всё супер, спасибо!', CTX)
		expect(msgs).toHaveLength(2)
		expect(msgs[0]?.role).toBe('system')
		expect(msgs[1]?.role).toBe('user')
		expect(msgs[1]?.text).toContain('Всё супер, спасибо!')
	})
})

describe('parseReviewReply', () => {
	test('чистый валидный JSON → разобран', () => {
		const r = parseReviewReply(
			'{"sentiment":"negative","topics":["шум","чистота"],"reply":"Извините за неудобства."}',
		)
		expect(r).not.toBeNull()
		expect(r?.sentiment).toBe('negative')
		expect(r?.topics).toEqual(['шум', 'чистота'])
		expect(r?.reply).toBe('Извините за неудобства.')
	})

	test('JSON, обёрнутый в прозу / markdown → извлечён', () => {
		const raw =
			'Вот ответ:\n```json\n{"sentiment":"positive","topics":["персонал"],"reply":"Спасибо!"}\n```\nГотово.'
		const r = parseReviewReply(raw)
		expect(r?.sentiment).toBe('positive')
		expect(r?.reply).toBe('Спасибо!')
	})

	test('неканонические темы отфильтрованы; пусто → ["другое"]', () => {
		const r = parseReviewReply(
			'{"sentiment":"mixed","topics":["вайб","нло"],"reply":"Спасибо за отзыв!"}',
		)
		expect(r?.topics).toEqual(['другое'])
	})

	test('невалидная тональность → null', () => {
		expect(parseReviewReply('{"sentiment":"ok","topics":[],"reply":"x"}')).toBeNull()
	})

	test('пустой reply → null', () => {
		expect(parseReviewReply('{"sentiment":"positive","topics":["цена"],"reply":"   "}')).toBeNull()
	})

	test('мусор без JSON → null', () => {
		expect(parseReviewReply('никакого json тут нет')).toBeNull()
		expect(parseReviewReply('{сломанный')).toBeNull()
	})
})

describe('generateReviewReply (через mock fetch)', () => {
	test('ok: валидный ответ модели → разобранный результат', async () => {
		const res = await generateReviewReply(
			'Грязно и шумно ночью',
			CTX,
			mockConfig(
				'{"sentiment":"negative","topics":["чистота","шум"],"reply":"Извините, уже исправляем."}',
			),
		)
		expect(res.kind).toBe('ok')
		if (res.kind === 'ok') {
			expect(res.result.sentiment).toBe('negative')
			expect(res.result.topics).toContain('шум')
			expect(res.outputTokens).toBe(80)
		}
	})

	test('unparseable: модель вернула не-JSON', async () => {
		const res = await generateReviewReply('Отлично!', CTX, mockConfig('просто текст без json'))
		expect(res.kind).toBe('unparseable')
	})

	test('not_configured: нет ключей', async () => {
		const res = await generateReviewReply('Отлично!', CTX, {
			apiKey: undefined,
			folderId: undefined,
			model: 'yandexgpt/latest',
		})
		expect(res.kind).toBe('not_configured')
	})
})
