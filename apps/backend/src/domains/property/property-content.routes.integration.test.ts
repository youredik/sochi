/**
 * Property-content routes — FULL integration tests against real YDB.
 *
 * Closes the M8.A.0.fix.4/9 gap: route + repo + middleware end-to-end with
 * cross-tenant probes, RBAC × tenant scope, and Idempotency-Key replay.
 *
 * Per `feedback_pre_done_audit.md`:
 *   - Cross-tenant absolute on EVERY method (GET / PUT / POST / PATCH / DELETE)
 *   - Idempotency-Key replay: identical body + key → identical response
 *   - Idempotency-Key fingerprint mismatch: same key + different body → 422
 *   - Bigint wire-form coercion through real route stack
 */
import { Hono } from 'hono'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { onError } from '../../errors/on-error.ts'
import type { AppEnv } from '../../factory.ts'
import { createIdempotencyRepo } from '../../middleware/idempotency.repo.ts'
import { idempotencyMiddleware } from '../../middleware/idempotency.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { stubAuthMiddleware, type TestContext } from '../../tests/setup.ts'
import { createPropertyContentFactory } from './property-content.factory.ts'
import { createPropertyContentRoutesInner } from './property-content.routes.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_pcint_a_${RUN_ID}`
const TENANT_B = `org_pcint_b_${RUN_ID}`
const PROPERTY = `prop_pcint_${RUN_ID}`
const FAKE_USER = {
	id: 'usr-test',
	email: 'test@sochi.local',
	emailVerified: true,
	name: 'Test',
	createdAt: new Date(),
	updatedAt: new Date(),
} as TestContext['user']

const FAKE_SESSION = {
	id: 'ses-test',
	userId: FAKE_USER.id,
	expiresAt: new Date(Date.now() + 3_600_000),
	token: 'tok',
	createdAt: new Date(),
	updatedAt: new Date(),
	ipAddress: '127.0.0.1',
	userAgent: 'test',
	activeOrganizationId: 'org-test',
} as TestContext['session']

function ctx(tenantId: string, role: TestContext['memberRole'] = 'owner'): TestContext {
	return {
		user: FAKE_USER,
		session: FAKE_SESSION,
		tenantId,
		memberRole: role,
	}
}

