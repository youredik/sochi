/**
 * Adversarial: Idempotency-Key reuse across retries (P2, 2026-05).
 *
 * Bug caught by 9-item hostile re-read (canon `adversarial_reading_before_done`):
 * generating UUID INSIDE `policy.execute` callback → cockatiel re-invokes
 * closure on retry → new UUID → defeats Yandex Cloud server-side dedup.
 *
 * Fix: generate UUID ONCE outside `policy.execute`, reuse across attempts.
 *
 * This test exists separately from main provider tests so the canonical
 * pre-done audit checklist (`adversarial_reading_before_done`) item shows up
 * in test discovery как explicit regression guard.
 */

import { describe, expect, mock, test } from 'bun:test'
import { createYandexVisionOcr } from './yandex-vision-provider.ts'

type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const FIXED_UUID = '11111111-1111-4111-8111-111111111111'

test('Idempotency-Key REUSED across retries (Yandex Cloud server dedup contract)', async () => {
	let n = 0
	const fetchMock = mock<ProviderFetch>(async () => {
		n++
		if (n < 3) return new Response('', { status: 503 })
		return new Response(
			JSON.stringify({
				result: { textAnnotation: { entities: [] } },
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		)
	})
	let uuidCalls = 0
	const adapter = createYandexVisionOcr({
		apiKey: 'test_key',
		folderId: 'test_folder',
		apiBase: 'https://ocr.api.cloud.yandex.net',
		uuid: () => {
			uuidCalls++
			return FIXED_UUID
		},
		fetch: fetchMock,
	})
	await adapter.recognizePassport({
		bytes: new Uint8Array(10),
		mimeType: 'image/jpeg',
	})
	expect(fetchMock.mock.calls.length).toBe(3) // 1 initial + 2 retries
	// Bug-regression guard: uuid() called EXACTLY ONCE (NOT per retry).
	expect(uuidCalls).toBe(1)
	// All 3 calls used same Idempotency-Key header.
	for (let i = 0; i < 3; i++) {
		const headers = new Headers(fetchMock.mock.calls[i]?.[1]?.headers)
		expect(headers.get('Idempotency-Key')).toBe(FIXED_UUID)
	}
})

describe('audit-marker: 9-item hostile checklist applied to P2', () => {
	test('zero-permit: bytes.length=0 returns api_error без HTTP call', async () => {
		const fetchMock = mock<ProviderFetch>(async () => new Response('', { status: 200 }))
		const adapter = createYandexVisionOcr({
			apiKey: 'k',
			folderId: 'f',
			fetch: fetchMock,
		})
		const res = await adapter.recognizePassport({
			bytes: new Uint8Array(0),
			mimeType: 'image/jpeg',
		})
		expect(res.outcome).toBe('api_error')
		expect(fetchMock.mock.calls.length).toBe(0)
	})

	test('NaN-slip: malformed date в entity → null (computeHeuristic safe)', async () => {
		const fetchMock = mock<ProviderFetch>(
			async () =>
				new Response(
					JSON.stringify({
						result: {
							textAnnotation: {
								entities: [
									{ name: 'birth_date', text: 'not-a-date' },
									{ name: 'surname', text: 'X' },
								],
							},
						},
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		)
		const adapter = createYandexVisionOcr({
			apiKey: 'k',
			folderId: 'f',
			fetch: fetchMock,
		})
		const res = await adapter.recognizePassport({
			bytes: new Uint8Array(10),
			mimeType: 'image/jpeg',
		})
		expect(res.entities.birthDate).toBeNull()
		expect(Number.isNaN(res.confidenceHeuristic)).toBe(false)
	})

	test('closure-stale: fetch/uuid/now captured at create-time, stable through call', async () => {
		const fetchMock = mock<ProviderFetch>(
			async () =>
				new Response(JSON.stringify({ result: { textAnnotation: { entities: [] } } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		)
		let nowCalls = 0
		const adapter = createYandexVisionOcr({
			apiKey: 'k',
			folderId: 'f',
			fetch: fetchMock,
			now: () => {
				nowCalls++
				return 1_000_000
			},
		})
		await adapter.recognizePassport({ bytes: new Uint8Array(10), mimeType: 'image/jpeg' })
		expect(nowCalls).toBeGreaterThan(0) // captured + used
	})
})
