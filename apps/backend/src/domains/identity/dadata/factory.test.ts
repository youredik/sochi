/**
 * createDaDataAdapter (factory) — strict tests.
 *
 * Pre-done audit:
 *   [F1] empty apiKey → mock-only impl, metadata.name='dadata.mock', mode='mock'
 *   [F2] undefined apiKey → mock-only impl, metadata.mode='mock'
 *   [F3] whitespace-only apiKey → mock-only impl (treated as empty)
 *   [F4] non-empty apiKey → hybrid impl, metadata.name='dadata.hybrid', mode='live'
 *   [F5] non-empty apiKey trimmed correctly (no leading/trailing space leaks into Authorization)
 *   [F6] mock-only impl returns demo data for canonical demo ИНН
 *   [F7] hybrid: canonical demo ИНН resolves from mock (no live fetch)
 *   [F8] hybrid: non-demo ИНН flows к live API
 *   [F9] hybrid: live returning null surfaces null (no exception leak)
 */
import { describe, expect, it, mock } from 'bun:test'
import { createDaDataAdapter } from './factory.ts'

describe('createDaDataAdapter — mock-only branch', () => {
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

describe('createDaDataAdapter — hybrid branch', () => {
	it('[F4] non-empty apiKey → hybrid adapter (name=dadata.hybrid, mode=live)', () => {
		const result = createDaDataAdapter({ apiKey: 'tok' })
		expect(result.metadata.name).toBe('dadata.hybrid')
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
		// Non-demo ИНН flows к live API (`7707083893` is Сбер — not in mock set).
		await adapter.findByInn('7707083893')
		const headers = calls[0]?.headers as Record<string, string>
		expect(headers.Authorization).toBe('Token sekret_42')
	})

	it('[F7] hybrid: canonical demo ИНН resolves from mock (no live fetch)', async () => {
		let liveFetchCount = 0
		const fetchImpl = (() => {
			liveFetchCount += 1
			return Promise.resolve(new Response(JSON.stringify({ suggestions: [] }), { status: 200 }))
		}) as unknown as typeof fetch
		const { adapter } = createDaDataAdapter({ apiKey: 'tok', fetchImpl })
		const party = await adapter.findByInn('2320000001')
		expect(party?.name).toBe('ООО «Демо-Сириус»')
		expect(liveFetchCount).toBe(0)
	})

	it('[F8] hybrid: non-demo ИНН flows к live API', async () => {
		const fetchImpl = ((_url: string, _init: RequestInit) => {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						suggestions: [
							{
								value: 'ПАО СБЕРБАНК',
								data: {
									inn: '7707083893',
									ogrn: '1027700132195',
									kpp: '773601001',
									opf: { code: '12247' },
									name: { short_with_opf: 'ПАО СБЕРБАНК', full_with_opf: 'ПАО СБЕРБАНК' },
									address: { value: 'г Москва' },
									state: { status: 'ACTIVE' },
								},
							},
						],
					}),
					{ status: 200 },
				),
			)
		}) as unknown as typeof fetch
		const { adapter } = createDaDataAdapter({ apiKey: 'tok', fetchImpl })
		const party = await adapter.findByInn('7707083893')
		expect(party?.inn).toBe('7707083893')
		expect(party?.name).toBe('ПАО СБЕРБАНК')
	})

	it('[F9] hybrid: live returning null surfaces null', async () => {
		const fetchImpl = (() =>
			Promise.resolve(
				new Response(JSON.stringify({ suggestions: [] }), { status: 200 }),
			)) as unknown as typeof fetch
		const { adapter } = createDaDataAdapter({ apiKey: 'tok', fetchImpl })
		const party = await adapter.findByInn('9999999999')
		expect(party).toBeNull()
	})
})

// keep `mock` import referenced for future strict-test extensions; remove
// when test suite migrates fully to property-based runner per
// [[fastcheck_gotchas]].
void mock
