/**
 * Review service — strict unit tests S1-S13 (AI review-reply 2026-05-30).
 *
 * Pure DI: in-memory fake repo + fake publisher + mock Yandex AI (via fetchImpl).
 * No network, no DB. Asserts business rules: idempotent ingest, AI draft happy +
 * failure paths, reply validation, publish ordering (save → publish → mark) and
 * that a rejected channel leaves status unchanged (no markPublished).
 */

import { describe, expect, test } from 'bun:test'
import type { YandexAiStudioConfig } from '../../lib/ai/yandex-ai-studio.ts'
import { createReviewService } from './review.service.ts'
import { DEMO_REVIEWS } from './review.demo-seed.ts'
import type { ReviewRepo } from './review.repo.ts'
import type {
	ReviewPublisher,
	ReviewPublishInput,
	ReviewPublishResult,
} from './review.publisher.ts'
import type { ChannelReview, ReviewSeedInput } from './review.types.ts'

const TENANT = 'org_svc_test'
const NOW = new Date('2026-05-30T12:00:00.000Z')
const OK_COMPLETION =
	'{"sentiment":"positive","topics":["чистота","локация"],"reply":"Спасибо за тёплый отзыв! Будем рады видеть вас снова."}'

function mockAi(completionText: string): YandexAiStudioConfig {
	const fetchImpl = (async () =>
		new Response(
			JSON.stringify({
				result: {
					alternatives: [{ message: { text: completionText } }],
					usage: { inputTextTokens: '100', completionTokens: '60' },
				},
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)) as unknown as typeof fetch
	return { apiKey: 'test-key', folderId: 'test-folder', model: 'yandexgpt/latest', fetchImpl }
}

const NOT_CONFIGURED: YandexAiStudioConfig = {
	apiKey: undefined,
	folderId: undefined,
	model: 'yandexgpt/latest',
}

function seedInput(overrides: Partial<ReviewSeedInput> = {}): ReviewSeedInput {
	return {
		channelCode: 'ostrovok',
		externalId: 'ext-1',
		propertyId: 'prop_1',
		guestName: 'Гость',
		ratingOverall: 5,
		content: 'Очень понравилось, чисто и близко к морю.',
		reviewedAt: '2026-05-20T10:00:00.000Z',
		...overrides,
	}
}

function makeFakeRepo() {
	const store = new Map<string, ChannelReview>()
	const calls = { create: 0, saveAi: 0, saveReply: 0, markPublished: 0 }
	let seq = 0
	const repo: ReviewRepo = {
		async listByProperty(tenantId, propertyId) {
			return [...store.values()]
				.filter((r) => r.tenantId === tenantId && r.propertyId === propertyId)
				.sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))
		},
		async getById(tenantId, id) {
			const r = store.get(id)
			if (!r || r.tenantId !== tenantId) return null
			return r
		},
		async findByExternal(tenantId, channelCode, externalId) {
			return (
				[...store.values()].find(
					(r) =>
						r.tenantId === tenantId && r.channelCode === channelCode && r.externalId === externalId,
				) ?? null
			)
		},
		async create(tenantId, input, now) {
			calls.create++
			const id = `rev_fake_${seq++}`
			const iso = now.toISOString()
			store.set(id, {
				id,
				tenantId,
				channelCode: input.channelCode,
				externalId: input.externalId,
				propertyId: input.propertyId,
				guestName: input.guestName,
				ratingOverall: input.ratingOverall,
				content: input.content,
				aiSentiment: null,
				aiTopics: null,
				suggestedReply: null,
				hostReply: null,
				status: 'new',
				reviewedAt: input.reviewedAt,
				aiGeneratedAt: null,
				publishedAt: null,
				createdAt: iso,
				updatedAt: iso,
			})
			return id
		},
		async saveAi(_tenantId, id, ai, now) {
			calls.saveAi++
			const r = store.get(id)
			if (!r) return
			store.set(id, {
				...r,
				aiSentiment: ai.sentiment,
				aiTopics: [...ai.topics],
				suggestedReply: ai.suggestedReply,
				aiGeneratedAt: now.toISOString(),
				status: 'drafted',
				updatedAt: now.toISOString(),
			})
		},
		async saveReply(_tenantId, id, hostReply, now) {
			calls.saveReply++
			const r = store.get(id)
			if (!r) return
			store.set(id, { ...r, hostReply, status: 'drafted', updatedAt: now.toISOString() })
		},
		async markPublished(_tenantId, id, hostReply, now) {
			calls.markPublished++
			const r = store.get(id)
			if (!r) return
			store.set(id, {
				...r,
				hostReply,
				status: 'published',
				publishedAt: now.toISOString(),
				updatedAt: now.toISOString(),
			})
		},
	}
	return { repo, store, calls }
}

function makeFakePublisher(result: ReviewPublishResult = { ok: true }) {
	const calls: ReviewPublishInput[] = []
	const publisher: ReviewPublisher = {
		async publish(input) {
			calls.push(input)
			return result
		},
	}
	return { publisher, calls }
}

