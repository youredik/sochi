/**
 * AI-driven full-cycle E2E через Stagehand v3 (canonical May 2026 per 3-agent
 * web research). Natural-language Russian intent → Stagehand picks DOM selectors
 * → cache + replay (subsequent runs free, deterministic).
 *
 * User trigger 2026-05-24: «применять на постоянной основе ... ИИ ... ты даёшь
 * ему задание а он всё проверяет». Verdict 3-agent research:
 *   - Stagehand v3 best для creative flows (natural language + auto-cache)
 *   - Playwright MCP best для interactive Claude Code authoring
 *   - browser-use Python-only, skip
 *   - Computer Use research-preview, expensive
 *   - Mabl/Testim enterprise legacy
 *
 * **Required env**: `ANTHROPIC_API_KEY` (claude-opus-4-7 model). For RU data
 * residency (152-ФЗ): swap к `modelName: 'yandexgpt/latest'` + custom proxy.
 *
 * **Hybrid pattern** per canon:
 *   - 90% deterministic Playwright (existing tests/e2e/*.spec.ts)
 *   - 5-10% Stagehand для brittle Cyrillic / vision flows (этот spec)
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... pnpm exec playwright test \
 *     tests/e2e/full-cycle-ai-stagehand.spec.ts --project=smoke --workers=1
 *
 * First-run: LLM picks selectors (~30-60s, ~$0.10 в Opus tokens).
 * Cached re-runs: deterministic replay (~5-10s, $0).
 */
import { Stagehand } from '@browserbasehq/stagehand'
import { expect, test } from '@playwright/test'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5273'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? ''

test.skip(
	!ANTHROPIC_API_KEY,
	'ANTHROPIC_API_KEY не задан — Stagehand AI-driven test пропущен. ' +
		'Set ANTHROPIC_API_KEY в env чтобы запустить (claude-opus-4-7, ~$0.10/run, cached free after).',
)

test('AI-driven full cycle: signup → 10 номеров → бронирование → паспорт-скан', async () => {
	test.setTimeout(180_000)
	const ts = Date.now().toString().slice(-6)

	const stagehand = new Stagehand({
		env: 'LOCAL',
		modelName: 'claude-opus-4-7',
		modelClientOptions: { apiKey: ANTHROPIC_API_KEY },
		enableCaching: true,
		domSettleTimeoutMs: 3000,
		verbose: 1,
	})
	await stagehand.init()
	const page = stagehand.page

	try {
		// === [Step 1] Signup new hotel owner ===
		await page.goto(`${BASE_URL}/signup`)
		await page.act(
			`Заполни форму регистрации: email "ai-stagehand-${ts}@sochi.local", ` +
				`название гостиницы "Stagehand E2E Hotel ${ts}", ` +
				`согласие checked. Нажми кнопку «Получить ссылку для регистрации».`,
		)
		const sent = await page.extract({
			instruction: 'Появилось ли сообщение «Письмо отправлено»?',
			schema: { type: 'object', properties: { sent: { type: 'boolean' } } },
		})
		expect((sent as { sent: boolean }).sent, 'Magic-link отправлен через Mailpit').toBe(true)
		console.log(`[1] Signup — magic-link sent для ai-stagehand-${ts}@sochi.local`)

		// === [Step 2] Open magic-link from Mailpit ===
		// Stagehand can fetch magic-link через page.goto + Mailpit API
		const mailpitResp = await page.request.get(
			`http://localhost:8125/api/v1/search?query=to:ai-stagehand-${ts}@sochi.local`,
		)
		const mailpit = (await mailpitResp.json()) as {
			messages: Array<{ ID: string }>
		}
		expect(mailpit.messages.length, 'Mailpit получил magic-link').toBeGreaterThan(0)
		const messageId = mailpit.messages[0]?.ID
		const messageBody = await (
			await page.request.get(`http://localhost:8125/api/v1/message/${messageId}`)
		).json()
		const url = (messageBody as { Text: string }).Text.match(
			/https?:\/\/localhost:\d+\/[^\s]*verify[^\s]*/,
		)?.[0]
		expect(url, 'Magic-link URL extracted').toBeTruthy()
		await page.goto(url ?? '')
		console.log(`[2] Magic-link visited`)

		// === [Step 3] Welcome → Create organization ===
		await page.act(`Подтверди создание гостиницы — нажми «Создать гостиницу →».`)
		await page.waitForURL(/\/o\//, { timeout: 20_000 })
		console.log(`[3] Organization created`)

		// === [Step 4] Onboarding wizard ===
		await page.act(
			'Пройди мастер настройки: ИНН "2320000001", найди организацию, ' +
				'выбери первую совпадающую. На втором шаге — задай 2 типа номеров (можно skip).',
		)
		// Wait для landing на /grid OR /setup completion
		await page.waitForURL(/\/o\/[^/]+\/(grid|admin|setup)/, { timeout: 30_000 })
		console.log(`[4] Wizard completed → tenant ready`)

		// === [Step 5] Create 10 rooms через UI ===
		await page.act(
			'Перейди в раздел номеров. Создай 10 номеров с номерами от 101 до 110, ' +
				'тип «Стандарт», на этажах 1-4. Цена 4500 ₽/ночь.',
		)
		const roomsCount = await page.extract({
			instruction: 'Сколько номеров в списке? Верни число.',
			schema: { type: 'object', properties: { count: { type: 'number' } } },
		})
		expect((roomsCount as { count: number }).count, '≥10 номеров создано').toBeGreaterThanOrEqual(
			10,
		)
		console.log(`[5] ${(roomsCount as { count: number }).count} комнат создано`)

		// === [Step 6] Create booking ===
		await page.act(
			'Создай новое бронирование на 2 ночи начиная с завтра, ' +
				'гость Иван Иванов, гражданство RU, паспорт 4510 ' +
				ts +
				', тип номера Стандарт.',
		)
		await page.act('Сохрани бронирование')
		console.log(`[6] Booking created`)

		// === [Step 7] Open passport-scan dialog + scan ===
		await page.act(
			'Открой бронирование которое только что создал. Найди кнопку «Сканировать паспорт» ' +
				'и нажми её. В диалоге согласись с 152-ФЗ (3 чекбокса), загрузи тестовый файл, ' +
				'сохрани результат сканирования.',
		)
		const scanResult = await page.extract({
			instruction:
				'Был ли сохранён результат сканирования? Появилось ли сообщение об успехе или ' +
				'данные документа в форме (серия+номер паспорта)?',
			schema: { type: 'object', properties: { success: { type: 'boolean' } } },
		})
		expect((scanResult as { success: boolean }).success, 'Passport scan committed').toBe(true)
		console.log(`[7] ✅ FULL CYCLE PASS — passport-scan complete через Mock Vision`)
	} finally {
		await stagehand.close()
	}
})
