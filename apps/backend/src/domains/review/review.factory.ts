import type { sql as SQL } from '../../db/index.ts'
import { readConfigFromEnv, type YandexAiStudioConfig } from '../../lib/ai/yandex-ai-studio.ts'
import { createReviewRepo } from './review.repo.ts'
import { createMockReviewPublisher, type ReviewPublisher } from './review.publisher.ts'
import { createReviewService } from './review.service.ts'

type SqlInstance = typeof SQL

/**
 * DI-проводка домена отзывов: sql → repo → service. AI-конфиг по умолчанию из
 * env (Yandex AI Studio); publisher по умолчанию Mock (до реальных channel
 * review-reply API). Оба переопределяемы через `opts` — для тестов / будущих
 * реальных издателей без касания app.ts.
 */
export function createReviewFactory(
	sql: SqlInstance,
	resolvePropertyName: (tenantId: string, propertyId: string) => Promise<string | null>,
	opts?: { aiConfig?: YandexAiStudioConfig; publisher?: ReviewPublisher },
) {
	const repo = createReviewRepo(sql)
	// Demo-режим org (organizationProfile.mode='demo') — для ленивого demo-сида
	// отзывов в service.list. Зеркалит чтение mode в lib/tenant-resolver.ts.
	const isDemoTenant = async (tenantId: string): Promise<boolean> => {
		const [rows = []] = await sql<{ mode: string | null }[]>`
			SELECT p.mode AS mode FROM organizationProfile AS p
			WHERE p.organizationId = ${tenantId} LIMIT 1
		`
			.isolation('snapshotReadOnly')
			.idempotent(true)
		return rows[0]?.mode === 'demo'
	}
	const service = createReviewService({
		reviewRepo: repo,
		publisher: opts?.publisher ?? createMockReviewPublisher(),
		aiConfig: opts?.aiConfig ?? readConfigFromEnv(),
		resolvePropertyName,
		isDemoTenant,
	})
	return { repo, service }
}
