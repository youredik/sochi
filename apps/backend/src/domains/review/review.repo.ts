import { newId } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import {
	int32Opt,
	NULL_TIMESTAMP,
	textOpt,
	timestampOpt,
	toJson,
	toNumber,
	toTs,
	tsFromIso,
} from '../../db/ydb-helpers.ts'
import { REVIEW_TOPICS } from '../../lib/ai/review-reply.ts'
import type {
	ChannelReview,
	ReviewSeedInput,
	ReviewSentiment,
	ReviewStatus,
	ReviewTopic,
} from './review.types.ts'

type SqlInstance = typeof SQL

type ChannelReviewRow = {
	tenantId: string
	id: string
	channelCode: string
	externalId: string
	propertyId: string
	guestName: string
	ratingOverall: number | bigint | null
	content: string
	aiSentiment: string | null
	// YDB driver may return a Json column either as a raw string OR already parsed
	// (array/object), depending on result codec — see payment-webhook-event.repo.ts.
	aiTopicsJson: unknown
	suggestedReply: string | null
	hostReply: string | null
	status: string
	reviewedAt: Date
	aiGeneratedAt: Date | null
	publishedAt: Date | null
	createdAt: Date
	updatedAt: Date
}

/**
 * Парсит nullable Json-колонку тем к каноническому списку (мусор отфильтрован).
 * Драйвер @ydbjs может вернуть Json как строку ИЛИ уже распарсенным значением —
 * обрабатываем оба (как payment-webhook-event.repo.ts).
 */
function parseTopics(json: unknown): ReviewTopic[] | null {
	if (json === null || json === undefined) return null
	let arr: unknown
	if (typeof json === 'string') {
		try {
			arr = JSON.parse(json)
		} catch {
			return null
		}
	} else {
		arr = json
	}
	if (!Array.isArray(arr)) return null
	return arr.filter(
		(t): t is ReviewTopic =>
			typeof t === 'string' && (REVIEW_TOPICS as readonly string[]).includes(t),
	)
}

function rowToReview(r: ChannelReviewRow): ChannelReview {
	const sentiment =
		r.aiSentiment === 'positive' || r.aiSentiment === 'negative' || r.aiSentiment === 'mixed'
			? (r.aiSentiment as ReviewSentiment)
			: null
	return {
		id: r.id,
		tenantId: r.tenantId,
		channelCode: r.channelCode,
		externalId: r.externalId,
		propertyId: r.propertyId,
		guestName: r.guestName,
		ratingOverall: toNumber(r.ratingOverall),
		content: r.content,
		aiSentiment: sentiment,
		aiTopics: parseTopics(r.aiTopicsJson),
		suggestedReply: r.suggestedReply,
		hostReply: r.hostReply,
		status: r.status as ReviewStatus,
		reviewedAt: r.reviewedAt.toISOString(),
		aiGeneratedAt: r.aiGeneratedAt?.toISOString() ?? null,
		publishedAt: r.publishedAt?.toISOString() ?? null,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
	}
}

/**
 * Channel-review repo. Tenant-scoped — every query `WHERE tenantId = ?`.
 * Reads = snapshotReadOnly + idempotent (canon). Writes = per-row UPSERT /
 * targeted UPDATE. Mirrors `property-block.repo.ts` style.
 */
export function createReviewRepo(sql: SqlInstance) {
	return {
		async listByProperty(tenantId: string, propertyId: string): Promise<ChannelReview[]> {
			const [rows = []] = await sql<ChannelReviewRow[]>`
				SELECT * FROM channelReview
				WHERE tenantId = ${tenantId} AND propertyId = ${propertyId}
				ORDER BY reviewedAt DESC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToReview)
		},

		async getById(tenantId: string, id: string): Promise<ChannelReview | null> {
			const [rows = []] = await sql<ChannelReviewRow[]>`
				SELECT * FROM channelReview WHERE tenantId = ${tenantId} AND id = ${id} LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToReview(row) : null
		},

		/** Idempotent ingest: same (channelCode, externalId) → existing row, no duplicate. */
		async findByExternal(
			tenantId: string,
			channelCode: string,
			externalId: string,
		): Promise<ChannelReview | null> {
			const [rows = []] = await sql<ChannelReviewRow[]>`
				SELECT * FROM channelReview VIEW idxChannelReviewExternal
				WHERE tenantId = ${tenantId} AND channelCode = ${channelCode} AND externalId = ${externalId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToReview(row) : null
		},

		/** Создаёт отзыв в статусе 'new'. Возвращает id. Used by ingest / demo seed. */
		async create(tenantId: string, input: ReviewSeedInput, now: Date): Promise<string> {
			const id = newId('channelReview')
			await sql`
				UPSERT INTO channelReview (
					tenantId, id, channelCode, externalId, propertyId, guestName, ratingOverall,
					content, aiSentiment, aiTopicsJson, suggestedReply, hostReply, status,
					reviewedAt, aiGeneratedAt, publishedAt, createdAt, updatedAt
				) VALUES (
					${tenantId}, ${id}, ${input.channelCode}, ${input.externalId}, ${input.propertyId},
					${input.guestName}, ${int32Opt(input.ratingOverall)}, ${input.content},
					${textOpt(null)}, ${toJson(null)}, ${textOpt(null)}, ${textOpt(null)}, ${'new'},
					${tsFromIso(input.reviewedAt)}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${toTs(now)}, ${toTs(now)}
				)
			`.idempotent(true)
			return id
		},

		/** Сохраняет ИИ-разметку + черновик; статус → 'drafted'. */
		async saveAi(
			tenantId: string,
			id: string,
			ai: { sentiment: ReviewSentiment; topics: readonly ReviewTopic[]; suggestedReply: string },
			now: Date,
		): Promise<void> {
			await sql`
				UPDATE channelReview SET
					aiSentiment = ${textOpt(ai.sentiment)},
					aiTopicsJson = ${toJson(ai.topics)},
					suggestedReply = ${textOpt(ai.suggestedReply)},
					aiGeneratedAt = ${timestampOpt(now)},
					status = ${'drafted'},
					updatedAt = ${toTs(now)}
				WHERE tenantId = ${tenantId} AND id = ${id}
			`.idempotent(true)
		},

		/** Сохраняет правки хозяина (без публикации); статус остаётся 'drafted'. */
		async saveReply(tenantId: string, id: string, hostReply: string, now: Date): Promise<void> {
			await sql`
				UPDATE channelReview SET
					hostReply = ${textOpt(hostReply)}, status = ${'drafted'}, updatedAt = ${toTs(now)}
				WHERE tenantId = ${tenantId} AND id = ${id}
			`.idempotent(true)
		},

		/** Публикует ответ: hostReply + status='published' + publishedAt. */
		async markPublished(tenantId: string, id: string, hostReply: string, now: Date): Promise<void> {
			await sql`
				UPDATE channelReview SET
					hostReply = ${textOpt(hostReply)}, status = ${'published'},
					publishedAt = ${timestampOpt(now)}, updatedAt = ${toTs(now)}
				WHERE tenantId = ${tenantId} AND id = ${id}
			`.idempotent(true)
		},
	}
}

export type ReviewRepo = ReturnType<typeof createReviewRepo>
