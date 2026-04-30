/**
 * Strict tests для magic-link secret resolver (M9.widget.5 / A3.1.a).
 *
 * Coverage matrix:
 *   ─── generateMagicLinkSecret ────────────────────────────────
 *     [S1] returns base64url string of expected length (32 bytes → 43 chars)
 *     [S2] every call returns different secret (random)
 *
 *   ─── createMagicLinkSecretResolver — DB integration ──────────
 *     [S3] resolve() existing row returns stored secret verbatim
 *     [S4] resolve() lazy-bootstrap on NULL — generates + UPDATE + returns
 *     [S5] resolve() second call returns same back-filled secret (no double-bootstrap)
 *     [S6] resolve() concurrent first-readers — both succeed (race-safe)
 *     [S7] resolve() missing organizationProfile row → throws (system invariant)
 *     [S8] cross-tenant: tenant A secret NOT visible через tenant B resolver
 */

import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createMagicLinkSecretResolver, generateMagicLinkSecret } from './secret.ts'

async function seedOrgProfile(
	sql: ReturnType<typeof getTestSql>,
	tenantId: string,
	magicLinkSecret: string | null = null,
): Promise<void> {
	const now = new Date()
	// Both organization (BA) + organizationProfile (HoReCa) rows.
	await sql`
		UPSERT INTO organization (id, name, slug, logo, metadata, createdAt)
		VALUES (${tenantId}, ${`Test ${tenantId}`}, ${tenantId}, ${'logo'}, ${'{}'}, ${now})
	`.idempotent(true)
	if (magicLinkSecret === null) {
		await sql`
			UPSERT INTO organizationProfile (
				organizationId, plan, createdAt, updatedAt
			) VALUES (
				${tenantId}, ${'starter'}, ${now}, ${now}
			)
		`.idempotent(true)
	} else {
		await sql`
			UPSERT INTO organizationProfile (
				organizationId, plan, createdAt, updatedAt, magicLinkSecret
			) VALUES (
				${tenantId}, ${'starter'}, ${now}, ${now}, ${magicLinkSecret}
			)
		`.idempotent(true)
	}
}

describe('magic-link/secret', () => {
	test('[S1] generateMagicLinkSecret — base64url 43 chars (32-byte)', () => {
		const s = generateMagicLinkSecret()
		// 32 raw bytes → base64url ~43 chars (no padding for 32 bytes: ceil(32*4/3)=43)
		expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/)
	})

	test('[S2] generateMagicLinkSecret — different secret per call', () => {
		const a = generateMagicLinkSecret()
		const b = generateMagicLinkSecret()
		expect(a).not.toBe(b)
	})

	describe('createMagicLinkSecretResolver — DB integration', {
		tags: ['db'],
		timeout: 60_000,
	}, () => {
		beforeAll(async () => {
			await setupTestDb()
		})
		afterAll(async () => {
			await teardownTestDb()
		})

		test('[S3] resolve existing row returns stored secret verbatim', async () => {
			const sql = getTestSql()
			const tenantId = newId('organization')
			const expected = generateMagicLinkSecret()
			await seedOrgProfile(sql, tenantId, expected)

			const resolver = createMagicLinkSecretResolver(sql)
			const got = await resolver.resolve(tenantId)
			expect(got).toBe(expected)
		})

		test('[S4] resolve lazy-bootstrap on NULL — generates + UPDATE + returns', async () => {
			const sql = getTestSql()
			const tenantId = newId('organization')
			await seedOrgProfile(sql, tenantId, null)

			const resolver = createMagicLinkSecretResolver(sql)
			const got = await resolver.resolve(tenantId)
			expect(got).toMatch(/^[A-Za-z0-9_-]{43}$/)

			// Verify UPDATE persisted.
			const [rows = []] = await sql<[{ magicLinkSecret: string | null }]>`
				SELECT magicLinkSecret FROM organizationProfile
				WHERE organizationId = ${tenantId}
			`.idempotent(true)
			expect(rows[0]?.magicLinkSecret).toBe(got)
		})

		test('[S5] resolve second call returns same back-filled secret', async () => {
			const sql = getTestSql()
			const tenantId = newId('organization')
			await seedOrgProfile(sql, tenantId, null)

			const resolver = createMagicLinkSecretResolver(sql)
			const first = await resolver.resolve(tenantId)
			const second = await resolver.resolve(tenantId)
			expect(second).toBe(first)
		})

		test('[S6] resolve concurrent first-readers — both succeed (race-safe)', async () => {
			const sql = getTestSql()
			const tenantId = newId('organization')
			await seedOrgProfile(sql, tenantId, null)

			const resolver = createMagicLinkSecretResolver(sql)
			const [a, b, c] = await Promise.all([
				resolver.resolve(tenantId),
				resolver.resolve(tenantId),
				resolver.resolve(tenantId),
			])
			// Each succeeded; final stored value matches one of them.
			expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
			expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/)
			expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/)
			const [rows = []] = await sql<[{ magicLinkSecret: string | null }]>`
				SELECT magicLinkSecret FROM organizationProfile
				WHERE organizationId = ${tenantId}
			`.idempotent(true)
			const stored = rows[0]?.magicLinkSecret
			expect(stored).toBeDefined()
			// At least one of the resolved values matches stored (winner overwrite ОК).
			expect([a, b, c]).toContain(stored)
		})

		test('[S7] resolve missing organizationProfile row throws', async () => {
			const sql = getTestSql()
			const resolver = createMagicLinkSecretResolver(sql)
			const orphanTenantId = newId('organization')
			// NO seedOrgProfile call — row doesn't exist.
			await expect(resolver.resolve(orphanTenantId)).rejects.toThrow(
				/magicLinkSecret resolve failed/,
			)
		})

		test('[S8] cross-tenant: tenant A secret NOT visible через tenant B', async () => {
			const sql = getTestSql()
			const tenantA = newId('organization')
			const tenantB = newId('organization')
			const secretA = generateMagicLinkSecret()
			const secretB = generateMagicLinkSecret()
			await seedOrgProfile(sql, tenantA, secretA)
			await seedOrgProfile(sql, tenantB, secretB)

			const resolver = createMagicLinkSecretResolver(sql)
			const gotA = await resolver.resolve(tenantA)
			const gotB = await resolver.resolve(tenantB)
			expect(gotA).toBe(secretA)
			expect(gotB).toBe(secretB)
			expect(gotA).not.toBe(gotB)
		})
	})
})
