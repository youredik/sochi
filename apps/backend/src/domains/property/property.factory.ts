import type { sql as SQL } from '../../db/index.ts'
import { createPropertyRepo } from './property.repo.ts'
import { createPropertyService } from './property.service.ts'

/**
 * Wire up the property domain: repo → service.
 * Call once at app startup, pass the result into routes.
 */
export function createPropertyFactory(sql: typeof SQL) {
	const repo = createPropertyRepo(sql)
	const service = createPropertyService(repo)
	return { service }
}

export type PropertyFactory = ReturnType<typeof createPropertyFactory>
