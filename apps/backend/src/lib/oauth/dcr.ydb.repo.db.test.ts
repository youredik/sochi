/**
 * Round 14 self-review — DCR YDB store INTEGRATION tests with real YDB.
 *
 * Closes canon `feedback_critical_fix_test_coverage` violation: unit tests
 * `dcr.test.ts` use `createInMemoryDcrStore()` while production wires
 * `createYdbDcrStore(sql)`. Production code path was NEVER exercised by
 * unit suite before this file — only one manual curl. Round 14 self-review
 * triggered «уверен?» caught.
 *
 * Tests register → get round-trip против local YDB. Auto-skipped if YDB
 * driver не доступен (CI without YDB sidecar).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from '../../db/index.ts'
import type { DcrStore } from './dcr.ts'
import { createYdbDcrStore, verifySecret } from './dcr.ydb.repo.ts'

describe('DCR YDB repo — integration (real YDB)', () => {
	let store: DcrStore
	const createdClientIds: string[] = []

	beforeEach(() => {
		store = createYdbDcrStore(sql)
	})

	afterEach(async () => {
		// Cleanup — soft-delete via setting revokedAt OR direct DELETE для test isolation.
		for (const clientId of createdClientIds) {
			await sql`DELETE FROM oauthClient WHERE clientId = ${clientId}`.idempotent(true)
		}
		createdClientIds.length = 0
	})

	test('[DCRYDB-INT-1] register persists row + returns RFC 7591 shape', async () => {
		const client = await store.register({
			client_name: 'Integration Test Client',
			redirect_uris: ['https://int-test.example/cb'],
		})
		createdClientIds.push(client.client_id)
		expect(client.client_id).toMatch(/^sclient_/)
		expect(client.client_secret).toMatch(/^whsec_dcr_/)
		expect(client.client_id_issued_at).toBeGreaterThan(0)
		expect(client.client_secret_expires_at).toBe(0)
		expect(client.grant_types).toEqual(['authorization_code'])
		expect(client.token_endpoint_auth_method).toBe('client_secret_basic')
	})

	test('[DCRYDB-INT-2] get returns row after register (read path)', async () => {
		const registered = await store.register({
			client_name: 'Read-Path Test',
			redirect_uris: ['https://read-test.example/cb'],
			contacts: ['ops@read-test.example'],
		})
		createdClientIds.push(registered.client_id)
		const fetched = await store.get(registered.client_id)
		expect(fetched).not.toBeNull()
		expect(fetched?.client_id).toBe(registered.client_id)
		expect(fetched?.client_name).toBe('Read-Path Test')
		expect(fetched?.redirect_uris).toEqual(['https://read-test.example/cb'])
		expect(fetched?.grant_types).toEqual(['authorization_code'])
		expect(fetched?.contacts).toEqual(['ops@read-test.example'])
		// Read path returns empty string secret (canon: plaintext only at register).
		expect(fetched?.client_secret).toBe('')
	})

	test('[DCRYDB-INT-3] get unknown clientId returns null', async () => {
		const fetched = await store.get('sclient_nonexistent_zzzz')
		expect(fetched).toBeNull()
	})

	test('[DCRYDB-INT-4] secret hash verifies via verifySecret', async () => {
		const registered = await store.register({
			client_name: 'Hash Verify Test',
			redirect_uris: ['https://hash-test.example/cb'],
		})
		createdClientIds.push(registered.client_id)
		// Re-fetch raw secretHash from DB.
		const [rows = []] = await sql<{ clientSecretHash: string }[]>`
			SELECT clientSecretHash FROM oauthClient WHERE clientId = ${registered.client_id}
		`.idempotent(true)
		const storedHash = rows[0]?.clientSecretHash
		expect(storedHash).toBeDefined()
		if (storedHash !== undefined) {
			// Plaintext secret verifies против stored scrypt hash.
			expect(await verifySecret(registered.client_secret, storedHash)).toBe(true)
			// Wrong secret rejected.
			expect(await verifySecret('whsec_dcr_wrong_secret', storedHash)).toBe(false)
		}
	})

	test('[DCRYDB-INT-5] register с contacts JSON column persists через JSON serialization', async () => {
		const registered = await store.register({
			client_name: 'Multi-Contact Test',
			redirect_uris: ['https://mc.example/cb'],
			contacts: ['ops@mc.example', 'security@mc.example'],
		})
		createdClientIds.push(registered.client_id)
		const fetched = await store.get(registered.client_id)
		expect(fetched?.contacts).toEqual(['ops@mc.example', 'security@mc.example'])
	})

	test('[DCRYDB-INT-6] register без contacts → contacts undefined on get', async () => {
		const registered = await store.register({
			client_name: 'No-Contacts Test',
			redirect_uris: ['https://nc.example/cb'],
		})
		createdClientIds.push(registered.client_id)
		const fetched = await store.get(registered.client_id)
		expect(fetched?.contacts).toBeUndefined()
	})
})
