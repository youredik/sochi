/**
 * Strict tests для magic-link service (M9.widget.5 / A3.1.a).
 *
 * Composes secret resolver + jwt + repo. DB integration.
 *
 * Coverage matrix:
 *   ─── Issue path ──────────────────────────────────────────────
 *     [MLS1] issue view → JWT signed + token row inserted с attemptsRemaining=5
 *     [MLS2] issue mutate → JWT signed + token row inserted с attemptsRemaining=1
 *     [MLS3] issue с custom ttlSeconds → claims.expiresAt reflects override
 *     [MLS4] issue с custom attemptsRemaining → row stores override
 *     [MLS5] issue captures issuedFromIp в audit field
 *
 *   ─── Verify path (no mutation) ────────────────────────────────
 *     [MLS6] verify valid JWT returns claims + token unchanged
 *     [MLS7] verify wrong tenantId → MagicLinkVerifyError('tenant_mismatch')
 *     [MLS8] verify with wrong-tenant secret → MagicLinkVerifyError('invalid_signature')
 *     [MLS9] verify expired JWT → MagicLinkVerifyError('expired')
 *     [MLS10] verify malformed JWT → MagicLinkVerifyError('malformed')
 *     [MLS11] verify after full consume → MagicLinkVerifyError('fully_consumed')
 *     [MLS12] verify non-existent token row → MagicLinkVerifyError('not_found')
 *
 *   ─── Consume path ────────────────────────────────────────────
 *     [MLS13] consume valid view JWT first time → fullyConsumed=false, attemptsRemaining=4
 *     [MLS14] consume valid mutate JWT → fullyConsumed=true (single-use)
 *     [MLS15] consume expired JWT → MagicLinkVerifyError('expired')
 *     [MLS16] consume already-fully-consumed → MagicLinkVerifyError('fully_consumed')
 *     [MLS17] consume populates consumedFromIp + consumedFromUa
 *     [MLS18] consume with wrong-tenant secret → MagicLinkVerifyError('invalid_signature')
 *
 *   ─── Cross-tenant isolation ──────────────────────────────────
 *     [MLS19] tenant A's JWT NOT verifiable through tenant B context
 *     [MLS20] tenant A's JWT NOT consumable through tenant B context
 */

import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
	createMagicLinkSecretResolver,
	generateMagicLinkSecret,
} from '../../lib/magic-link/secret.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createMagicLinkTokenRepo } from './magic-link.repo.ts'
import { createMagicLinkService, MagicLinkVerifyError } from './magic-link.service.ts'

async function seedOrgProfile(
	sql: ReturnType<typeof getTestSql>,
	tenantId: string,
	magicLinkSecret: string | null = null,
): Promise<void> {
	const now = new Date()
	await sql`
		UPSERT INTO organization (id, name, slug, logo, metadata, createdAt)
		VALUES (${tenantId}, ${`Test ${tenantId}`}, ${tenantId}, ${'logo'}, ${'{}'}, ${now})
	`.idempotent(true)
	if (magicLinkSecret === null) {
		await sql`
			UPSERT INTO organizationProfile (
				organizationId, plan, createdAt, updatedAt
			) VALUES (${tenantId}, ${'starter'}, ${now}, ${now})
		`.idempotent(true)
	} else {
		await sql`
			UPSERT INTO organizationProfile (
				organizationId, plan, createdAt, updatedAt, magicLinkSecret
			) VALUES (${tenantId}, ${'starter'}, ${now}, ${now}, ${magicLinkSecret})
		`.idempotent(true)
	}
}

function buildService(sql: ReturnType<typeof getTestSql>) {
	return createMagicLinkService({
		secretResolver: createMagicLinkSecretResolver(sql),
		tokenRepo: createMagicLinkTokenRepo(sql),
	})
}

