import type { sql as SQL } from '../../db/index.ts'
import { createTenantComplianceRepo } from './compliance.repo.ts'

export function createTenantComplianceFactory(sql: typeof SQL) {
	const repo = createTenantComplianceRepo(sql)
	return { repo }
}

export type TenantComplianceFactory = ReturnType<typeof createTenantComplianceFactory>
