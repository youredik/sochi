import type { sql as SQL } from '../../db/index.ts'
import { createFolioRepo } from './folio.repo.ts'
import { createFolioService } from './folio.service.ts'

type SqlInstance = typeof SQL

export function createFolioFactory(sql: SqlInstance) {
	const repo = createFolioRepo(sql)
	const service = createFolioService(repo)
	return { repo, service }
}

export type FolioFactory = ReturnType<typeof createFolioFactory>
