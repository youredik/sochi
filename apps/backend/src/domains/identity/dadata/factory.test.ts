/**
 * createDaDataAdapter (factory) — strict tests.
 *
 * Pre-done audit:
 *   [F1] empty apiKey → mock impl, metadata.name='dadata.mock', mode='mock'
 *   [F2] undefined apiKey → mock impl, metadata.mode='mock'
 *   [F3] whitespace-only apiKey → mock impl (treated as empty)
 *   [F4] non-empty apiKey → real impl, metadata.name='dadata.live', mode='live'
 *   [F5] non-empty apiKey trimmed correctly (no leading/trailing space leaks into Authorization)
 *   [F6] mock impl returns demo data for known ИНН via the factory result
 */
import { describe, expect, it, mock } from 'bun:test'
import { createDaDataAdapter } from './factory.ts'

describe('createDaDataAdapter — mock branch', () => {
	it('[F1] empty apiKey → mock adapter (name=dadata.mock, mode=mock)', () => {
		const result = createDaDataAdapter({ apiKey: '' })
		expect(result.metadata.name).toBe('dadata.mock')
		expect(result.metadata.mode).toBe('mock')
		expect(result.metadata.category).toBe('identity-lookup')
	})

	it('[F2] undefined apiKey → mock adapter', () => {
		const result = createDaDataAdapter({ apiKey: undefined })
		expect(result.metadata.mode).toBe('mock')
	})

	it('[F3] whitespace-only apiKey → mock adapter (treated as empty)', () => {
		const result = createDaDataAdapter({ apiKey: '   ' })
		expect(result.metadata.mode).toBe('mock')
	})

	it('[F6] mock instance returned by factory finds demo company', async () => {
		const { adapter } = createDaDataAdapter({ apiKey: '' })
		const party = await adapter.findByInn('2320000001')
		expect(party?.name).toBe('ООО «Демо-Сириус»')
	})
})

describe('createDaDataAdapter — live branch', () => {
	it('[F4] non-empty apiKey → live adapter (name=dadata.live, mode=live)', () => {
		const result = createDaDataAdapter({ apiKey: 'tok' })
		expect(result.metadata.name).toBe('dadata.live')
		expect(result.metadata.mode).toBe('live')
		expect(result.metadata.providerVersion).toBe('v4.1')
	})

	it('[F5] surrounding whitespace trimmed from apiKey before Authorization header', async () => {
		const calls: Array<RequestInit> = []
		const fetchImpl = ((_url: string, init: RequestInit) => {
			calls.push(init)
			return Promise.resolve(
				new Response(JSON.stringify({ suggestions: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
		}) as unknown as typeof fetch
		// Spaces around real key — factory must trim before passing to real adapter.
		const { adapter } = createDaDataAdapter({ apiKey: '  sekret_42  ', fetchImpl })
		await adapter.findByInn('7707083893')
		const headers = calls[0]?.headers as Record<string, string>
		expect(headers.Authorization).toBe('Token sekret_42')
	})
})

// keep `mock` import referenced for future strict-test extensions; remove
// when test suite migrates fully to property-based runner per
// [[fastcheck_gotchas]].
void mock
