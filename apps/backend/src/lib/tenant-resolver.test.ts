/**
 * Tenant resolver — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── normalizeSlug (pure) ──────────────────────────────────────
 *     [N1] valid lowercase slug → returns slug as-is
 *     [N2] uppercase / mixed-case → lowercased
 *     [N3] leading/trailing whitespace → trimmed
 *     [N4] too-short (1-2 chars) → null
 *     [N5] too-long (>30 chars) → null
 *     [N6] non-ASCII (Cyrillic, emoji) → null
 *     [N7] starts/ends with dash → null
 *     [N8] sql-injection-like input → null (no need to escape, regex blocks)
 *
 *   ─── resolveTenantBySlug (integration with real YDB) ───────────
 *     [R1] known slug → returns tenantId + slug + name + mode
 *     [R2] known slug, mixed-case input → still resolves (normalized)
 *     [R3] unknown slug → null (not throw)
 *     [R4] malformed slug → null (without DB query)
 *     [R5] organization without organizationProfile → mode=null
 */

import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
import { normalizeSlug, resolveTenantBySlug } from './tenant-resolver.ts'

describe('normalizeSlug — pure', () => {
	test('[N1] valid lowercase slug → returns as-is', () => {
		expect(normalizeSlug('demo-sirius')).toBe('demo-sirius')
		expect(normalizeSlug('hotel-sochi-2026')).toBe('hotel-sochi-2026')
		expect(normalizeSlug('a1b')).toBe('a1b')
	})

	test('[N2] uppercase / mixed-case → lowercased', () => {
		expect(normalizeSlug('DEMO-SIRIUS')).toBe('demo-sirius')
		expect(normalizeSlug('Hotel-Sochi')).toBe('hotel-sochi')
	})

	test('[N3] leading/trailing whitespace → trimmed', () => {
		expect(normalizeSlug('  demo-sirius  ')).toBe('demo-sirius')
		expect(normalizeSlug('\tdemo\n')).toBe('demo')
	})

	test('[N4] too-short → null', () => {
		expect(normalizeSlug('a')).toBeNull()
		expect(normalizeSlug('ab')).toBeNull()
		expect(normalizeSlug('')).toBeNull()
	})

	test('[N5] too-long (>30) → null', () => {
		expect(normalizeSlug('a'.repeat(31))).toBeNull()
		expect(normalizeSlug('a'.repeat(50))).toBeNull()
	})

	test('[N6] non-ASCII (Cyrillic, emoji) → null', () => {
		expect(normalizeSlug('демо-сириус')).toBeNull()
		expect(normalizeSlug('hotel🏨')).toBeNull()
		expect(normalizeSlug('café-sochi')).toBeNull()
	})

	test('[N7] starts/ends with dash → null', () => {
		expect(normalizeSlug('-demo')).toBeNull()
		expect(normalizeSlug('demo-')).toBeNull()
	})

	test('[N8] sql-injection-like → null (regex blocks)', () => {
		expect(normalizeSlug("'; DROP TABLE")).toBeNull()
		expect(normalizeSlug('a OR 1=1')).toBeNull()
		expect(normalizeSlug('a;b')).toBeNull()
	})
})

describe('resolveTenantBySlug — integration', { tags: ['db'], timeout: 60_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	async function seedOrg(opts: {
		id: string
		slug: string
		name: string
		mode?: 'demo' | 'production' | null
	}) {
		const sql = getTestSql()
		const now = new Date()
		await sql`UPSERT INTO organization (id, name, slug, createdAt) VALUES (${opts.id}, ${opts.name}, ${opts.slug}, ${now})`
		if (opts.mode !== undefined) {
			await sql`
				UPSERT INTO organizationProfile (organizationId, plan, createdAt, updatedAt, mode)
				VALUES (${opts.id}, ${'free'}, ${now}, ${now}, ${opts.mode})
			`
		}
	}

	test('[R1] known slug → returns tenantId + slug + name + mode', async () => {
		const id = newId('organization')
		const slug = `r1-${Date.now().toString(36)}`
		await seedOrg({ id, slug, name: 'Test R1 Hotel', mode: 'demo' })
		const result = await resolveTenantBySlug(slug)
		expect(result).not.toBeNull()
		expect(result?.tenantId).toBe(id)
		expect(result?.slug).toBe(slug)
		expect(result?.name).toBe('Test R1 Hotel')
		expect(result?.mode).toBe('demo')
	})

	test('[R2] mixed-case input still resolves (lowercase normalized)', async () => {
		const id = newId('organization')
		const slug = `r2-${Date.now().toString(36)}`
		await seedOrg({ id, slug, name: 'Test R2', mode: 'production' })
		const result = await resolveTenantBySlug(slug.toUpperCase())
		expect(result).not.toBeNull()
		expect(result?.tenantId).toBe(id)
	})

	test('[R3] unknown slug → null (not throw)', async () => {
		const result = await resolveTenantBySlug(`nonexistent-${Date.now()}`)
		expect(result).toBeNull()
	})

	test('[R4] malformed slug → null without DB query (regex blocks first)', async () => {
		expect(await resolveTenantBySlug('демо')).toBeNull()
		expect(await resolveTenantBySlug('a')).toBeNull()
		expect(await resolveTenantBySlug('')).toBeNull()
	})

	test('[R5] organization без organizationProfile → mode=null', async () => {
		const id = newId('organization')
		const slug = `r5-${Date.now().toString(36)}`
		await seedOrg({ id, slug, name: 'Test R5' }) // no profile
		const result = await resolveTenantBySlug(slug)
		expect(result).not.toBeNull()
		expect(result?.mode).toBeNull()
	})
})
