/**
 * Embed repo — strict tests per `feedback_strict_tests.md`.
 *
 * Test matrix:
 *   ─── publicEmbedDomains read/write ─────────────────────────────
 *     [PED1] write valid 2-origin allowlist → read returns same array
 *     [PED2] write empty array → read returns null (semantic collapse)
 *     [PED3] read NULL column → null (canonical "embed disabled")
 *     [PED4] read missing property → null (cross-tenant guard)
 *     [PED5] write rejects http:// (zod schema regex)
 *     [PED6] write rejects CRLF embedded в origin (header-injection)
 *     [PED7] write rejects array of 33 origins (max-size cap)
 *     [PED8] write rejects Cyrillic hostname (must be punycode)
 *     [PED9] read isPublic=false property → null (defends against accidental
 *            allowlist exposure on private property)
 *     [PED10] cross-tenant: tenantA reads tenantB's property → null
 *
 *   ─── widgetReleaseAudit append-only ────────────────────────────
 *     [AUD1] appendAudit insert + listAudit returns row с full shape
 *     [AUD2] listAudit ordered by actionAt DESC
 *     [AUD3] cross-tenant: tenantA listAudit returns ONLY tenantA's rows
 *     [AUD4] appendAudit с reason containing CRLF → reject
 *     [AUD5] appendAudit с invalid hash format (not 96 hex chars) → reject
 *     [AUD6] appendAudit с reason ≤500 chars accepted; >500 rejected
 *     [AUD7] action='revoked' allowed; arbitrary action='garbage' rejected
 */

import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { toJson, toTs } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createEmbedRepo } from './embed.repo.ts'

