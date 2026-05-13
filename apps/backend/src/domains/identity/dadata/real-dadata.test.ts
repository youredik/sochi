/**
 * createRealDaData — strict tests with mock fetch.
 *
 * Pre-done audit:
 *   [R1] 200 + suggestion → mapped DaDataParty (status/taxRegime parsed correctly)
 *   [R2] 200 + empty suggestions array → null (record not found)
 *   [R3] 200 + suggestion with INDIVIDUAL type → legalForm='INDIVIDUAL'
 *   [R4] suggestion without OGRN → ogrn=null
 *   [R5] suggestion with unknown tax_system → taxRegime='UNKNOWN'
 *   [R6] suggestion with LIQUIDATED state.status → status='LIQUIDATED'
 *   [E1] 401 unauthorized → null (fail-soft, no throw)
 *   [E2] 500 server error → null (fail-soft)
 *   [E3] AbortError (timeout) → null (fail-soft)
 *   [E4] malformed JSON → null (fail-soft)
 *   [E5] network error (fetch throws) → null (fail-soft)
 *   [C1] request sent with correct method/URL/headers/body
 *   [C2] Authorization header carries `Token <apiKey>` format
 */
import { describe, expect, it, mock } from 'bun:test'
import { createRealDaData } from './real-dadata.ts'

const ENDPOINT = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party'

