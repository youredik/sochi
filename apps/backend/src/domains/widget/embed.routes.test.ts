/**
 * Embed routes — integration tests E1-E15 per plan §A4.3.
 *
 * Test matrix:
 *   ─── GET facade ──────────────────────────────────────────────
 *     [E1]  match hash + allowlist → 200 + bundle bytes + immutable headers
 *     [E2]  unknown slug → 404 timing-safe (≥15ms wall-clock floor)
 *     [E3]  cross-tenant slug (slug resolves but property private) → 404
 *     [E4]  hash mismatch → 410 Gone
 *     [E5]  allowed Origin echoed via Access-Control-Allow-Origin (D21)
 *
 *   ─── GET lazy chunk ──────────────────────────────────────────
 *     [E6]  match hash → 200 + immutable + no per-tenant headers
 *
 *   ─── POST commit-token ──────────────────────────────────────
 *     [E7]  Origin in allowlist + valid slug → 200 + JWT (csrf passes)
 *     [E8]  Origin NOT in allowlist → 403 (csrf rejects)
 *     [E9]  signed token verifies via service.verifyCommitToken
 *
 *   ─── POST _kill (admin auth required) ───────────────────────
 *     [E10] no session → 401
 *     [E11] session with wrong tenant → 403
 *     [E12] valid session + body → 200 + audit row written
 *
 *   ─── publicEmbedDomains write/read consistency ──────────────
 *     [E13] zod regex rejects http:// at write time
 *     [E14] zod rejects CRLF embedded in origin
 *     [E15] revoked hash → subsequent facade GET returns 410
 */

import { newId } from '@horeca/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { toJson, toTs } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'

// Mock auth.ts BEFORE importing embed.routes — vi.mock is hoisted.
const mockGetSession =
	vi.fn<
		(input: { headers: Headers }) => Promise<{
			user: { id: string }
			session: { activeOrganizationId: string | null }
		} | null>
	>()
vi.mock('../../auth.ts', () => ({
	auth: {
		api: {
			getSession: mockGetSession,
		},
	},
}))

const { createEmbedRoutes } = await import('./embed.routes.ts')
const { createEmbedService } = await import('./embed.service.ts')
const { createEmbedRepo } = await import('./embed.repo.ts')

const FAKE_FACADE_BYTES = Buffer.from('!function(){"use strict";console.log("facade")}();')
const FAKE_FLOW_BYTES = Buffer.from('!function(){"use strict";console.log("flow")}();')

/**
 * Build slugs that match `tenant-resolver.ts` SLUG_PATTERN
 * `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$` — lowercase ASCII alphanumeric + hyphen.
 * Suffix uses `Math.random` base36 to keep tests independent.
 */
