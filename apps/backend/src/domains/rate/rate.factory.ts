import type { sql as SQL } from '../../db/index.ts'
import type { RatePlanService } from '../ratePlan/ratePlan.service.ts'
import { createRateRepo } from './rate.repo.ts'
import { createRateService } from './rate.service.ts'

type SqlInstance = typeof SQL

export function createRateFactory(sql: SqlInstance, ratePlanService: RatePlanService) {
	const repo = createRateRepo(sql)
	const service = createRateService(repo, ratePlanService)
	return { repo, service }
}

export type RateFactory = ReturnType<typeof createRateFactory>
