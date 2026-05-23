import type { sql as SQL } from '../../db/index.ts'
import { createGuestDocumentRepo } from './guest-document.repo.ts'
import { createGuestRepo } from './guest.repo.ts'
import { createGuestService } from './guest.service.ts'

type SqlInstance = typeof SQL

export function createGuestFactory(sql: SqlInstance) {
	const repo = createGuestRepo(sql)
	const service = createGuestService(repo)
	// Sprint C+ Senior P0-1 fix 2026-05-23d: guestDocument repo for from-scan
	// persistence. Closes dead-code gap where RTBF cascade had no rows to scrub.
	const documentRepo = createGuestDocumentRepo(sql)
	return { repo, service, documentRepo }
}
