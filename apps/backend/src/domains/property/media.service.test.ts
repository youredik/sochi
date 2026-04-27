/**
 * Property media service — orchestration tests.
 *
 * Covers the M8.A.0.fix.3 + fix.4 surface:
 *   - `uploadAndProcess` ties storage Stub + sharp + repo: 11 derived files
 *     land in storage; flags flipped; row roundtrips.
 *   - `finalizeUploaded` is the prod path (assumes bytes already landed
 *     via separate PUT) — must throw without bytes.
 *   - `setHeroExclusiveSafe` enforces `checkHeroAltText` invariant
 *     (M8.A.0.4 hero altRu gap closed at SERVICE layer).
 *
 * Per `feedback_strict_tests.md`:
 *   - Adversarial: bytes > declared fileSizeBytes rejected before any DB
 *     write or sharp work.
 *   - Cross-tenant: pipeline scoped per tenant.
 *   - Idempotency: re-call upload-and-process on same mediaId works.
 */
import type { PropertyMediaCreateInput } from '@horeca/shared'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createMediaRepo } from './media.repo.ts'
import { finalizeUploaded, setHeroExclusiveSafe, uploadAndProcess } from './media.service.ts'
import { createStubMediaStorage, type MediaStorage } from './media-storage.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_msvc_a_${RUN_ID}`
const TENANT_B = `org_msvc_b_${RUN_ID}`
const PROPERTY = `prop_msvc_${RUN_ID}`
const ACTOR = 'usr_test'

async function makePng(w = 2000, h = 1500): Promise<Buffer> {
	return sharp({
		create: {
			width: w,
			height: h,
			channels: 3,
			background: { r: 30, g: 100, b: 200 },
		},
	})
		.png()
		.toBuffer()
}

function makeMeta(overrides: Partial<PropertyMediaCreateInput> = {}): PropertyMediaCreateInput {
	return {
		roomTypeId: null,
		kind: 'photo',
		originalKey: `media-original/${TENANT_A}/${PROPERTY}/m1.png`,
		mimeType: 'image/png',
		widthPx: 2000,
		heightPx: 1500,
		fileSizeBytes: 50n * 1024n * 1024n,
		altRu: 'Открытый бассейн',
		...overrides,
	}
}

