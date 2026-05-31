import type { ReviewRepo } from './review.repo.ts'

/**
 * Канонические демо-отзывы — ЕДИНСТВЕННЫЙ источник для обоих путей:
 *   1. статичный demo-tenant сид (`seed-demo-tenant.ts` Step 8);
 *   2. lazy per-tenant demo-провизионинг (`review.service.list` когда demo-org
 *      открывает страницу отзывов впервые — садятся под РЕАЛЬНУЮ property).
 *
 * `daysAgo` → `reviewedAt` вычисляется от `now` в `seedDemoReviewsCore` (свежие
 * даты при каждом провизионинге). Спред 5★→2★ даёт ИИ и лёгкие, и трудные кейсы.
 */
export interface DemoReviewSpec {
	readonly channelCode: string
	readonly externalId: string
	readonly guestName: string
	readonly ratingOverall: number
	readonly content: string
	readonly daysAgo: number
}

export const DEMO_REVIEWS: readonly DemoReviewSpec[] = [
	{
		channelCode: 'ostrovok',
		externalId: 'ostrovok-rev-demo-1',
		guestName: 'Мария Иванова',
		ratingOverall: 5,
		content:
			'Прекрасные апартаменты рядом с Сириусом! Чисто, уютно, до моря 7 минут пешком. Хозяин на связи, заселили быстро. Обязательно вернёмся.',
		daysAgo: 2,
	},
	{
		channelCode: 'yandexTravel',
		externalId: 'yandex-rev-demo-1',
		guestName: 'Сергей П.',
		ratingOverall: 4,
		content:
			'В целом всё понравилось: номер тёплый, завтрак вкусный. Единственное — заселение заняло почти час, ждали администратора. В остальном спасибо за отдых.',
		daysAgo: 4,
	},
	{
		channelCode: 'avito',
		externalId: 'avito-rev-demo-1',
		guestName: 'Алексей',
		ratingOverall: 2,
		content:
			'Ожидал большего. Ночью было шумно с улицы, кондиционер толком не охлаждал. Локация удобная, но за эти деньги хотелось бы тише и комфортнее.',
		daysAgo: 6,
	},
	{
		channelCode: 'ostrovok',
		externalId: 'ostrovok-rev-demo-2',
		guestName: 'Екатерина и Дмитрий',
		ratingOverall: 5,
		content:
			'Отдыхали семьёй, остались в восторге. Вид на горы, до Олимпийского парка близко, рядом кафе. Кухня оборудована всем необходимым. Рекомендуем!',
		daysAgo: 9,
	},
	{
		channelCode: 'yandexTravel',
		externalId: 'yandex-rev-demo-2',
		guestName: 'Ольга',
		ratingOverall: 3,
		content:
			'Номер чистый, персонал вежливый, но цена показалась завышенной для этого района. Wi-Fi периодически пропадал. Возможно, вне сезона было бы комфортнее.',
		daysAgo: 12,
	},
]

/**
 * Идемпотентно сеет демо-отзывы для (tenantId, propertyId). Дедуп по
 * (channelCode, externalId) — повторный вызов не плодит дубли (важно для lazy-
 * провизионинга под возможные гонки double-fetch). Возвращает число созданных.
 */
export async function seedDemoReviewsCore(
	repo: ReviewRepo,
	tenantId: string,
	propertyId: string,
	now: Date,
): Promise<{ created: number }> {
	let created = 0
	for (const r of DEMO_REVIEWS) {
		const existing = await repo.findByExternal(tenantId, r.channelCode, r.externalId)
		if (existing !== null) continue
		const reviewedAt = new Date(now.getTime() - r.daysAgo * 86_400_000).toISOString()
		await repo.create(
			tenantId,
			{
				channelCode: r.channelCode,
				externalId: r.externalId,
				propertyId,
				guestName: r.guestName,
				ratingOverall: r.ratingOverall,
				content: r.content,
				reviewedAt,
			},
			now,
		)
		created++
	}
	return { created }
}