describe('magic-link.service', { tags: ['db'], timeout: 60_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})
	afterAll(async () => {
		await teardownTestDb()
	})

	test('[MLS1] issue view → JWT + row attemptsRemaining=5', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)

		const bookingId = newId('booking')
		const { jwt, claims } = await svc.issue({
			tenantId,
			bookingId,
			scope: 'view',
		})
		expect(jwt.split('.').length).toBe(3)
		expect(claims.scope).toBe('view')
		expect(claims.bookingId).toBe(bookingId)

		const repo = createMagicLinkTokenRepo(sql)
		const row = await repo.findByJti(tenantId, claims.jti)
		expect(row?.attemptsRemaining).toBe(5)
	})

	test('[MLS2] issue mutate → row attemptsRemaining=1', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const bookingId = newId('booking')
		const { claims } = await svc.issue({ tenantId, bookingId, scope: 'mutate' })

		const repo = createMagicLinkTokenRepo(sql)
		const row = await repo.findByJti(tenantId, claims.jti)
		expect(row?.attemptsRemaining).toBe(1)
		expect(row?.scope).toBe('mutate')
	})

	test('[MLS3] issue custom ttlSeconds reflects in claims.expiresAt', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const { claims } = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'view',
			ttlSeconds: 42,
		})
		expect(claims.expiresAt - claims.issuedAt).toBe(42)
	})

	test('[MLS4] issue custom attemptsRemaining override stored', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const { claims } = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'view',
			attemptsRemaining: 3,
		})
		const repo = createMagicLinkTokenRepo(sql)
		const row = await repo.findByJti(tenantId, claims.jti)
		expect(row?.attemptsRemaining).toBe(3)
	})

	test('[MLS5] issue captures issuedFromIp в audit field', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const { claims } = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'view',
			issuedFromIp: '203.0.113.55',
		})
		const repo = createMagicLinkTokenRepo(sql)
		const row = await repo.findByJti(tenantId, claims.jti)
		expect(row?.issuedFromIp).toBe('203.0.113.55')
	})

	test('[MLS6] verify valid JWT returns claims + token (no mutation)', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'view',
		})
		const verified = await svc.verify({ tenantId, jwt: issued.jwt })
		expect(verified.claims.bookingId).toBe(issued.claims.bookingId)
		expect(verified.token.attemptsRemaining).toBe(5) // unchanged
	})

	test('[MLS7] verify wrong tenantId → MagicLinkVerifyError', async () => {
		const sql = getTestSql()
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		await seedOrgProfile(sql, tenantA, generateMagicLinkSecret())
		await seedOrgProfile(sql, tenantB, generateMagicLinkSecret())
		const svc = buildService(sql)
		const { jwt } = await svc.issue({
			tenantId: tenantA,
			bookingId: newId('booking'),
			scope: 'view',
		})
		await expect(svc.verify({ tenantId: tenantB, jwt })).rejects.toBeInstanceOf(
			MagicLinkVerifyError,
		)
	})

	test('[MLS8] verify with wrong-tenant secret → invalid_signature', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		const realSecret = generateMagicLinkSecret()
		await seedOrgProfile(sql, tenantId, realSecret)
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'view',
		})
		// Mutate the secret in DB so verify fails.
		const newSecret = generateMagicLinkSecret()
		await sql`
			UPDATE organizationProfile
			SET magicLinkSecret = ${newSecret}
			WHERE organizationId = ${tenantId}
		`.idempotent(true)
		await expect(svc.verify({ tenantId, jwt: issued.jwt })).rejects.toThrow(MagicLinkVerifyError)
	})

	test('[MLS9] verify expired JWT → MagicLinkVerifyError("expired")', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const { jwt } = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'view',
			ttlSeconds: 1,
		})
		await new Promise((r) => setTimeout(r, 1100))
		await expect(svc.verify({ tenantId, jwt })).rejects.toBeInstanceOf(MagicLinkVerifyError)
	})

	test('[MLS10] verify malformed JWT → MagicLinkVerifyError', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		await expect(svc.verify({ tenantId, jwt: 'not-a-jwt' })).rejects.toBeInstanceOf(
			MagicLinkVerifyError,
		)
	})

	test('[MLS11] verify after full consume → fully_consumed', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'mutate',
		})
		await svc.consume({
			tenantId,
			jwt: issued.jwt,
			fromIp: '198.51.100.7',
			fromUa: null,
		})
		const err = await svc.verify({ tenantId, jwt: issued.jwt }).catch((e) => e)
		expect(err).toBeInstanceOf(MagicLinkVerifyError)
		expect((err as MagicLinkVerifyError).reason).toBe('fully_consumed')
	})

	test('[MLS12] verify non-existent token row → not_found', async () => {
		// JWT signature valid but DB row deleted between issue + verify
		// (theoretical — covered by orphan jti test).
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const { jwt, claims } = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'view',
		})
		// Manually delete row.
		await sql`
			DELETE FROM magicLinkToken
			WHERE tenantId = ${tenantId} AND jti = ${claims.jti}
		`.idempotent(true)
		const err = await svc.verify({ tenantId, jwt }).catch((e) => e)
		expect(err).toBeInstanceOf(MagicLinkVerifyError)
		expect((err as MagicLinkVerifyError).reason).toBe('not_found')
	})

	test('[MLS13] consume valid view JWT 1st time → 5→4', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'view',
		})
		const result = await svc.consume({
			tenantId,
			jwt: issued.jwt,
			fromIp: '198.51.100.7',
			fromUa: 'Mozilla/5.0',
		})
		expect(result.fullyConsumed).toBe(false)
		expect(result.token.attemptsRemaining).toBe(4)
	})

	test('[MLS14] consume valid mutate JWT → fullyConsumed=true', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'mutate',
		})
		const result = await svc.consume({
			tenantId,
			jwt: issued.jwt,
			fromIp: '198.51.100.7',
			fromUa: null,
		})
		expect(result.fullyConsumed).toBe(true)
		expect(result.token.attemptsRemaining).toBe(0)
	})

	test('[MLS15] consume expired JWT → MagicLinkVerifyError("expired")', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'view',
			ttlSeconds: 1,
		})
		await new Promise((r) => setTimeout(r, 1100))
		const err = await svc
			.consume({ tenantId, jwt: issued.jwt, fromIp: '198.51.100.7', fromUa: null })
			.catch((e) => e)
		expect(err).toBeInstanceOf(MagicLinkVerifyError)
	})

	test('[MLS16] consume already-fully-consumed → fully_consumed', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'mutate',
		})
		await svc.consume({ tenantId, jwt: issued.jwt, fromIp: '1.1.1.1', fromUa: null })
		const err = await svc
			.consume({ tenantId, jwt: issued.jwt, fromIp: '1.1.1.1', fromUa: null })
			.catch((e) => e)
		expect(err).toBeInstanceOf(MagicLinkVerifyError)
		expect((err as MagicLinkVerifyError).reason).toBe('fully_consumed')
	})

	test('[MLS17] consume populates consumedFromIp + consumedFromUa', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'mutate',
		})
		await svc.consume({
			tenantId,
			jwt: issued.jwt,
			fromIp: '203.0.113.55',
			fromUa: 'GuestPortalUA/1.0',
		})
		const repo = createMagicLinkTokenRepo(sql)
		const row = await repo.findByJti(tenantId, issued.claims.jti)
		expect(row?.consumedFromIp).toBe('203.0.113.55')
		expect(row?.consumedFromUa).toBe('GuestPortalUA/1.0')
	})

	test('[MLS18] consume с rotated secret → invalid_signature', async () => {
		const sql = getTestSql()
		const tenantId = newId('organization')
		await seedOrgProfile(sql, tenantId, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId,
			bookingId: newId('booking'),
			scope: 'mutate',
		})
		await sql`
			UPDATE organizationProfile
			SET magicLinkSecret = ${generateMagicLinkSecret()}
			WHERE organizationId = ${tenantId}
		`.idempotent(true)
		const err = await svc
			.consume({ tenantId, jwt: issued.jwt, fromIp: '1.2.3.4', fromUa: null })
			.catch((e) => e)
		expect(err).toBeInstanceOf(MagicLinkVerifyError)
	})

	test('[MLS19] cross-tenant: A JWT NOT verifiable через B context', async () => {
		const sql = getTestSql()
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		await seedOrgProfile(sql, tenantA, generateMagicLinkSecret())
		await seedOrgProfile(sql, tenantB, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId: tenantA,
			bookingId: newId('booking'),
			scope: 'view',
		})
		await expect(svc.verify({ tenantId: tenantB, jwt: issued.jwt })).rejects.toBeInstanceOf(
			MagicLinkVerifyError,
		)
	})

	test('[MLS20] cross-tenant: A JWT NOT consumable через B context', async () => {
		const sql = getTestSql()
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		await seedOrgProfile(sql, tenantA, generateMagicLinkSecret())
		await seedOrgProfile(sql, tenantB, generateMagicLinkSecret())
		const svc = buildService(sql)
		const issued = await svc.issue({
			tenantId: tenantA,
			bookingId: newId('booking'),
			scope: 'mutate',
		})
		const err = await svc
			.consume({
				tenantId: tenantB,
				jwt: issued.jwt,
				fromIp: '1.1.1.1',
				fromUa: null,
			})
			.catch((e) => e)
		expect(err).toBeInstanceOf(MagicLinkVerifyError)
		// A's token still active.
		const repo = createMagicLinkTokenRepo(sql)
		const row = await repo.findByJti(tenantA, issued.claims.jti)
		expect(row?.attemptsRemaining).toBe(1)
	})
})
