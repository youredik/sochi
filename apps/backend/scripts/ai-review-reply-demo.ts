/**
 * Демо прототипа «AI-ответы на отзывы» на Yandex AI Studio.
 *
 * Прогоняет набор реалистичных отзывов через `generateReviewReply` и печатает:
 *   отзыв → тональность + темы → готовый ответ (+ латентность, токены).
 *
 * Запуск (из apps/backend):
 *   bun --env-file=../../.env scripts/ai-review-reply-demo.ts
 *
 * Нужны env: YANDEX_AI_API_KEY + YANDEX_AI_FOLDER_ID (+ опц. YANDEX_AI_MODEL).
 * Без ключей скрипт честно сообщит, что нужно для живого прогона.
 */

import { generateReviewReply, type ReviewContext } from '../src/lib/ai/review-reply.ts'
import { readConfigFromEnv } from '../src/lib/ai/yandex-ai-studio.ts'

const CTX: ReviewContext = { propertyName: 'Гостевой дом «Сириус»', channel: 'Островок' }

const REVIEWS: readonly string[] = [
	'Прекрасный дом, всё чисто, хозяева очень приветливые. Обязательно вернёмся!',
	'Грязно в номере, в душе плесень, и всю ночь шумел кондиционер. Не рекомендую.',
	'Локация супер, рядом море. Но завтрак скудный, а персонал на ресепшене грубоват.',
	'Заселили на час позже, ключи не работали, пришлось ждать на улице с детьми.',
	'Уютно, тихо, отличное соотношение цены и качества. Спасибо за тёплый приём!',
	'Номер хороший, но за такие деньги ожидали завтрак получше и нормальную парковку.',
	'Фото не соответствуют реальности — номер меньше и старее, чем на снимках. Разочарованы.',
	'Чистота идеальная, всё новое, рядом магазины и кафе. Лучшее место в Сочи!',
	'Очень шумно: окна выходят прямо на дорогу, спать ночью невозможно.',
	'Сам дом приятный, но Wi-Fi почти не работал, а мне важно работать удалённо.',
	'Хозяйка встретила, всё показала, подсказала, куда сходить. Очень душевно, спасибо!',
	'Холодно, отопление не работало, и никто не реагировал на просьбы починить.',
]

const SENTIMENT_LABEL: Record<string, string> = {
	positive: 'ПОЗИТИВ',
	negative: 'НЕГАТИВ',
	mixed: 'СМЕШАННЫЙ',
}

async function main(): Promise<void> {
	const config = readConfigFromEnv()
	console.log('='.repeat(72))
	console.log(`AI-ответы на отзывы — демо | модель: ${config.model} | объект: ${CTX.propertyName}`)
	console.log('='.repeat(72))

	// Быстрая проба конфигурации до прогона всех отзывов.
	const probe = await generateReviewReply(REVIEWS[0] as string, CTX, config)
	if (probe.kind === 'not_configured') {
		console.log('\n[нет ключей] Для ЖИВОГО прогона нужны переменные окружения:')
		console.log(
			'  YANDEX_AI_API_KEY=<ключ сервисного аккаунта Yandex с ролью ai.languageModels.user>',
		)
		console.log('  YANDEX_AI_FOLDER_ID=<id каталога Yandex Cloud>')
		console.log('  YANDEX_AI_MODEL=yandexgpt/latest   (необязательно)')
		console.log('\nПоложи их в .env — и запусти снова. Код прототипа готов и протестирован.')
		return
	}

	const sentimentCounts: Record<string, number> = { positive: 0, negative: 0, mixed: 0 }
	const topicCounts = new Map<string, number>()
	let totalMs = 0
	let okCount = 0

	for (const [i, review] of REVIEWS.entries()) {
		const t0 = Date.now()
		const res = await generateReviewReply(review, CTX, config)
		const ms = Date.now() - t0
		totalMs += ms

		console.log(`\n— Отзыв ${i + 1}/${REVIEWS.length} ${'-'.repeat(40)}`)
		console.log(`  «${review}»`)
		if (res.kind === 'ok') {
			okCount += 1
			sentimentCounts[res.result.sentiment] = (sentimentCounts[res.result.sentiment] ?? 0) + 1
			for (const tp of res.result.topics) topicCounts.set(tp, (topicCounts.get(tp) ?? 0) + 1)
			console.log(
				`  [${SENTIMENT_LABEL[res.result.sentiment]}] темы: ${res.result.topics.join(', ')}  (${ms}мс, ${res.outputTokens} ток.)`,
			)
			console.log(`  Ответ: ${res.result.reply}`)
		} else if (res.kind === 'unparseable') {
			console.log(`  [не разобрал JSON] сырой ответ: ${res.raw.slice(0, 160)}`)
		} else if (res.kind === 'rejected') {
			console.log(`  [отклонено щитом] ${res.message}`)
		} else if (res.kind === 'error') {
			console.log(`  [ошибка] ${res.message}`)
		}
	}

	console.log(`\n${'='.repeat(72)}`)
	console.log('СВОДКА ДЛЯ ХОЗЯИНА (то, что увидит в кабинете):')
	console.log(
		`  Тональность: позитив ${sentimentCounts.positive}, негатив ${sentimentCounts.negative}, смешанный ${sentimentCounts.mixed}`,
	)
	const topTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1])
	console.log(`  Чаще всего упоминают: ${topTopics.map(([t, n]) => `${t} (${n})`).join(', ')}`)
	console.log(
		`  Обработано ${okCount}/${REVIEWS.length} отзывов, средняя скорость ответа ~${Math.round(totalMs / REVIEWS.length)}мс.`,
	)
	console.log('='.repeat(72))
}

main().catch((err) => {
	console.error('demo failed:', err instanceof Error ? err.message : String(err))
	process.exit(1)
})
