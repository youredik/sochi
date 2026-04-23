import type { sql as SQL } from '../../db/index.ts'
import { createActivityRepo } from './activity.repo.ts'

type SqlInstance = typeof SQL

export function createActivityFactory(sql: SqlInstance) {
	const repo = createActivityRepo(sql)
	return { repo }
}
