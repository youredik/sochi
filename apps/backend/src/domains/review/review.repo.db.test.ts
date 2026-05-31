/**
 * Channel-review repo — strict integration tests R1-R10 (AI review-reply 2026-05-30).
 *
 * Requires local YDB. Covers:
 *   - create + getById full-field roundtrip (status='new', AI fields null)
 *   - cross-tenant isolation (getById / findByExternal)
 *   - listByProperty ordering (reviewedAt DESC) + property/tenant scoping
 *   - findByExternal by (channelCode, externalId) via secondary index
 *   - saveAi → sentiment/topics/suggestedReply/aiGeneratedAt + status='drafted'
 *   - aiTopicsJson garbage filtered to canonical REVIEW_TOPICS on read
 *   - saveReply (status stays 'drafted') vs markPublished (status='published')
 *   - nullable ratingOverall (int32Opt) roundtrip
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { toJson } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import { createReviewRepo } from './review.repo.ts'
import type { ReviewSeedInput } from './review.types.ts'

const RUN_ID = Date.now().toString(36)
const TENANT_A = `org_rev_a_${RUN_ID}`
const TENANT_B = `org_rev_b_${RUN_ID}`
const PROP_1 = `prop_rev_1_${RUN_ID}`
const PROP_2 = `prop_rev_2_${RUN_ID}`

function seed(overrides: Partial<ReviewSeedInput> = {}): ReviewSeedInput {
	return {
		channelCode: 'ostrovok',
		externalId: `ext_${Math.random().toString(36).slice(2)}`,
		propertyId: PROP_1,
		guestName: 'Гость Тестовый',
		ratingOverall: 5,
		content: 'Отличное место, чисто и тихо.',
		reviewedAt: '2026-05-20T10:00:00.000Z',
		...overrides,
	}
}

describe('channel review repo', () => {
	let repo: ReturnType<typeof createReviewRepo>
	const now = new Date('2026-05-30T12:00:00.000Z')

	beforeAll(async () => {
		await setupTestDb()
		repo = createReviewRepo(getTestSql())
	})

	afterAll(async () => {
		const sql = getTestSql()
		await sql`DELETE FROM channelReview WHERE tenantId = ${TENANT_A}`
		await sql`DELETE FROM channelReview WHERE tenantId = ${TENANT_B}`
		await teardownTestDb()
	})

	test('[R1] create + getById preserves every field exactly; status=new, AI fields null', async () => {
		const input = seed({
			channelCode: 'yandexTravel',
			externalId: `ext_r1_${RUN_ID}`,
			guestName: 'Мария И.',
			ratingOverall: 4,
			content: 'Завтрак вкусный, заселение быстрое.',
			reviewedAt: '2026-05-18T08:30:00.000Z',
		})
		const id = await repo.create(TENANT_A, input, now)
		expect(id).toMatch(/^rev_/)

		const got = await repo.getById(TENANT_A, id)
		expect(got).not.toBeNull()
		expect(got?.id).toBe(id)
		expect(got?.tenantId).toBe(TENANT_A)
		expect(got?.channelCode).toBe('yandexTravel')
		expect(got?.externalId).toBe(`ext_r1_${RUN_ID}`)
		expect(got?.propertyId).toBe(PROP_1)
		expect(got?.guestName).toBe('Мария И.')
		expect(got?.ratingOverall).toBe(4)
		expect(got?.content).toBe('Завтрак вкусный, заселение быстрое.')
		expect(got?.status).toBe('new')
		// AI + reply fields untouched on create
		expect(got?.aiSentiment).toBeNull()
		expect(got?.aiTopics).toBeNull()
		expect(got?.suggestedReply).toBeNull()
		expect(got?.hostReply).toBeNull()
		expect(got?.aiGeneratedAt).toBeNull()
		expect(got?.publishedAt).toBeNull()
		// reviewedAt roundtrips exactly via tsFromIso
		expect(got?.reviewedAt).toBe('2026-05-18T08:30:00.000Z')
		expect(got?.createdAt).toBe(now.toISOString())
		expect(got?.updatedAt).toBe(now.toISOString())
	})

	test('[R2] cross-tenant getById returns null (tenant A row invisible to B)', async () => {
		const id = await repo.create(TENANT_A, seed({ externalId: `ext_r2_${RUN_ID}` }), now)
		expect(await repo.getById(TENANT_B, id)).toBeNull()
		expect(await repo.getById(TENANT_A, id)).not.toBeNull()
	})

	test('[R3] nullable ratingOverall roundtrips as null (int32Opt)', async () => {
		const id = await repo.create(
			TENANT_A,
			seed({ externalId: `ext_r3_${RUN_ID}`, ratingOverall: null }),
			now,
		)
		const got = await repo.getById(TENANT_A, id)
		expect(got?.ratingOverall).toBeNull()
	})

	test('[R4] listByProperty: only this property+tenant, ordered reviewedAt DESC', async () => {
		const older = await repo.create(
			TENANT_A,
			seed({
				externalId: `ext_r4_old_${RUN_ID}`,
				propertyId: PROP_2,
				reviewedAt: '2026-05-01T00:00:00.000Z',
			}),
			now,
		)
		const newer = await repo.create(
			TENANT_A,
			seed({
				externalId: `ext_r4_new_${RUN_ID}`,
				propertyId: PROP_2,
				reviewedAt: '2026-05-25T00:00:00.000Z',
			}),
			now,
		)
		const list = await repo.listByProperty(TENANT_A, PROP_2)
		const ids = list.map((r) => r.id)
		expect(ids).toEqual([newer, older]) // DESC by reviewedAt
		expect(list.every((r) => r.propertyId === PROP_2)).toBe(true)
		// PROP_1 rows excluded
		expect(ids).not.toContain(undefined)
	})

	test('[R5] listByProperty cross-tenant returns empty', async () => {
		await repo.create(TENANT_A, seed({ externalId: `ext_r5_${RUN_ID}`, propertyId: PROP_2 }), now)
		expect(await repo.listByProperty(TENANT_B, PROP_2)).toEqual([])
	})

	test('[R6] findByExternal matches (channelCode, externalId); wrong channel/tenant → null', async () => {
		const ext = `ext_r6_${RUN_ID}`
		const id = await repo.create(
			TENANT_A,
			seed({ channelCode: 'avito', externalId: ext, propertyId: PROP_1 }),
			now,
		)
		const found = await repo.findByExternal(TENANT_A, 'avito', ext)
		expect(found?.id).toBe(id)
		// same externalId, different channel → null (composite key)
		expect(await repo.findByExternal(TENANT_A, 'ostrovok', ext)).toBeNull()
		// cross-tenant → null
		expect(await repo.findByExternal(TENANT_B, 'avito', ext)).toBeNull()
	})

	test('[R7] saveAi sets sentiment/topics/suggestedReply/aiGeneratedAt + status=drafted', async () => {
		const at = new Date('2026-05-30T13:00:00.000Z')
		const id = await repo.create(TENANT_A, seed({ externalId: `ext_r7_${RUN_ID}` }), now)
		await repo.saveAi(
			TENANT_A,
			id,
			{
				sentiment: 'positive',
				topics: ['чистота', 'локация'],
				suggestedReply: 'Спасибо за тёплый отзыв!',
			},
			at,
		)
		const got = await repo.getById(TENANT_A, id)
		expect(got?.status).toBe('drafted')
		expect(got?.aiSentiment).toBe('positive')
		expect(got?.aiTopics).toEqual(['чистота', 'локация'])
		expect(got?.suggestedReply).toBe('Спасибо за тёплый отзыв!')
		expect(got?.aiGeneratedAt).toBe(at.toISOString())
		expect(got?.updatedAt).toBe(at.toISOString())
		// host reply not touched by AI step
		expect(got?.hostReply).toBeNull()
		expect(got?.publishedAt).toBeNull()
	})

	test('[R8] aiTopicsJson garbage filtered to canonical REVIEW_TOPICS on read', async () => {
		const sql = getTestSql()
		const id = await repo.create(TENANT_A, seed({ externalId: `ext_r8_${RUN_ID}` }), now)
		// Inject a topics array mixing valid + invalid values directly (Json-typed).
		await sql`
			UPDATE channelReview SET aiTopicsJson = ${toJson(['чистота', 'НЕ_ТЕМА', 42, 'шум'])}
			WHERE tenantId = ${TENANT_A} AND id = ${id}
		`
		const got = await repo.getById(TENANT_A, id)
		expect(got?.aiTopics).toEqual(['чистота', 'шум']) // garbage dropped
	})

	test('[R9] saveReply sets hostReply, keeps status=drafted (not published)', async () => {
		const at = new Date('2026-05-30T14:00:00.000Z')
		const id = await repo.create(TENANT_A, seed({ externalId: `ext_r9_${RUN_ID}` }), now)
		await repo.saveReply(TENANT_A, id, 'Спасибо! Будем рады видеть снова.', at)
		const got = await repo.getById(TENANT_A, id)
		expect(got?.hostReply).toBe('Спасибо! Будем рады видеть снова.')
		expect(got?.status).toBe('drafted')
		expect(got?.publishedAt).toBeNull()
		expect(got?.updatedAt).toBe(at.toISOString())
	})

	test('[R10] markPublished sets hostReply + status=published + publishedAt', async () => {
		const at = new Date('2026-05-30T15:00:00.000Z')
		const id = await repo.create(TENANT_A, seed({ externalId: `ext_r10_${RUN_ID}` }), now)
		await repo.markPublished(TENANT_A, id, 'Благодарим за отзыв!', at)
		const got = await repo.getById(TENANT_A, id)
		expect(got?.status).toBe('published')
		expect(got?.hostReply).toBe('Благодарим за отзыв!')
		expect(got?.publishedAt).toBe(at.toISOString())
		expect(got?.updatedAt).toBe(at.toISOString())
	})
})