function randomSlug(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

const SECRET_CURRENT = new Uint8Array(Buffer.from('A'.repeat(32)))
const SECRET_PREVIOUS = null

function bootRoutes() {
	const sql = getTestSql()
	const repo = createEmbedRepo(sql)
	const service = createEmbedService({
		repo,
		secrets: { current: SECRET_CURRENT, previous: SECRET_PREVIOUS },
		bundlesDir: '/tmp/never-read', // overridden by bundlesOverride
		bundlesOverride: { embed: FAKE_FACADE_BYTES, 'booking-flow': FAKE_FLOW_BYTES },
	})
	const app = createEmbedRoutes({ service })
	return { app, service, repo }
}

async function seedPublicProperty(opts: {
	tenantId: string
	propertyId: string
	publicEmbedDomains: readonly string[] | null
	slug: string
}): Promise<void> {
	const sql = getTestSql()
	const now = new Date()
	const nowTs = toTs(now)
	// `organization.createdAt` is Datetime (not Timestamp) per migration 0001.
	await sql`
		UPSERT INTO organization (
			\`id\`, \`name\`, \`slug\`, \`createdAt\`
		) VALUES (
			${opts.tenantId}, ${'Test'}, ${opts.slug}, ${now}
		)
	`
	await sql`
		UPSERT INTO property (
			\`tenantId\`, \`id\`, \`name\`, \`address\`, \`city\`, \`timezone\`,
			\`isActive\`, \`isPublic\`, \`publicEmbedDomains\`,
			\`createdAt\`, \`updatedAt\`
		) VALUES (
			${opts.tenantId}, ${opts.propertyId},
			${'Test Property'}, ${'addr'}, ${'Sochi'}, ${'Europe/Moscow'},
			${true}, ${true},
			${opts.publicEmbedDomains === null ? toJson(null) : toJson(opts.publicEmbedDomains)},
			${nowTs}, ${nowTs}
		)
	`
}

describe('embed.routes', { tags: ['db'], timeout: 60_000 }, () => {
	beforeAll(async () => {
		await setupTestDb()
	})
	afterAll(async () => {
		await teardownTestDb()
	})
	afterEach(() => {
		mockGetSession.mockReset()
	})

	describe('GET facade /v1/:tenantSlug/:propertyId/:hash.js', () => {
		it('[E1] match hash + allowlist → 200 + bundle bytes + immutable headers', async () => {
			const { app, service } = bootRoutes()
			const slug = randomSlug('e1')
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: ['https://hotel-aurora.ru'],
				slug,
			})
			const facadeHash = service.getBundle('embed').hashHex
			const url = `/v1/${slug}/${propertyId}/${facadeHash}.js`
			const res = await app.request(url)
			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('application/javascript')
			expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
			expect(res.headers.get('integrity-policy')).toBe('blocked-destinations=(script)')
			expect(res.headers.get('reporting-endpoints')).toContain('integrity-endpoint')
			expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
			const buf = Buffer.from(await res.arrayBuffer())
			expect(buf.equals(FAKE_FACADE_BYTES)).toBe(true)
		})

		it('[E2] unknown slug → 404 timing-safe (wall-clock ≥15ms)', async () => {
			const { app } = bootRoutes()
			const facadeHash = 'a'.repeat(96)
			const t0 = Date.now()
			const res = await app.request(`/v1/non-existent-slug/${newId('property')}/${facadeHash}.js`)
			const elapsed = Date.now() - t0
			expect(res.status).toBe(404)
			expect(elapsed).toBeGreaterThanOrEqual(13) // 15ms floor minus jitter
		})

		it('[E3] property private (publicEmbedDomains=null) → 404', async () => {
			const { app } = bootRoutes()
			const slug = randomSlug('e3')
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({ tenantId, propertyId, publicEmbedDomains: null, slug })
			const facadeHash = 'b'.repeat(96)
			const res = await app.request(`/v1/${slug}/${propertyId}/${facadeHash}.js`)
			expect(res.status).toBe(404)
		})

		it('[E4] hash mismatch → 410 Gone (forces tenant rebuild)', async () => {
			const { app } = bootRoutes()
			const slug = randomSlug('e4')
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: ['https://hotel.ru'],
				slug,
			})
			const wrongHash = 'c'.repeat(96)
			const res = await app.request(`/v1/${slug}/${propertyId}/${wrongHash}.js`)
			expect(res.status).toBe(410)
		})

		it('[E5] allowed Origin echoed via Access-Control-Allow-Origin', async () => {
			const { app, service } = bootRoutes()
			const slug = randomSlug('e5')
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: ['https://hotel-aurora.ru'],
				slug,
			})
			const facadeHash = service.getBundle('embed').hashHex
			const res = await app.request(`/v1/${slug}/${propertyId}/${facadeHash}.js`, {
				headers: { Origin: 'https://hotel-aurora.ru' },
			})
			expect(res.status).toBe(200)
			expect(res.headers.get('access-control-allow-origin')).toBe('https://hotel-aurora.ru')
			expect(res.headers.get('vary')).toContain('Origin')
		})
	})

	describe('GET lazy chunk /v1/_chunk/booking-flow/:hash.js', () => {
		it('[E6] match hash → 200 + immutable + ACAO=*', async () => {
			const { app, service } = bootRoutes()
			const flowHash = service.getBundle('booking-flow').hashHex
			const res = await app.request(`/v1/_chunk/booking-flow/${flowHash}.js`)
			expect(res.status).toBe(200)
			expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
			expect(res.headers.get('access-control-allow-origin')).toBe('*')
			const buf = Buffer.from(await res.arrayBuffer())
			expect(buf.equals(FAKE_FLOW_BYTES)).toBe(true)
		})
	})

	describe('POST commit-token /v1/:tenantSlug/:propertyId/commit-token', () => {
		it('[E7] Origin in allowlist → 200 + JWT', async () => {
			const { app } = bootRoutes()
			const slug = randomSlug('e7')
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: ['https://hotel.ru'],
				slug,
			})
			const res = await app.request(`/v1/${slug}/${propertyId}/commit-token`, {
				method: 'POST',
				headers: {
					Origin: 'https://hotel.ru',
					'Content-Type': 'application/json',
				},
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as { token: string; issuedAt: number }
			expect(body.token.split('.')).toHaveLength(3) // JWT header.payload.sig
			expect(body.issuedAt).toBeGreaterThan(0)
		})

		it('[E8] Origin NOT in allowlist → 403 (csrf rejects)', async () => {
			const { app } = bootRoutes()
			const slug = randomSlug('e8')
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: ['https://hotel.ru'],
				slug,
			})
			const res = await app.request(`/v1/${slug}/${propertyId}/commit-token`, {
				method: 'POST',
				headers: {
					Origin: 'https://evil.ru',
					'Content-Type': 'application/json',
				},
			})
			expect(res.status).toBe(403)
		})

		it('[E9] signed token verifies (round-trip + nbf gap)', async () => {
			const { app, service } = bootRoutes()
			const slug = randomSlug('e9')
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: ['https://hotel.ru'],
				slug,
			})
			const res = await app.request(`/v1/${slug}/${propertyId}/commit-token`, {
				method: 'POST',
				headers: { Origin: 'https://hotel.ru', 'Content-Type': 'application/json' },
			})
			const { token } = (await res.json()) as { token: string }
			// Sleep ≥0.8s so nbf is satisfied at verify time.
			await new Promise((r) => setTimeout(r, 850))
			const claims = await service.verifyCommitToken(token)
			expect(claims.tenantId).toBe(tenantId)
			expect(claims.slug).toBe(slug)
			expect(claims.kid).toBe('current')
		})
	})

	describe('POST _kill /v1/_kill (admin auth)', () => {
		it('[E10] no session → 401', async () => {
			const { app } = bootRoutes()
			mockGetSession.mockResolvedValueOnce(null)
			const res = await app.request('/v1/_kill', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: 'https://admin.sochi.app' },
				body: JSON.stringify({
					hash: 'a'.repeat(96),
					bundleKind: 'embed',
					action: 'revoked',
					reason: 'security incident',
					tenantId: newId('organization'),
				}),
			})
			expect(res.status).toBe(401)
		})

		it('[E11] session with wrong tenant → 403', async () => {
			const { app } = bootRoutes()
			const sessionTenant = newId('organization')
			const targetTenant = newId('organization')
			mockGetSession.mockResolvedValueOnce({
				user: { id: 'user_test' },
				session: { activeOrganizationId: sessionTenant },
			})
			const res = await app.request('/v1/_kill', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: 'https://admin.sochi.app' },
				body: JSON.stringify({
					hash: 'a'.repeat(96),
					bundleKind: 'embed',
					action: 'revoked',
					reason: 'security incident',
					tenantId: targetTenant,
				}),
			})
			expect(res.status).toBe(403)
		})

		it('[E12] valid session + body → 200 + audit row appended', async () => {
			const { app, repo } = bootRoutes()
			const tenantId = newId('organization')
			mockGetSession.mockResolvedValueOnce({
				user: { id: 'user_admin' },
				session: { activeOrganizationId: tenantId },
			})
			const targetHash = 'd'.repeat(96)
			const res = await app.request('/v1/_kill', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: 'https://admin.sochi.app' },
				body: JSON.stringify({
					hash: targetHash,
					bundleKind: 'embed',
					action: 'revoked',
					reason: 'compromised CDN',
					tenantId,
				}),
			})
			expect(res.status).toBe(200)
			const audit = await repo.listAudit(tenantId)
			expect(audit.length).toBe(1)
			expect(audit[0]?.hash).toBe(targetHash)
			expect(audit[0]?.action).toBe('revoked')
			expect(audit[0]?.reason).toBe('compromised CDN')
			expect(audit[0]?.actorUserId).toBe('user_admin')
		})
	})

	describe('publicEmbedDomains validation + revocation cycle', () => {
		it('[E13] write rejects http:// (zod regex)', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: null,
				slug: randomSlug('e13'),
			})
			await expect(
				repo.setPublicEmbedDomains(tenantId, propertyId, ['http://insecure.ru']),
			).rejects.toThrow()
		})

		it('[E14] write rejects CRLF embedded в origin (header-injection guard)', async () => {
			const sql = getTestSql()
			const repo = createEmbedRepo(sql)
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: null,
				slug: randomSlug('e14'),
			})
			await expect(
				repo.setPublicEmbedDomains(tenantId, propertyId, ['https://aurora.ru\r\nSet-Cookie: x=1']),
			).rejects.toThrow()
		})

		it('[E15] revoked hash → subsequent facade GET returns 410', async () => {
			const { app, service, repo } = bootRoutes()
			const slug = randomSlug('e15')
			const tenantId = newId('organization')
			const propertyId = newId('property')
			await seedPublicProperty({
				tenantId,
				propertyId,
				publicEmbedDomains: ['https://hotel.ru'],
				slug,
			})
			const facadeHash = service.getBundle('embed').hashHex
			// Pre-condition: GET works.
			const okRes = await app.request(`/v1/${slug}/${propertyId}/${facadeHash}.js`)
			expect(okRes.status).toBe(200)
			// Revoke the hash.
			await repo.appendAudit({
				tenantId,
				id: newId('widgetReleaseAudit'),
				hash: facadeHash,
				bundleKind: 'embed',
				action: 'revoked',
				reason: 'test revoke',
				actorUserId: 'user_test',
				actorSource: 'admin_ui',
				actionAt: new Date(),
			})
			// Post-condition: GET returns 410.
			const goneRes = await app.request(`/v1/${slug}/${propertyId}/${facadeHash}.js`)
			expect(goneRes.status).toBe(410)
		})
	})
})
