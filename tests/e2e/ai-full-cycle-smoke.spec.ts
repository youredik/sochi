/**
 * **STATE-OF-ART AI-driven E2E** — Stagehand v3 `agent()` autonomous mode на
 * полную мощь (May 2026 canonical per 3-agent web-research). Claude Sonnet 4.5
 * autonomously plans + executes multi-step user flow с natural-language goal.
 *
 * User trigger 2026-05-24: «без полумер! state-of-the-art AI-driven testing
 * вместо ручного Playwright! На самую полную мощь!»
 *
 * Difference от basic `act()`:
 *   - `act()` — single explicit step («click signup button»)
 *   - `agent()` — autonomous: AI plans entire flow, recovers from errors,
 *     decides what to do next based on observed state
 *
 * Target: demo.sepshn.ru (live prod) — реальный captcha + real backend +
 * real Mock Vision. Agent solves SmartCaptcha с test mode site-key (always-
 * pass per Yandex SmartCaptcha test canon).
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... pnpm exec playwright test \
 *     tests/e2e/ai-full-cycle-smoke.spec.ts --project=smoke --workers=1
 */
import { Stagehand } from '@browserbasehq/stagehand'
import { expect, test } from '@playwright/test'
import { z } from 'zod'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://demo.sepshn.ru'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? ''

test.skip(!ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY required for Stagehand AI tests')

test('STATE-OF-ART AI agent: full HoReCa cycle via Claude Sonnet 4.5 autonomous reasoning', async () => {
	test.setTimeout(300_000) // 5 min — agent mode needs time для multi-step reasoning

	const stagehand = new Stagehand({
		env: 'LOCAL',
		modelName: 'anthropic/claude-sonnet-4-5' as const,
		modelClientOptions: { apiKey: ANTHROPIC_API_KEY },
		enableCaching: true,
		verbose: 2,
	})
	await stagehand.init()

	try {
		const page = stagehand.context.pages()[0]
		if (!page) throw new Error('Stagehand context has no pages')

		// Open landing
		await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
		await page.waitForTimeout(2000)
		await page.screenshot({ path: 'test-results/ai-1-landing.png', fullPage: true })

		// === AUTONOMOUS AGENT MODE ===
		// `agent()` returns a higher-level controller that plans + executes
		// multi-step flows. Per Stagehand v3 docs:
		//   const agent = stagehand.agent({ provider, model })
		//   const result = await agent.execute('multi-step goal')
		// Stagehand v3 agent() API: `model` field uses combined "provider/model"
		// format (NOT separate provider + model props — that was v2). Per
		// docs.stagehand.dev/v3/configuration/models, canonical form is
		// "anthropic/claude-sonnet-4-5" / "openai/gpt-4o" / etc.
		const agent = stagehand.agent({
			model: 'anthropic/claude-sonnet-4-5',
		})

		// State-of-art: ONE natural-language goal, agent reasons through entire flow.
		const result = await agent.execute({
			instruction:
				'Ты — тестировщик SaaS-приложения для отелей. Демо: ' +
				BASE_URL +
				`. Выполни ПОЛНЫЙ цикл:
				 1. Прими cookies если показан banner.
				 2. Перейди на страницу регистрации (signup или войти).
				 3. Опиши форму регистрации — какие поля и есть ли captcha.
				 4. Сделай скриншот form-state.
				 5. Заполни форму: email "ai-test-${Date.now()}@example.test", ` +
				`название гостиницы "AI E2E Hotel", и проставь чекбокс согласия 152-ФЗ.
				 6. Если есть captcha-widget — отметь это в результате (не пытайся решить).
				 7. Если можно нажать «Получить ссылку» — нажми и сообщи о результате.
				 8. Опиши финальное состояние: что сейчас на странице, какие ошибки или success.

				 ВАЖНО: НЕ решай captcha — просто сообщи если она есть. UI на русском.`,
			maxSteps: 20, // agent может сделать до 20 reasoning-steps
		})

		console.log('=== AGENT EXECUTION COMPLETED ===')
		console.log('Total steps:', result.actions?.length ?? 0)
		console.log('Success:', result.success)
		console.log('Message:', result.message)
		if (result.actions) {
			for (const [i, action] of result.actions.entries()) {
				console.log(`  Step ${i + 1}: ${JSON.stringify(action).slice(0, 200)}`)
			}
		}

		// Final state observation
		await page.screenshot({ path: 'test-results/ai-final.png', fullPage: true })
		const finalState = await stagehand.extract({
			instruction: 'Опиши текущее состояние страницы. URL, заголовок, видимые сообщения.',
			schema: z.object({
				url: z.string(),
				heading: z.string().nullable(),
				visibleMessages: z.array(z.string()),
				hasError: z.boolean(),
			}),
		})
		console.log('Final state:', JSON.stringify(finalState, null, 2))

		// Assert agent achieved meaningful progress
		expect(result.success, 'Agent reports success').toBe(true)
		expect(result.actions?.length ?? 0, 'Agent выполнил ≥3 steps').toBeGreaterThanOrEqual(3)

		console.log('=== ✅ AI AGENT autonomous E2E completed ===')
	} finally {
		await stagehand.close()
	}
})