function setup(
	opts: {
		ai?: YandexAiStudioConfig
		publish?: ReviewPublishResult
		propertyName?: string | null
		isDemo?: boolean
	} = {},
) {
	const fakeRepo = makeFakeRepo()
	const fakePub = makeFakePublisher(opts.publish)
	const service = createReviewService({
		reviewRepo: fakeRepo.repo,
		publisher: fakePub.publisher,
		aiConfig: opts.ai ?? mockAi(OK_COMPLETION),
		resolvePropertyName: async () =>
			opts.propertyName === undefined ? 'Гостевой дом «Сириус»' : opts.propertyName,
		now: () => NOW,
		...(opts.isDemo === undefined ? {} : { isDemoTenant: async () => opts.isDemo === true }),
	})
	return { service, store: fakeRepo.store, repoCalls: fakeRepo.calls, pubCalls: fakePub.calls }
}

describe('review service — list / get', () => {
	test('[S1] list returns repo rows for property, newest first', async () => {
		const { service } = setup()
		await service.ingest(
			TENANT,
			seedInput({ externalId: 'a', reviewedAt: '2026-05-01T00:00:00.000Z' }),
		)
		await service.ingest(
			TENANT,
			seedInput({ externalId: 'b', reviewedAt: '2026-05-10T00:00:00.000Z' }),
		)
		const list = await service.list(TENANT, 'prop_1')
		expect(list.map((r) => r.externalId)).toEqual(['b', 'a'])
	})

	test('[S2] get throws ReviewNotFoundError (code) for unknown id', async () => {
		const { service } = setup()
		await expect(service.get(TENANT, 'rev_missing')).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
	})

	test('[S14] provisionDemoReviews: demo + empty → seeds canonical set under property', async () => {
		const { service, store } = setup({ isDemo: true })
		const result = await service.provisionDemoReviews(TENANT, 'prop_demo')
		expect(result.provisioned).toBe(DEMO_REVIEWS.length)
		const list = await service.list(TENANT, 'prop_demo')
		expect(list).toHaveLength(DEMO_REVIEWS.length)
		expect(list.every((r) => r.status === 'new')).toBe(true)
		expect(list.every((r) => r.propertyId === 'prop_demo')).toBe(true)
		expect(list.some((r) => r.ratingOverall === 2)).toBe(true) // 5★→2★ spread present
		expect(store.size).toBe(DEMO_REVIEWS.length)
	})

	test('[S15] provisionDemoReviews: idempotent — already has reviews → no-op', async () => {
		const { service, repoCalls } = setup({ isDemo: true })
		await service.ingest(TENANT, seedInput({ externalId: 'existing' }))
		const createsBefore = repoCalls.create
		expect((await service.provisionDemoReviews(TENANT, 'prop_1')).provisioned).toBe(0)
		expect(repoCalls.create).toBe(createsBefore)
	})

	test('[S16] provisionDemoReviews: non-demo tenant → no-op (no seed)', async () => {
		const { service, repoCalls } = setup({ isDemo: false })
		expect((await service.provisionDemoReviews(TENANT, 'prop_1')).provisioned).toBe(0)
		expect(repoCalls.create).toBe(0)
	})

	test('[S17] provisionDemoReviews: isDemoTenant resolver absent → no-op', async () => {
		const { service, repoCalls } = setup()
		expect((await service.provisionDemoReviews(TENANT, 'prop_1')).provisioned).toBe(0)
		expect(repoCalls.create).toBe(0)
	})

	test('[S18] list is a pure read — demo+empty does NOT seed (write moved to provision)', async () => {
		const { service, repoCalls } = setup({ isDemo: true })
		expect(await service.list(TENANT, 'prop_1')).toEqual([])
		expect(repoCalls.create).toBe(0)
	})
})

describe('review service — ingest idempotency', () => {
	test('[S3] ingest new → creates row', async () => {
		const { service, repoCalls } = setup()
		const r = await service.ingest(TENANT, seedInput({ externalId: 'new-1' }))
		expect(r.status).toBe('new')
		expect(repoCalls.create).toBe(1)
	})

	test('[S4] ingest same (channel, externalId) twice → no duplicate, no 2nd create', async () => {
		const { service, repoCalls } = setup()
		const first = await service.ingest(TENANT, seedInput({ externalId: 'dup' }))
		const second = await service.ingest(
			TENANT,
			seedInput({ externalId: 'dup', guestName: 'Другой' }),
		)
		expect(second.id).toBe(first.id)
		expect(second.guestName).toBe('Гость') // original kept, not overwritten
		expect(repoCalls.create).toBe(1)
	})
})