interface ApiSuggestionData {
	inn?: string
	ogrn?: string | null
	type?: string
	state?: { status?: string }
	name?: { short_with_opf?: string; full_with_opf?: string }
	address?: { value?: string; data?: { city?: string; city_with_type?: string } }
	tax_system?: string
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function makeFetchMock(resolved: Response | Error): typeof fetch {
	if (resolved instanceof Error) {
		return mock(async () => {
			throw resolved
		}) as unknown as typeof fetch
	}
	return mock(async () => resolved) as unknown as typeof fetch
}

describe('createRealDaData — happy-path mapping', () => {
	it('[R1] 200 + suggestion → mapped DaDataParty', async () => {
		const data: ApiSuggestionData = {
			inn: '7707083893',
			ogrn: '1027700132195',
			type: 'LEGAL',
			state: { status: 'ACTIVE' },
			name: {
				short_with_opf: 'ПАО Сбербанк',
				full_with_opf: 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО «СБЕРБАНК РОССИИ»',
			},
			address: { value: '117997, г. Москва, ул. Вавилова, 19', data: { city: 'Москва' } },
			tax_system: 'OSNO',
		}
		const fetchImpl = makeFetchMock(
			jsonResponse({ suggestions: [{ value: 'ПАО Сбербанк', data }] }),
		)
		const adapter = createRealDaData({ apiKey: 'k-1', fetchImpl })
		const party = await adapter.findByInn('7707083893')
		expect(party).toEqual({
			inn: '7707083893',
			ogrn: '1027700132195',
			name: 'ПАО Сбербанк',
			legalForm: 'LEGAL',
			address: '117997, г. Москва, ул. Вавилова, 19',
			city: 'Москва',
			taxRegime: 'OSN',
			status: 'ACTIVE',
		})
	})

	it('[R2] 200 + empty suggestions → null', async () => {
		const fetchImpl = makeFetchMock(jsonResponse({ suggestions: [] }))
		const adapter = createRealDaData({ apiKey: 'k', fetchImpl })
		expect(await adapter.findByInn('0000000000')).toBe(null)
	})

	it('[R3] INDIVIDUAL type → legalForm=INDIVIDUAL', async () => {
		const data: ApiSuggestionData = {
			inn: '772345678901',
			type: 'INDIVIDUAL',
			state: { status: 'ACTIVE' },
			name: { short_with_opf: 'ИП Иванов И.И.' },
			address: { value: 'Москва', data: { city: 'Москва' } },
			tax_system: 'NPD',
		}
		const fetchImpl = makeFetchMock(jsonResponse({ suggestions: [{ data }] }))
		const adapter = createRealDaData({ apiKey: 'k', fetchImpl })
		const party = await adapter.findByInn('772345678901')
		expect(party?.legalForm).toBe('INDIVIDUAL')
		expect(party?.taxRegime).toBe('NPD')
	})

	it('[R4] suggestion without OGRN → ogrn=null', async () => {
		const data: ApiSuggestionData = {
			inn: '7707083893',
			type: 'LEGAL',
			state: { status: 'ACTIVE' },
			name: { short_with_opf: 'X' },
			address: { value: 'А', data: { city: 'А' } },
		}
		const fetchImpl = makeFetchMock(jsonResponse({ suggestions: [{ data }] }))
		const adapter = createRealDaData({ apiKey: 'k', fetchImpl })
		const party = await adapter.findByInn('7707083893')
		expect(party?.ogrn).toBe(null)
	})

	it('[R5] unknown tax_system value → taxRegime=UNKNOWN', async () => {
		const data: ApiSuggestionData = {
			inn: '7707083893',
			type: 'LEGAL',
			state: { status: 'ACTIVE' },
			name: { short_with_opf: 'X' },
			address: { value: 'А', data: { city: 'А' } },
			tax_system: 'FANTASY_REGIME_42',
		}
		const fetchImpl = makeFetchMock(jsonResponse({ suggestions: [{ data }] }))
		const adapter = createRealDaData({ apiKey: 'k', fetchImpl })
		const party = await adapter.findByInn('7707083893')
		expect(party?.taxRegime).toBe('UNKNOWN')
	})

	it('[R6] LIQUIDATED state.status → status=LIQUIDATED', async () => {
		const data: ApiSuggestionData = {
			inn: '7707083893',
			type: 'LEGAL',
			state: { status: 'LIQUIDATED' },
			name: { short_with_opf: 'X' },
			address: { value: 'А', data: { city: 'А' } },
		}
		const fetchImpl = makeFetchMock(jsonResponse({ suggestions: [{ data }] }))
		const adapter = createRealDaData({ apiKey: 'k', fetchImpl })
		const party = await adapter.findByInn('7707083893')
		expect(party?.status).toBe('LIQUIDATED')
	})
})

describe('createRealDaData — fail-soft on errors', () => {
	it('[E1] 401 unauthorized → null', async () => {
		const fetchImpl = makeFetchMock(new Response('Unauthorized', { status: 401 }))
		const adapter = createRealDaData({ apiKey: 'bad', fetchImpl })
		expect(await adapter.findByInn('7707083893')).toBe(null)
	})

	it('[E2] 500 server error → null', async () => {
		const fetchImpl = makeFetchMock(new Response('boom', { status: 500 }))
		const adapter = createRealDaData({ apiKey: 'k', fetchImpl })
		expect(await adapter.findByInn('7707083893')).toBe(null)
	})

	it('[E3] AbortError (timeout) → null', async () => {
		const abortErr = new Error('aborted')
		abortErr.name = 'AbortError'
		const fetchImpl = makeFetchMock(abortErr)
		const adapter = createRealDaData({ apiKey: 'k', fetchImpl })
		expect(await adapter.findByInn('7707083893')).toBe(null)
	})

	it('[E4] malformed JSON → null', async () => {
		const fetchImpl = makeFetchMock(
			new Response('not json{{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
		)
		const adapter = createRealDaData({ apiKey: 'k', fetchImpl })
		expect(await adapter.findByInn('7707083893')).toBe(null)
	})

	it('[E5] network error (fetch throws) → null', async () => {
		const fetchImpl = makeFetchMock(new Error('ECONNREFUSED'))
		const adapter = createRealDaData({ apiKey: 'k', fetchImpl })
		expect(await adapter.findByInn('7707083893')).toBe(null)
	})
})

describe('createRealDaData — request shape', () => {
	it('[C1] sends POST to canonical endpoint with body {query, count}', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		const fetchImpl = ((url: string, init: RequestInit) => {
			calls.push({ url, init })
			return Promise.resolve(jsonResponse({ suggestions: [] }))
		}) as unknown as typeof fetch
		const adapter = createRealDaData({ apiKey: 'tok', fetchImpl })
		await adapter.findByInn('7707083893')
		expect(calls.length).toBe(1)
		const firstCall = calls[0]
		expect(firstCall).not.toBe(undefined)
		const call = firstCall as { url: string; init: RequestInit }
		expect(call.url).toBe(ENDPOINT)
		expect(call.init.method).toBe('POST')
		expect(JSON.parse(call.init.body as string)).toEqual({ query: '7707083893', count: 1 })
	})

	it('[C2] Authorization header carries `Token <apiKey>` format', async () => {
		const calls: Array<{ init: RequestInit }> = []
		const fetchImpl = ((_url: string, init: RequestInit) => {
			calls.push({ init })
			return Promise.resolve(jsonResponse({ suggestions: [] }))
		}) as unknown as typeof fetch
		const adapter = createRealDaData({ apiKey: 'sekret_42', fetchImpl })
		await adapter.findByInn('7707083893')
		const headers = calls[0]?.init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Token sekret_42')
		expect(headers['Content-Type']).toBe('application/json')
		expect(headers.Accept).toBe('application/json')
	})
})