describe('media.service', { tags: ['db'], timeout: 30_000 }, () => {
	let storage: MediaStorage
	let repo: ReturnType<typeof createMediaRepo>
	const created: Array<{ tenantId: string; propertyId: string; mediaId: string }> = []

	beforeAll(async () => {
		await setupTestDb()
		storage = createStubMediaStorage()
		repo = createMediaRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		for (const c of created) {
			await sql`DELETE FROM propertyMedia WHERE tenantId = ${c.tenantId} AND propertyId = ${c.propertyId} AND mediaId = ${c.mediaId}`
		}
		await teardownTestDb()
		sharp.cache(false)
	})

	test('[U1] uploadAndProcess: 11 derived files land + flags flipped + row roundtrips', async () => {
		const mediaId = `med_u1_${RUN_ID}`
		const bytes = await makePng()
		const out = await uploadAndProcess(
			{ repo, storage },
			{
				tenantId: TENANT_A,
				propertyId: PROPERTY,
				mediaId,
				actorId: ACTOR,
				meta: makeMeta({ originalKey: `media-original/${TENANT_A}/${PROPERTY}/u1.png` }),
				originalBytes: bytes,
			},
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY, mediaId })

		expect(out.variantCount).toBe(11)
		expect(out.derivedKeys).toHaveLength(11)
		expect(out.media.derivedReady).toBe(true)
		expect(out.media.exifStripped).toBe(true)

		// Verify storage actually has bytes for every derived key
		const snap = storage.debugDerivedSnapshot?.()
		expect(snap).toBeDefined()
		for (const k of out.derivedKeys) {
			expect(snap?.has(k)).toBe(true)
			expect(snap?.get(k)).toBeGreaterThan(0)
		}
	})

	test('[U2] uploadAndProcess: bytes exceeding declared fileSizeBytes rejected BEFORE any DB write', async () => {
		const mediaId = `med_u2_${RUN_ID}`
		const bytes = await makePng()
		await expect(
			uploadAndProcess(
				{ repo, storage },
				{
					tenantId: TENANT_A,
					propertyId: PROPERTY,
					mediaId,
					actorId: ACTOR,
					meta: makeMeta({
						originalKey: `media-original/${TENANT_A}/${PROPERTY}/u2.png`,
						fileSizeBytes: BigInt(bytes.length - 1), // declared size LESS than actual
					}),
					originalBytes: bytes,
				},
			),
		).rejects.toThrowError(/exceeds declared fileSizeBytes/)
		// No row created
		expect(await repo.getById(TENANT_A, PROPERTY, mediaId)).toBeNull()
	})

	test('[U3] uploadAndProcess idempotent: re-call same mediaId overwrites variants, row stays', async () => {
		const mediaId = `med_u3_${RUN_ID}`
		const bytes = await makePng()
		const meta = makeMeta({
			originalKey: `media-original/${TENANT_A}/${PROPERTY}/u3.png`,
		})
		await uploadAndProcess(
			{ repo, storage },
			{
				tenantId: TENANT_A,
				propertyId: PROPERTY,
				mediaId,
				actorId: ACTOR,
				meta,
				originalBytes: bytes,
			},
		)
		// Re-call
		const out = await uploadAndProcess(
			{ repo, storage },
			{
				tenantId: TENANT_A,
				propertyId: PROPERTY,
				mediaId,
				actorId: ACTOR,
				meta,
				originalBytes: bytes,
			},
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY, mediaId })
		expect(out.variantCount).toBe(11)
		// Single row, not duplicated
		const list = await repo.listByProperty(TENANT_A, PROPERTY)
		const matches = list.filter((m) => m.mediaId === mediaId)
		expect(matches).toHaveLength(1)
	})

	test('[F1] finalizeUploaded: throws when no bytes registered for key', async () => {
		const mediaId = `med_f1_${RUN_ID}`
		const meta = makeMeta({
			originalKey: `media-original/${TENANT_A}/${PROPERTY}/f1.png`,
		})
		// Pre-create row, but DON'T seed storage
		await repo.create(TENANT_A, PROPERTY, mediaId, meta, ACTOR)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY, mediaId })

		await expect(
			finalizeUploaded(
				{ repo, storage },
				{
					tenantId: TENANT_A,
					propertyId: PROPERTY,
					mediaId,
					actorId: ACTOR,
					originalKey: meta.originalKey,
					mimeType: meta.mimeType,
				},
			),
		).rejects.toThrowError(/no original bytes/)
	})

	test('[CT1] cross-tenant: TENANT_B cannot finalize TENANT_A media', async () => {
		const mediaId = `med_ct1_${RUN_ID}`
		const bytes = await makePng()
		await uploadAndProcess(
			{ repo, storage },
			{
				tenantId: TENANT_A,
				propertyId: PROPERTY,
				mediaId,
				actorId: ACTOR,
				meta: makeMeta({ originalKey: `media-original/${TENANT_A}/${PROPERTY}/ct1.png` }),
				originalBytes: bytes,
			},
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY, mediaId })

		// Attempt to finalize as TENANT_B → markProcessed returns false (row
		// not visible in TENANT_B scope) → service throws.
		await expect(
			finalizeUploaded(
				{ repo, storage },
				{
					tenantId: TENANT_B,
					propertyId: PROPERTY,
					mediaId,
					actorId: ACTOR,
					originalKey: `media-original/${TENANT_A}/${PROPERTY}/ct1.png`,
					mimeType: 'image/png',
				},
			),
		).rejects.toThrowError(/not found at flip-flags time/)
	})

	test('[H1] setHeroExclusiveSafe: rejects empty altRu (M8.A.0.4 hero invariant)', async () => {
		const mediaId = `med_h1_${RUN_ID}`
		const bytes = await makePng()
		await uploadAndProcess(
			{ repo, storage },
			{
				tenantId: TENANT_A,
				propertyId: PROPERTY,
				mediaId,
				actorId: ACTOR,
				meta: makeMeta({
					originalKey: `media-original/${TENANT_A}/${PROPERTY}/h1.png`,
					altRu: '   ', // whitespace-only — equivalent to empty
				}),
				originalBytes: bytes,
			},
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY, mediaId })

		await expect(
			setHeroExclusiveSafe(
				{ repo, storage },
				{ tenantId: TENANT_A, propertyId: PROPERTY, mediaId, actorId: ACTOR },
			),
		).rejects.toThrowError(/non-empty altRu/)
		// Row remains, but isHero stays false
		const r = await repo.getById(TENANT_A, PROPERTY, mediaId)
		expect(r?.isHero).toBe(false)
	})

	test('[H2] setHeroExclusiveSafe: succeeds with non-empty altRu + demotes other heroes', async () => {
		const heroId = `med_h2_a_${RUN_ID}`
		const otherId = `med_h2_b_${RUN_ID}`
		const bytes = await makePng()
		// Create + promote first
		await uploadAndProcess(
			{ repo, storage },
			{
				tenantId: TENANT_A,
				propertyId: PROPERTY,
				mediaId: heroId,
				actorId: ACTOR,
				meta: makeMeta({ originalKey: `media-original/${TENANT_A}/${PROPERTY}/h2a.png` }),
				originalBytes: bytes,
			},
		)
		await uploadAndProcess(
			{ repo, storage },
			{
				tenantId: TENANT_A,
				propertyId: PROPERTY,
				mediaId: otherId,
				actorId: ACTOR,
				meta: makeMeta({ originalKey: `media-original/${TENANT_A}/${PROPERTY}/h2b.png` }),
				originalBytes: bytes,
			},
		)
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY, mediaId: heroId })
		created.push({ tenantId: TENANT_A, propertyId: PROPERTY, mediaId: otherId })

		await setHeroExclusiveSafe(
			{ repo, storage },
			{ tenantId: TENANT_A, propertyId: PROPERTY, mediaId: heroId, actorId: ACTOR },
		)
		await setHeroExclusiveSafe(
			{ repo, storage },
			{ tenantId: TENANT_A, propertyId: PROPERTY, mediaId: otherId, actorId: ACTOR },
		)
		// Promotion of `other` demotes `hero`
		expect((await repo.getById(TENANT_A, PROPERTY, heroId))?.isHero).toBe(false)
		expect((await repo.getById(TENANT_A, PROPERTY, otherId))?.isHero).toBe(true)
	})

	test('[H3] setHeroExclusiveSafe: throws on unknown mediaId', async () => {
		await expect(
			setHeroExclusiveSafe(
				{ repo, storage },
				{
					tenantId: TENANT_A,
					propertyId: PROPERTY,
					mediaId: 'med_does_not_exist',
					actorId: ACTOR,
				},
			),
		).rejects.toThrowError(/media not found/)
	})
})