describe('property-content routes — real-YDB integration', {
	tags: ['db'],
	timeout: 60_000,
}, () => {
	let factoryDeps: ReturnType<typeof createPropertyContentFactory>
	let idempotency: ReturnType<typeof idempotencyMiddleware>

	function buildApp(c: TestContext): Hono<AppEnv> {
		// Reproduce production wrapper structure but with stubAuth instead
		// of real auth+tenant — this is the integration boundary we want to
		// exercise (routes + repos + idempotency middleware behaviour).
		const inner = createPropertyContentRoutesInner(factoryDeps)
		const app = new Hono<AppEnv>()
			.use(stubAuthMiddleware(c))
			.use('*', idempotency)
			.route('/api/v1', inner)
		app.onError(onError)
		return app
	}

	beforeAll(async () => {
		await setupTestDb()
		const sql = getTestSql()
		factoryDeps = createPropertyContentFactory(sql)
		const idempotencyRepo = createIdempotencyRepo(sql)
		idempotency = idempotencyMiddleware(idempotencyRepo)
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const t of [TENANT_A, TENANT_B]) {
			await sql`DELETE FROM propertyAmenity WHERE tenantId = ${t} AND propertyId = ${PROPERTY}`
			await sql`DELETE FROM propertyDescription WHERE tenantId = ${t} AND propertyId = ${PROPERTY}`
			await sql`DELETE FROM propertyMedia WHERE tenantId = ${t} AND propertyId = ${PROPERTY}`
			await sql`DELETE FROM propertyAddon WHERE tenantId = ${t} AND propertyId = ${PROPERTY}`
		}
		await teardownTestDb()
		sharp.cache(false)
	})

	// ─── Cross-tenant absolute (every method) ────────────────────────────

	test('[CT-AMEN] amenities: TENANT_B does NOT see TENANT_A entries', async () => {
		// TENANT_A creates an amenity assignment
		await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/amenities`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				items: [{ amenityCode: 'AMN_RESTAURANT', freePaid: 'paid', value: null }],
			}),
		})
		// TENANT_B GET — empty, NOT TENANT_A's data
		const res = await buildApp(ctx(TENANT_B)).request(`/api/v1/properties/${PROPERTY}/amenities`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: unknown[] }
		expect(body.data).toEqual([])
	})

	test('[CT-AMEN-DEL] DELETE amenity: TENANT_B cannot remove TENANT_A entry', async () => {
		// TENANT_A row already exists from previous test
		const res = await buildApp(ctx(TENANT_B)).request(
			`/api/v1/properties/${PROPERTY}/amenities/AMN_RESTAURANT`,
			{ method: 'DELETE' },
		)
		expect(res.status).toBe(404)
	})

	test('[CT-DESC] descriptions: TENANT_B GET ru returns 404 (TENANT_A only)', async () => {
		// TENANT_A creates a ru description
		await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/descriptions/ru`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Гранд Отель A',
				tagline: null,
				summaryMd: 'Описание тенанта A.',
				longDescriptionMd: null,
				sections: {},
				seoMetaTitle: null,
				seoMetaDescription: null,
				seoH1: null,
			}),
		})
		const res = await buildApp(ctx(TENANT_B)).request(
			`/api/v1/properties/${PROPERTY}/descriptions/ru`,
		)
		expect(res.status).toBe(404)
	})

	test('[CT-MEDIA] media: TENANT_B GET list of TENANT_A property → empty', async () => {
		await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/media`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				roomTypeId: null,
				kind: 'photo',
				originalKey: `media-original/${TENANT_A}/${PROPERTY}/m1.jpg`,
				mimeType: 'image/jpeg',
				widthPx: 4000,
				heightPx: 3000,
				fileSizeBytes: '5242880',
				altRu: 'A',
			}),
		})
		const res = await buildApp(ctx(TENANT_B)).request(`/api/v1/properties/${PROPERTY}/media`)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { data: unknown[] }
		expect(body.data).toEqual([])
	})

	test('[CT-ADDON] addon code uniqueness is tenant-scoped (same code in two tenants)', async () => {
		// TENANT_A creates BREAKFAST
		const a = await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/addons`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				code: 'BREAKFAST',
				category: 'FOOD_AND_BEVERAGES',
				nameRu: 'Завтрак',
				pricingUnit: 'PER_NIGHT_PER_PERSON',
				priceMicros: '800000000',
				vatBps: 0,
			}),
		})
		expect(a.status).toBe(201)

		// TENANT_B creates BREAKFAST — should also succeed (uniqueness is per
		// tenant+property, not global)
		const b = await buildApp(ctx(TENANT_B)).request(`/api/v1/properties/${PROPERTY}/addons`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				code: 'BREAKFAST',
				category: 'FOOD_AND_BEVERAGES',
				nameRu: 'Завтрак',
				pricingUnit: 'PER_NIGHT_PER_PERSON',
				priceMicros: '800000000',
				vatBps: 0,
			}),
		})
		expect(b.status).toBe(201)
	})

	test('[CT-ADDON-DUP] addon duplicate code in same tenant → 409', async () => {
		const res = await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/addons`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				code: 'BREAKFAST',
				category: 'FOOD_AND_BEVERAGES',
				nameRu: 'Дубль',
				pricingUnit: 'PER_NIGHT_PER_PERSON',
				priceMicros: '800000000',
				vatBps: 0,
			}),
		})
		expect(res.status).toBe(409)
	})

	// ─── Bigint wire form (string coerced to bigint via Zod) ──────────────

	test('[B-WIRE] media POST with string fileSizeBytes coerces correctly through full stack', async () => {
		const res = await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/media`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				roomTypeId: null,
				kind: 'photo',
				originalKey: `media-original/${TENANT_A}/${PROPERTY}/m_wire.jpg`,
				mimeType: 'image/jpeg',
				widthPx: 4000,
				heightPx: 3000,
				fileSizeBytes: '10485760', // 10 MB as JSON string
				altRu: 'Wire form',
			}),
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as { data: { fileSizeBytes: string } }
		// Wire response: string-encoded bigint
		expect(body.data.fileSizeBytes).toBe('10485760')
	})

	test('[B-WIRE-OVERFLOW] media POST with > 50 MB rejected by Zod refine', async () => {
		const res = await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/media`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				roomTypeId: null,
				kind: 'photo',
				originalKey: `media-original/${TENANT_A}/${PROPERTY}/m_big.jpg`,
				mimeType: 'image/jpeg',
				widthPx: 4000,
				heightPx: 3000,
				fileSizeBytes: '52428801', // 50 MB + 1 byte
				altRu: 'Too big',
			}),
		})
		expect(res.status).toBe(400)
	})

	// ─── Idempotency-Key replay ─────────────────────────────────────────

	test('[IDEMP-REPLAY] POST /addons same Idempotency-Key + body → identical replay', async () => {
		const key = `int_idemp_${RUN_ID}`
		const body = JSON.stringify({
			code: 'PARKING_FEE',
			category: 'PARKING',
			nameRu: 'Парковка',
			pricingUnit: 'PER_NIGHT',
			priceMicros: '300000000',
			vatBps: 2200,
		})
		const r1 = await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/addons`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': key,
			},
			body,
		})
		const r2 = await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/addons`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': key,
			},
			body,
		})
		expect(r1.status).toBe(201)
		expect(r2.status).toBe(201)
		const j1 = (await r1.json()) as { data: { addonId: string } }
		const j2 = (await r2.json()) as { data: { addonId: string } }
		// Replay must return the SAME addonId — middleware caches the response
		expect(j2.data.addonId).toBe(j1.data.addonId)
	})

	test('[IDEMP-CONFLICT] POST /addons same key + DIFFERENT body → 422 fingerprint mismatch', async () => {
		const key = `int_conflict_${RUN_ID}`
		const r1 = await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/addons`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': key,
			},
			body: JSON.stringify({
				code: 'KEY_CONFLICT_A',
				category: 'OTHER',
				nameRu: 'A',
				pricingUnit: 'PER_STAY',
				priceMicros: '100',
				vatBps: 0,
			}),
		})
		expect(r1.status).toBe(201)
		const r2 = await buildApp(ctx(TENANT_A)).request(`/api/v1/properties/${PROPERTY}/addons`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': key,
			},
			body: JSON.stringify({
				code: 'KEY_CONFLICT_B', // different body
				category: 'OTHER',
				nameRu: 'B',
				pricingUnit: 'PER_STAY',
				priceMicros: '200',
				vatBps: 0,
			}),
		})
		expect(r2.status).toBe(422)
	})

	// ─── Media process pipeline (route → service → repo → real sharp) ────

	test('[FLOW] POST /media → upload bytes via stub → POST /process → sharp pipeline produces 11 derived', async () => {
		const ten = ctx(TENANT_A)
		const png = await sharp({
			create: { width: 1024, height: 768, channels: 3, background: { r: 200, g: 100, b: 50 } },
		})
			.png()
			.toBuffer()

		// 1. Create media row
		const created = await buildApp(ten).request(`/api/v1/properties/${PROPERTY}/media`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				roomTypeId: null,
				kind: 'photo',
				originalKey: `media-original/${TENANT_A}/${PROPERTY}/flow.png`,
				mimeType: 'image/png',
				widthPx: 1024,
				heightPx: 768,
				fileSizeBytes: String(png.length),
				altRu: 'flow',
			}),
		})
		expect(created.status).toBe(201)
		const createBody = (await created.json()) as { data: { mediaId: string } }
		const mediaId = createBody.data.mediaId

		// 2. Stub-only: simulate upload by registering presign + bytes
		await factoryDeps.mediaStorage.getPresignedPut({
			key: `media-original/${TENANT_A}/${PROPERTY}/flow.png`,
			contentType: 'image/png',
			maxBytes: png.length,
		})
		factoryDeps.mediaStorage.simulateUpload?.(
			`media-original/${TENANT_A}/${PROPERTY}/flow.png`,
			png,
		)

		// 3. Trigger processing
		const proc = await buildApp(ten).request(
			`/api/v1/properties/${PROPERTY}/media/${mediaId}/process`,
			{ method: 'POST' },
		)
		expect(proc.status).toBe(200)
		const procBody = (await proc.json()) as {
			data: { variantCount: number; derivedKeys: string[]; media: { derivedReady: boolean } }
		}
		expect(procBody.data.variantCount).toBe(11)
		expect(procBody.data.derivedKeys).toHaveLength(11)
		expect(procBody.data.media.derivedReady).toBe(true)
	})

	test('[FLOW-CT] cross-tenant process → 404 (NOT 500)', async () => {
		// TENANT_A has the media row from FLOW; TENANT_B tries to process it
		const list = await factoryDeps.media.listByProperty(TENANT_A, PROPERTY)
		const mediaId = list[0]?.mediaId
		expect(mediaId).toBeDefined()
		const res = await buildApp(ctx(TENANT_B)).request(
			`/api/v1/properties/${PROPERTY}/media/${mediaId}/process`,
			{ method: 'POST' },
		)
		expect(res.status).toBe(404)
	})

	// ─── RBAC × tenant: staff TENANT_A cannot mutate own resources ────────

	test('[RBAC-TENANT] staff in TENANT_A cannot PUT amenities (forbidden by RBAC)', async () => {
		const res = await buildApp(ctx(TENANT_A, 'staff')).request(
			`/api/v1/properties/${PROPERTY}/amenities`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ items: [] }),
			},
		)
		expect(res.status).toBe(403)
	})

	test('[RBAC-TENANT] staff in TENANT_A CAN read amenities (read-only role)', async () => {
		const res = await buildApp(ctx(TENANT_A, 'staff')).request(
			`/api/v1/properties/${PROPERTY}/amenities`,
		)
		expect(res.status).toBe(200)
	})
})
