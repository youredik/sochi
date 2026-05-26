/**
 * Round 14 + self-review #3 — Yandex AI Studio client tests (mocked fetch).
 *
 * Coverage:
 * - YAI1-2: not_configured paths
 * - YAI3:   happy path response parsing
 * - YAI4:   non-2xx error path
 * - YAI5:   request shape (Authorization, modelUri, NO x-folder-id header)
 * - YAI6-7: readConfigFromEnv defaults / overrides
 * - YAI8:   network error path (fetch throws)
 * - YAI9:   AbortController timeout path (408)
 * - YAI10:  malformed JSON response
 * - YAI11:  missing alternatives (empty completion)
 * - YAI12:  token count parser robustness (string + number + null)
 * - YAI13:  reserved-test PII shield — non-reserved-test phone rejected
 * - YAI14:  reserved-test PII shield — passport-like number rejected
 * - YAI15:  reserved-test email (@example.com) allowed through
 * - YAI16:  prompt-too-long rejected before fetch
 * - YAI17:  SSRF endpoint whitelist (non-fetchImpl path)
 */

import { describe, expect, test } from 'bun:test'
import { chatCompletion, readConfigFromEnv } from './yandex-ai-studio.ts'

describe('Yandex AI Studio HTTP client', () => {
	test('[YAI1] not_configured когда no API key', async () => {
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{ apiKey: undefined, folderId: 'f1', model: 'yandexgpt-lite/latest' },
		)
		expect(result.kind).toBe('not_configured')
	})

	test('[YAI2] not_configured когда no folderId', async () => {
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{ apiKey: 'k1', folderId: undefined, model: 'yandexgpt-lite/latest' },
		)
		expect(result.kind).toBe('not_configured')
	})

	test('[YAI3] happy path parses Yandex AI Studio response', async () => {
		const fakeFetch = async () =>
			new Response(
				JSON.stringify({
					result: {
						alternatives: [{ message: { text: 'Hello! How can I help you?' } }],
						usage: { inputTextTokens: '5', completionTokens: '8' },
					},
				}),
				{ status: 200 },
			)
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('ok')
		if (result.kind === 'ok') {
			expect(result.text).toBe('Hello! How can I help you?')
			expect(result.usage.inputTokens).toBe(5)
			expect(result.usage.outputTokens).toBe(8)
			expect(result.model).toBe('yandexgpt-lite/latest')
		}
	})

	test('[YAI4] non-2xx → kind=error с status', async () => {
		const fakeFetch = async () => new Response('{"error":"unauthorized"}', { status: 401 })
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{
				apiKey: 'wrong',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('error')
		if (result.kind === 'error') {
			expect(result.status).toBe(401)
		}
	})

	test('[YAI5] request: Authorization Api-Key + modelUri shape + NO x-folder-id header', async () => {
		let capturedReq: RequestInit | undefined
		const fakeFetch = async (_url: unknown, init: RequestInit) => {
			capturedReq = init
			return new Response(
				JSON.stringify({
					result: {
						alternatives: [{ message: { text: 'x' } }],
						usage: { inputTextTokens: 1, completionTokens: 1 },
					},
				}),
				{ status: 200 },
			)
		}
		await chatCompletion(
			{
				messages: [
					{ role: 'system', text: 'sys' },
					{ role: 'user', text: 'q' },
				],
			},
			{
				apiKey: 'test-key',
				folderId: 'test-folder',
				model: 'yandexgpt/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(capturedReq).toBeDefined()
		const headers = capturedReq?.headers as Record<string, string>
		expect(headers.Authorization).toBe('Api-Key test-key')
		// Per Yandex docs: with Api-Key auth, x-folder-id header is redundant
		// (folder implied by SA). We do NOT send it.
		expect(headers['x-folder-id']).toBeUndefined()
		const body = JSON.parse(capturedReq?.body as string) as { modelUri: string }
		expect(body.modelUri).toBe('gpt://test-folder/yandexgpt/latest')
	})

	test('[YAI6] readConfigFromEnv defaults model к yandexgpt-lite/latest', () => {
		const config = readConfigFromEnv({})
		expect(config.model).toBe('yandexgpt-lite/latest')
		expect(config.apiKey).toBeUndefined()
	})

	test('[YAI7] readConfigFromEnv reads custom YANDEX_AI_MODEL + timeout', () => {
		const config = readConfigFromEnv({
			YANDEX_AI_API_KEY: 'k',
			YANDEX_AI_FOLDER_ID: 'f',
			YANDEX_AI_MODEL: 'aliceai-llm',
			YANDEX_AI_TIMEOUT_MS: '20000',
		})
		expect(config.apiKey).toBe('k')
		expect(config.folderId).toBe('f')
		expect(config.model).toBe('aliceai-llm')
		expect(config.timeoutMs).toBe(20000)
	})

	test('[YAI8] network error (fetch throws) → kind:error status=0', async () => {
		const fakeFetch = async () => {
			throw new Error('ECONNREFUSED')
		}
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('error')
		if (result.kind === 'error') {
			expect(result.status).toBe(0)
			expect(result.message).toContain('network')
		}
	})

	test('[YAI9] AbortController timeout → kind:error status=408', async () => {
		const fakeFetch = async (_url: unknown, init: RequestInit) => {
			// Simulate slow upstream by waiting for the abort signal to fire
			return await new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => {
					const err = new Error('aborted')
					err.name = 'AbortError'
					reject(err)
				})
			})
		}
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				timeoutMs: 30, // 30ms timeout for fast test
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('error')
		if (result.kind === 'error') {
			expect(result.status).toBe(408)
			expect(result.message).toContain('aborted')
		}
	})

	test('[YAI10] malformed JSON response → kind:error status=200 malformed_response', async () => {
		const fakeFetch = async () => new Response('not json {{', { status: 200 })
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('error')
		if (result.kind === 'error') {
			expect(result.status).toBe(200)
			expect(result.message).toContain('malformed_response')
		}
	})

	test('[YAI11] missing alternatives → kind:error empty_completion', async () => {
		const fakeFetch = async () =>
			new Response(JSON.stringify({ result: { alternatives: [], usage: {} } }), { status: 200 })
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('error')
		if (result.kind === 'error') {
			expect(result.message).toContain('empty_completion')
		}
	})

	test('[YAI12] token count parser: string + number + null all coerced', async () => {
		const fakeFetch = async () =>
			new Response(
				JSON.stringify({
					result: {
						alternatives: [{ message: { text: 'response' } }],
						// Mix: numeric input, null output (defensive — should coerce к 0)
						usage: { inputTextTokens: 42, completionTokens: null },
					},
				}),
				{ status: 200 },
			)
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('ok')
		if (result.kind === 'ok') {
			expect(result.usage.inputTokens).toBe(42) // numeric pass-through
			expect(result.usage.outputTokens).toBe(0) // null → 0
		}
	})

	test('[YAI13] reserved-test PII shield: non-reserved-test phone rejected pre-fetch', async () => {
		let fetched = false
		const fakeFetch = async () => {
			fetched = true
			return new Response('{}', { status: 200 })
		}
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'Гость +79161234567 хочет номер' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('rejected')
		if (result.kind === 'rejected') {
			expect(result.reason).toBe('pii_in_prompt')
		}
		expect(fetched).toBe(false)
	})

	test('[YAI14] reserved-test PII shield: passport-like 10-digit number rejected', async () => {
		const fakeFetch = async () => new Response('{}', { status: 200 })
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'Паспорт 4517 123456 действителен до 2030' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('rejected')
		if (result.kind === 'rejected') {
			expect(result.reason).toBe('pii_in_prompt')
		}
	})

	test('[YAI15] reserved-test PII shield: @example.com email allowed through', async () => {
		const fakeFetch = async () =>
			new Response(
				JSON.stringify({
					result: {
						alternatives: [{ message: { text: 'описание' } }],
						usage: { inputTextTokens: '5', completionTokens: '8' },
					},
				}),
				{ status: 200 },
			)
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'Demo guest ivan@example.com книги 1 ночь' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('ok')
	})

	test('[YAI16] prompt-too-long (> 8 KiB) rejected pre-fetch', async () => {
		let fetched = false
		const fakeFetch = async () => {
			fetched = true
			return new Response('{}', { status: 200 })
		}
		// 10 KiB ASCII — exceeds 8 KiB cap. Use spaces to avoid PII trigger.
		const huge = 'a '.repeat(5500)
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: huge }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('rejected')
		if (result.kind === 'rejected') {
			expect(result.reason).toBe('prompt_too_long')
		}
		expect(fetched).toBe(false)
	})

	test('[YAI17] SSRF endpoint whitelist: non-allowed host rejected when no fetchImpl', async () => {
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				endpoint: 'http://attacker.evil.com/foundationModels/v1/completion',
				// No fetchImpl → SSRF whitelist active
			},
		)
		expect(result.kind).toBe('error')
		if (result.kind === 'error') {
			expect(result.message).toContain('not whitelisted')
		}
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Self-review #4 — PII regex false-positive + false-negative coverage
	// ─────────────────────────────────────────────────────────────────────────

	test('[YAI18] PII shield: hospitality price range «16000-25000 ₽» allowed (no FP)', async () => {
		// Agent A finding (self-review #3 → #4): price ranges previously matched
		// PHONE_REGEX → blocked the headline AI tool use case. Stricter regex
		// requires + or RU 7/8 prefix.
		let fetched = false
		const fakeFetch = async () => {
			fetched = true
			return new Response(
				JSON.stringify({
					result: {
						alternatives: [{ message: { text: 'описание' } }],
						usage: { inputTextTokens: '5', completionTokens: '8' },
					},
				}),
				{ status: 200 },
			)
		}
		const result = await chatCompletion(
			{
				messages: [{ role: 'user', text: 'Гостевой дом, цены 16000-25000 ₽ за номер премиум' }],
			},
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('ok')
		expect(fetched).toBe(true)
	})

	test('[YAI19] PII shield: postal-code «Сочи 354000» allowed (no FP)', async () => {
		const fakeFetch = async () =>
			new Response(
				JSON.stringify({
					result: {
						alternatives: [{ message: { text: 'описание' } }],
						usage: { inputTextTokens: '3', completionTokens: '5' },
					},
				}),
				{ status: 200 },
			)
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'Сочи 354000 Краснодарский край' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('ok')
	})

	test('[YAI20] PII shield: Cyrillic local-part email иван@gazprom.ru REJECTED (close 152-ФЗ FN)', async () => {
		// Agent B finding (self-review #3 → #4): previous EMAIL_REGEX char class
		// was Latin-only, so Cyrillic local-part emails leaked through.
		let fetched = false
		const fakeFetch = async () => {
			fetched = true
			return new Response('{}', { status: 200 })
		}
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'Гость иван@gazprom.ru забронировал' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('rejected')
		if (result.kind === 'rejected') {
			expect(result.reason).toBe('pii_in_prompt')
		}
		expect(fetched).toBe(false)
	})

	test('[YAI21] PII shield: Russian national format 8(916)123-45-67 REJECTED', async () => {
		const fakeFetch = async () => new Response('{}', { status: 200 })
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'Звоните 8(916)123-45-67 для брони' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('rejected')
		if (result.kind === 'rejected') {
			expect(result.reason).toBe('pii_in_prompt')
		}
	})

	test('[YAI22] PII shield: old-format passport «45 12 345678» REJECTED', async () => {
		// Agent A finding (self-review #3 → #4): only new-format passport (4+6)
		// matched previously; Soviet-era / regional 2+2+6 format slipped through
		// as 152-ФЗ ст.10 special-category PII leak.
		const fakeFetch = async () => new Response('{}', { status: 200 })
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'Паспорт 45 12 345678' }] },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(result.kind).toBe('rejected')
		if (result.kind === 'rejected') {
			expect(result.reason).toBe('pii_in_prompt')
		}
	})

	test('[YAI23] maxTokens client-side cap — request 100k → upstream sees ≤ 4000', async () => {
		let capturedBody: string | undefined
		const fakeFetch = async (_url: unknown, init: RequestInit) => {
			capturedBody = init.body as string
			return new Response(
				JSON.stringify({
					result: {
						alternatives: [{ message: { text: 'ok' } }],
						usage: { inputTextTokens: '1', completionTokens: '1' },
					},
				}),
				{ status: 200 },
			)
		}
		await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }], maxTokens: 100_000 },
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		expect(capturedBody).toBeDefined()
		const parsed = JSON.parse(capturedBody as string) as {
			completionOptions: { maxTokens: string }
		}
		// Hard cap = 4000 — 100k input clamped down.
		expect(Number(parsed.completionOptions.maxTokens)).toBe(4000)
	})

	test('[YAI24] readConfigFromEnv: strict-int parse rejects partial garbage', () => {
		// Agent A finding (self-review #3 → #4): `Number.parseInt('1000abc',10)`
		// returns 1000 (silent partial-parse) → insta-timeout if env has stray chars.
		const config = readConfigFromEnv({
			YANDEX_AI_API_KEY: 'k',
			YANDEX_AI_FOLDER_ID: 'f',
			YANDEX_AI_TIMEOUT_MS: '15s', // bogus units suffix
		})
		expect(config.timeoutMs).toBeUndefined()
	})

	test('[YAI25] readConfigFromEnv: valid integer timeout passes', () => {
		const config = readConfigFromEnv({
			YANDEX_AI_API_KEY: 'k',
			YANDEX_AI_FOLDER_ID: 'f',
			YANDEX_AI_TIMEOUT_MS: '20000',
		})
		expect(config.timeoutMs).toBe(20000)
	})

	test("[YAI26] maxTokens NaN-slip defense — Number('abc') ≡ NaN → fallback 500", async () => {
		// Adversarial reading checklist #6 — Math.max/min propagate NaN. Caller
		// passing `Number('abc') === NaN` would otherwise send `maxTokens: "NaN"`
		// к Yandex и получить 400.
		let capturedBody: string | undefined
		const fakeFetch = async (_url: unknown, init: RequestInit) => {
			capturedBody = init.body as string
			return new Response(
				JSON.stringify({
					result: {
						alternatives: [{ message: { text: 'ok' } }],
						usage: { inputTextTokens: '1', completionTokens: '1' },
					},
				}),
				{ status: 200 },
			)
		}
		await chatCompletion(
			{
				messages: [{ role: 'user', text: 'hi' }],
				maxTokens: Number('abc'), // NaN
			},
			{
				apiKey: 'k1',
				folderId: 'f1',
				model: 'yandexgpt-lite/latest',
				fetchImpl: fakeFetch as unknown as typeof fetch,
			},
		)
		const parsed = JSON.parse(capturedBody as string) as {
			completionOptions: { maxTokens: string }
		}
		// Fallback default 500, NOT "NaN"
		expect(parsed.completionOptions.maxTokens).toBe('500')
	})
})