describe('review service — generateReply (AI)', () => {
	test('[S5] ok: persists AI markup + draft, returns drafted review', async () => {
		const { service, store, repoCalls } = setup({ ai: mockAi(OK_COMPLETION) })
		const r = await service.ingest(TENANT, seedInput({ externalId: 'g1' }))
		const out = await service.generateReply(TENANT, r.id)
		expect(out.status).toBe('drafted')
		expect(out.aiSentiment).toBe('positive')
		expect(out.aiTopics).toEqual(['чистота', 'локация'])
		expect(out.suggestedReply).toContain('Спасибо')
		expect(out.aiGeneratedAt).toBe(NOW.toISOString())
		expect(repoCalls.saveAi).toBe(1)
		// persisted to repo, not just returned in-memory
		expect(store.get(r.id)?.status).toBe('drafted')
		expect(store.get(r.id)?.suggestedReply).toContain('Спасибо')
	})

	test('[S6] AI not_configured → ReviewAiUnavailableError, no saveAi', async () => {
		const { service, repoCalls } = setup({ ai: NOT_CONFIGURED })
		const r = await service.ingest(TENANT, seedInput({ externalId: 'g2' }))
		await expect(service.generateReply(TENANT, r.id)).rejects.toMatchObject({
			code: 'REVIEW_AI_UNAVAILABLE',
		})
		expect(repoCalls.saveAi).toBe(0)
	})

	test('[S7] AI unparseable output → ReviewAiUnavailableError, no saveAi', async () => {
		const { service, repoCalls } = setup({ ai: mockAi('просто текст без json') })
		const r = await service.ingest(TENANT, seedInput({ externalId: 'g3' }))
		await expect(service.generateReply(TENANT, r.id)).rejects.toMatchObject({
			code: 'REVIEW_AI_UNAVAILABLE',
		})
		expect(repoCalls.saveAi).toBe(0)
	})

	test('[S8] generateReply on unknown id → ReviewNotFoundError before AI call', async () => {
		const { service, repoCalls } = setup()
		await expect(service.generateReply(TENANT, 'rev_nope')).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
		expect(repoCalls.saveAi).toBe(0)
	})
})

describe('review service — saveDraft', () => {
	test('[S9] saveDraft persists host reply, status drafted', async () => {
		const { service, store, repoCalls } = setup()
		const r = await service.ingest(TENANT, seedInput({ externalId: 'd1' }))
		const out = await service.saveDraft(TENANT, r.id, '  Спасибо за отзыв!  ')
		expect(out.hostReply).toBe('Спасибо за отзыв!') // trimmed
		expect(out.status).toBe('drafted')
		expect(store.get(r.id)?.hostReply).toBe('Спасибо за отзыв!')
		expect(repoCalls.saveReply).toBe(1)
	})

	test('[S10] saveDraft empty/whitespace → ReviewReplyRequiredError, no write', async () => {
		const { service, repoCalls } = setup()
		const r = await service.ingest(TENANT, seedInput({ externalId: 'd2' }))
		await expect(service.saveDraft(TENANT, r.id, '   ')).rejects.toMatchObject({
			code: 'REVIEW_REPLY_REQUIRED',
		})
		expect(repoCalls.saveReply).toBe(0)
	})
})

describe('review service — publish', () => {
	test('[S11] publish ok: save → publish → markPublished, status published', async () => {
		const { service, store, repoCalls, pubCalls } = setup({ publish: { ok: true } })
		const r = await service.ingest(TENANT, seedInput({ externalId: 'p1' }))
		const out = await service.publish(TENANT, r.id, 'Благодарим за отзыв!')
		expect(out.status).toBe('published')
		expect(out.hostReply).toBe('Благодарим за отзыв!')
		expect(out.publishedAt).toBe(NOW.toISOString())
		expect(pubCalls).toHaveLength(1)
		expect(pubCalls[0]?.channelCode).toBe('ostrovok')
		expect(pubCalls[0]?.reply).toBe('Благодарим за отзыв!')
		expect(repoCalls.markPublished).toBe(1)
		expect(store.get(r.id)?.status).toBe('published')
	})

	test('[S12] publish channel-rejected → ReviewPublishFailedError, status NOT published', async () => {
		const { service, store, repoCalls } = setup({
			publish: { ok: false, reason: 'channel 503' },
		})
		const r = await service.ingest(TENANT, seedInput({ externalId: 'p2' }))
		await expect(service.publish(TENANT, r.id, 'Ответ хозяина')).rejects.toMatchObject({
			code: 'REVIEW_PUBLISH_FAILED',
		})
		expect(repoCalls.markPublished).toBe(0)
		// reply was saved (not lost) but status stays drafted, not published
		expect(store.get(r.id)?.status).toBe('drafted')
		expect(store.get(r.id)?.hostReply).toBe('Ответ хозяина')
		expect(store.get(r.id)?.publishedAt).toBeNull()
	})

	test('[S13] publish empty reply → ReviewReplyRequiredError before any write', async () => {
		const { service, repoCalls, pubCalls } = setup()
		const r = await service.ingest(TENANT, seedInput({ externalId: 'p3' }))
		await expect(service.publish(TENANT, r.id, '   ')).rejects.toMatchObject({
			code: 'REVIEW_REPLY_REQUIRED',
		})
		expect(repoCalls.saveReply).toBe(0)
		expect(pubCalls).toHaveLength(0)
	})
})
