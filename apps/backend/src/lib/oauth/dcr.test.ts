/**
 * Round 13 — RFC 7591 DCR strict tests.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
	createInMemoryDcrStore,
	generateClientId,
	generateClientSecret,
	validateClientMetadata,
} from './dcr.ts'
import { createDcrRoutes } from './dcr.routes.ts'

describe('DCR (RFC 7591) validation', () => {
	test('[DCR1] valid input → ok=true', () => {
		const result = validateClientMetadata({
			client_name: 'Acme Integration',
			redirect_uris: ['https://acme.example/callback'],
		})
		expect(result.ok).toBe(true)
	})

	test('[DCR2] missing client_name → invalid_client_metadata', () => {
		const result = validateClientMetadata({ redirect_uris: ['https://x.com/cb'] })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.kind).toBe('invalid_client_metadata')
	})

	test('[DCR3] missing redirect_uris → invalid_client_metadata', () => {
		const result = validateClientMetadata({ client_name: 'X' })
		expect(result.ok).toBe(false)
	})

	test('[DCR4] http:// non-localhost redirect_uri → invalid_redirect_uri', () => {
		const result = validateClientMetadata({
			client_name: 'X',
			redirect_uris: ['http://evil.com/callback'],
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.kind).toBe('invalid_redirect_uri')
	})

	test('[DCR5] http://localhost дев redirect_uri → ok', () => {
		const result = validateClientMetadata({
			client_name: 'X',
			redirect_uris: ['http://localhost:3000/callback'],
		})
		expect(result.ok).toBe(true)
	})

	test('[DCR6] javascript:/data: schemes blocked', () => {
		for (const evil of ['javascript:alert(1)', 'data:text/html,<script>1</script>']) {
			const result = validateClientMetadata({ client_name: 'X', redirect_uris: [evil] })
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.error.kind).toBe('invalid_redirect_uri')
		}
	})

	test('[DCR7] reserved client_name → reserved_client_name', () => {
		for (const reserved of ['sepshn', 'SEPSHN', 'Admin', 'root']) {
			const result = validateClientMetadata({
				client_name: reserved,
				redirect_uris: ['https://x.com/cb'],
			})
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.error.kind).toBe('reserved_client_name')
		}
	})

	test('[DCR8] too many redirect_uris → invalid_client_metadata', () => {
		const result = validateClientMetadata({
			client_name: 'X',
			redirect_uris: Array.from({ length: 6 }, (_, i) => `https://x.com/cb${i}`),
		})
		expect(result.ok).toBe(false)
	})

	test('[DCR9] generated IDs have canonical Sepshn prefix', () => {
		expect(generateClientId()).toMatch(/^sclient_/)
		expect(generateClientSecret()).toMatch(/^whsec_dcr_/)
	})
})

describe('DCR (RFC 7591) routes', () => {
	const store = createInMemoryDcrStore()
	const app = new Hono().route('/api/oauth', createDcrRoutes(store))

	afterEach(() => store.__clear())

	test('[DCR10] POST /api/oauth/register valid → 201 + RFC 7591 response shape', async () => {
		const res = await app.request('/api/oauth/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client_name: 'Acme',
				redirect_uris: ['https://acme.example/cb'],
			}),
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			client_id: string
			client_secret: string
			client_id_issued_at: number
			client_secret_expires_at: number
			grant_types: string[]
			token_endpoint_auth_method: string
		}
		expect(body.client_id).toMatch(/^sclient_/)
		expect(body.client_secret).toMatch(/^whsec_dcr_/)
		expect(body.client_id_issued_at).toBeGreaterThan(0)
		expect(body.client_secret_expires_at).toBe(0)
		expect(body.grant_types).toEqual(['authorization_code'])
		expect(body.token_endpoint_auth_method).toBe('client_secret_basic')
	})

	test('[DCR11] POST /api/oauth/register malformed JSON → 400', async () => {
		const res = await app.request('/api/oauth/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{not json',
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe('invalid_client_metadata')
	})

	test('[DCR12] POST /api/oauth/register reserved client_name → 403', async () => {
		const res = await app.request('/api/oauth/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client_name: 'sepshn',
				redirect_uris: ['https://x.com/cb'],
			}),
		})
		expect(res.status).toBe(403)
	})

	test('[DCR13] POST /api/oauth/register invalid redirect_uri → 400 invalid_redirect_uri', async () => {
		const res = await app.request('/api/oauth/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client_name: 'X',
				redirect_uris: ['javascript:alert(1)'],
			}),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe('invalid_redirect_uri')
	})

	test('[DCR14] registered client retrievable via store.get', async () => {
		const res = await app.request('/api/oauth/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client_name: 'Acme',
				redirect_uris: ['https://acme.example/cb'],
			}),
		})
		const body = (await res.json()) as { client_id: string }
		const fetched = await store.get(body.client_id)
		expect(fetched).not.toBeNull()
		expect(fetched?.client_name).toBe('Acme')
	})
})