describe('embed.repo', { tags: ['db'], timeout: 60_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})

	afterAll(async () => {
		await teardownTestDb()
	})

	async function seedProperty(opts: {
		tenantId: string
		propertyId: string
		isPublic: boolean | null
		isActive?: boolean
		publicEmbedDomains?: readonly string[] | null
	}): Promise<void> {
		const sql = getTestSql()
		const now = new Date()
		const isActive = opts.isActive ?? true
		const nowTs = toTs(now)
		const ped = opts.publicEmbedDomains
		await sql`
			UPSERT INTO property (
				\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
				\`isActive\`, \`isPublic\`, \`publicEmbedDomains\`,
				\`createdAt\`, \`updatedAt\`
			) VALUES (
				${opts.tenantId}, ${opts.propertyId},
				${'Test Property'}, ${'addr'}, ${'Sochi'}, ${'Europe/Moscow'},
				${isActive}, ${opts.isPublic},
				${ped === null || ped === undefined ? toJson(null) : toJson(ped)},
				${nowTs}, ${nowTs}
			)
		`
	}

	describe('publicEmbedDomains read / write', () => {
		test('[PED1] write 2-origin allowlist → read returns same array', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedProperty({ tenantId, propertyId, isPublic: true })
			await repo.setPublicEmbedDomains(tenantId, propertyId, [
				'https://hotel-aurora.ru',
				'https://www.hotel-aurora.ru',
			])
			const got = await repo.getPublicEmbedDomains(tenantId, propertyId)
			expect(got).toEqual(['https://hotel-aurora.ru', 'https://www.hotel-aurora.ru'])
		})

		test('[PED3] read NULL column → null', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedProperty({ tenantId, propertyId, isPublic: true, publicEmbedDomains: null })
			expect(await repo.getPublicEmbedDomains(tenantId, propertyId)).toBeNull()
		})

		test('[PED4] read missing property → null', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			expect(await repo.getPublicEmbedDomains(newId('organization'), newId('property'))).toBeNull()
		})

		test('[PED5] write rejects http:// (zod regex)', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedProperty({ tenantId, propertyId, isPublic: true })
			await expect(
				repo.setPublicEmbedDomains(tenantId, propertyId, ['http://insecure.ru']),
			).rejects.toThrow()
		})

		test('[PED6] write rejects CRLF embedded в origin (header-injection)', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedProperty({ tenantId, propertyId, isPublic: true })
			await expect(
				repo.setPublicEmbedDomains(tenantId, propertyId, ['https://aurora.ru\r\nSet-Cookie: x=1']),
			).rejects.toThrow()
		})

		test('[PED7] write rejects array of 33 origins (max-32 cap)', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedProperty({ tenantId, propertyId, isPublic: true })
			const tooMany = Array.from({ length: 33 }, (_, i) => `https://t${i}.ru`)
			await expect(repo.setPublicEmbedDomains(tenantId, propertyId, tooMany)).rejects.toThrow()
		})

		test('[PED8] write rejects Cyrillic hostname (must be punycode)', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedProperty({ tenantId, propertyId, isPublic: true })
			await expect(
				repo.setPublicEmbedDomains(tenantId, propertyId, ['https://отель.рф']),
			).rejects.toThrow()
		})

		test('[PED9] read isPublic=false → null', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedProperty({
				tenantId,
				propertyId,
				isPublic: false,
				publicEmbedDomains: ['https://hotel.ru'],
			})
			expect(await repo.getPublicEmbedDomains(tenantId, propertyId)).toBeNull()
		})

		test('[PED10] cross-tenant: tenantA reads tenantB property → null', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantA = newId('organization')
			const tenantB = newId('organization')
			const propertyB = newId('property')
			await seedProperty({
				tenantId: tenantB,
				propertyId: propertyB,
				isPublic: true,
				publicEmbedDomains: ['https://hotel-b.ru'],
			})
			expect(await repo.getPublicEmbedDomains(tenantA, propertyB)).toBeNull()
		})
	})

	describe('widgetReleaseAudit append-only', () => {
		const HASH_A = 'a'.repeat(96)
		const HASH_B = 'b'.repeat(96)

		test('[AUD1] appendAudit + listAudit returns row с full shape', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const id = newId('widgetReleaseAudit')
			const actionAt = new Date('2026-05-04T10:00:00.000Z')
			await repo.appendAudit({
				tenantId,
				id,
				hash: HASH_A,
				bundleKind: 'embed',
				action: 'published',
				reason: 'initial release',
				actorUserId: 'user_test',
				actorSource: 'ci',
				actionAt,
			})
			const rows = await repo.listAudit(tenantId)
			expect(rows).toHaveLength(1)
			expect(rows[0]).toEqual({
				id,
				hash: HASH_A,
				bundleKind: 'embed',
				action: 'published',
				reason: 'initial release',
				actorUserId: 'user_test',
				actorSource: 'ci',
				actionAt: expect.any(Date),
			})
		})

		test('[AUD2] listAudit ordered by actionAt DESC', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			await repo.appendAudit({
				tenantId,
				id: newId('widgetReleaseAudit'),
				hash: HASH_A,
				bundleKind: 'embed',
				action: 'published',
				reason: 'first',
				actorUserId: 'user_test',
				actorSource: 'ci',
				actionAt: new Date('2026-05-01T10:00:00.000Z'),
			})
			await repo.appendAudit({
				tenantId,
				id: newId('widgetReleaseAudit'),
				hash: HASH_B,
				bundleKind: 'embed',
				action: 'revoked',
				reason: 'second',
				actorUserId: 'user_test',
				actorSource: 'admin_ui',
				actionAt: new Date('2026-05-04T10:00:00.000Z'),
			})
			const rows = await repo.listAudit(tenantId)
			expect(rows).toHaveLength(2)
			expect(rows[0]?.reason).toBe('second')
			expect(rows[1]?.reason).toBe('first')
		})

		test('[AUD3] cross-tenant: tenantA listAudit returns ONLY tenantA rows', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantA = newId('organization')
			const tenantB = newId('organization')
			await repo.appendAudit({
				tenantId: tenantA,
				id: newId('widgetReleaseAudit'),
				hash: HASH_A,
				bundleKind: 'embed',
				action: 'published',
				reason: 'A row',
				actorUserId: 'user_test',
				actorSource: 'ci',
				actionAt: new Date('2026-05-04T10:00:00.000Z'),
			})
			await repo.appendAudit({
				tenantId: tenantB,
				id: newId('widgetReleaseAudit'),
				hash: HASH_B,
				bundleKind: 'embed',
				action: 'published',
				reason: 'B row',
				actorUserId: 'user_test',
				actorSource: 'ci',
				actionAt: new Date('2026-05-04T11:00:00.000Z'),
			})
			const rowsA = await repo.listAudit(tenantA)
			const rowsB = await repo.listAudit(tenantB)
			expect(rowsA).toHaveLength(1)
			expect(rowsA[0]?.reason).toBe('A row')
			expect(rowsB).toHaveLength(1)
			expect(rowsB[0]?.reason).toBe('B row')
		})

		test('[AUD4] appendAudit с reason containing CRLF → reject', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			await expect(
				repo.appendAudit({
					tenantId: newId('organization'),
					id: newId('widgetReleaseAudit'),
					hash: HASH_A,
					bundleKind: 'embed',
					action: 'revoked',
					reason: 'evil\r\nSet-Cookie: x=1',
					actorUserId: 'user_test',
					actorSource: 'admin_ui',
					actionAt: new Date(),
				}),
			).rejects.toThrow()
		})

		test('[AUD5] appendAudit с invalid hash format → reject', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			await expect(
				repo.appendAudit({
					tenantId: newId('organization'),
					id: newId('widgetReleaseAudit'),
					hash: 'short',
					bundleKind: 'embed',
					action: 'published',
					reason: null,
					actorUserId: 'user_test',
					actorSource: 'ci',
					actionAt: new Date(),
				}),
			).rejects.toThrow()
		})

		test('[AUD6] reason >500 chars rejected', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			await expect(
				repo.appendAudit({
					tenantId: newId('organization'),
					id: newId('widgetReleaseAudit'),
					hash: HASH_A,
					bundleKind: 'embed',
					action: 'revoked',
					reason: 'x'.repeat(501),
					actorUserId: 'user_test',
					actorSource: 'admin_ui',
					actionAt: new Date(),
				}),
			).rejects.toThrow()
		})

		test('[AUD7] arbitrary action="garbage" rejected', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			await expect(
				repo.appendAudit({
					tenantId: newId('organization'),
					id: newId('widgetReleaseAudit'),
					hash: HASH_A,
					bundleKind: 'embed',
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					action: 'garbage' as never,
					reason: null,
					actorUserId: 'user_test',
					actorSource: 'ci',
					actionAt: new Date(),
				}),
			).rejects.toThrow()
		})
	})
})
