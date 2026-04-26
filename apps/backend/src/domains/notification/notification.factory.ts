import type { sql as SQL } from '../../db/index.ts'
import type { ActivityRepo } from '../activity/activity.repo.ts'
import { createNotificationRepo, type NotificationRepo } from './notification.repo.ts'
import { createNotificationService, type NotificationService } from './notification.service.ts'

type SqlInstance = typeof SQL

export interface NotificationFactory {
	repo: NotificationRepo
	service: NotificationService
}

export function createNotificationFactory(
	sql: SqlInstance,
	activityRepo: ActivityRepo,
): NotificationFactory {
	const repo = createNotificationRepo(sql)
	const service = createNotificationService(repo, activityRepo)
	return { repo, service }
}
