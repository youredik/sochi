import type { sql as SQL } from '../../db/index.ts'
import { createGuestRepo } from './guest.repo.ts'
import { createGuestService } from './guest.service.ts'

type SqlInstance = typeof SQL

export function createGuestFactory(sql: SqlInstance) {
	const repo = createGuestRepo(sql)
	const service = createGuestService(repo)
	return { repo, service }
}
