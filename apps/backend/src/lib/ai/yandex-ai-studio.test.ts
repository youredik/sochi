/**
 * Round 14 — Yandex AI Studio client tests (mocked fetch).
 */

import { describe, expect, test } from 'bun:test'
import { chatCompletion, readConfigFromEnv } from './yandex-ai-studio.ts'

describe('Yandex AI Studio HTTP client', () => {
	test('[YAI1] returns not_configured когда no API key', async () => {
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{ apiKey: undefined, folderId: 'f1', model: 'yandexgpt-lite/latest' },
		)
		expect(result.kind).toBe('not_configured')
	})

	test('[YAI2] returns not_configured когда no folderId', async () => {
		const result = await chatCompletion(
			{ messages: [{ role: 'user', text: 'hi' }] },
			{ apiKey: 'k1', folderId: undefined, model: 'yandexgpt-lite/latest' },
		)
		expect(result.kind).toBe('not_configured')
	})

	test('[YAI3] successful chat completion parses Yandex AI Studio response', async () => {
		const mockResponse = new Response(
			JSON.stringify({
				result: {
					alternatives: [{ message: { text: 'Hello! How can I help you?' } }],
					usage: { inputTextTokens: '5', completionTokens: '8' },
				},
			}),
			{ status: 200 },
		)
		const fakeFetch = async () => mockResponse.clone()
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
		}
	})

	test('[YAI4] error response returns kind=error с status', async () => {
		const mockResponse = new Response('{"error":"unauthorized"}', { status: 401 })
		const fakeFetch = async () => mockResponse.clone()
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

	test('[YAI5] sends authorization + folder headers + modelUri shape', async () => {
		let capturedReq: RequestInit | undefined
		const fakeFetch = async (_url: unknown, init: RequestInit) => {
			capturedReq = init
			return new Response(
				JSON.stringify({
					result: { alternatives: [{ message: { text: 'x' } }], usage: {} },
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
		expect(headers['x-folder-id']).toBe('test-folder')
		const body = JSON.parse(capturedReq?.body as string) as { modelUri: string }
		expect(body.modelUri).toBe('gpt://test-folder/yandexgpt/latest')
	})

	test('[YAI6] readConfigFromEnv defaults model к yandexgpt-lite/latest', () => {
		const config = readConfigFromEnv({})
		expect(config.model).toBe('yandexgpt-lite/latest')
		expect(config.apiKey).toBeUndefined()
	})

	test('[YAI7] readConfigFromEnv reads custom YANDEX_AI_MODEL', () => {
		const config = readConfigFromEnv({
			YANDEX_AI_API_KEY: 'k',
			YANDEX_AI_FOLDER_ID: 'f',
			YANDEX_AI_MODEL: 'alice-ai-llm/latest',
		})
		expect(config.apiKey).toBe('k')
		expect(config.folderId).toBe('f')
		expect(config.model).toBe('alice-ai-llm/latest')
	})
})
