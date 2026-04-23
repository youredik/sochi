import type { RateBulkUpsertInput } from '@horeca/shared'
import { RatePlanNotFoundError } from '../../errors/domain.ts'
import type { RatePlanService } from '../ratePlan/ratePlan.service.ts'
import type { RateRepo } from './rate.repo.ts'

/**
 * Rate service. Resolves the parent `ratePlan` (which carries propertyId +
 * roomTypeId, tenant-scoped) so callers only pass `ratePlanId` and we
 * derive the full PK automatically.
 */
export function createRateService(repo: RateRepo, ratePlanService: RatePlanService) {
	const resolvePlan = async (tenantId: string, ratePlanId: string) => {
		const plan = await ratePlanService.getById(tenantId, ratePlanId)
		if (!plan) throw new RatePlanNotFoundError(ratePlanId)
		return plan
	}

	return {
		listRange: async (
			tenantId: string,
			ratePlanId: string,
			range: { from: string; to: string },
		) => {
			const plan = await resolvePlan(tenantId, ratePlanId)
			return repo.listRange(tenantId, plan.propertyId, plan.roomTypeId, ratePlanId, range)
		},

		getOne: async (tenantId: string, ratePlanId: string, date: string) => {
			const plan = await resolvePlan(tenantId, ratePlanId)
			return repo.getOne(tenantId, plan.propertyId, plan.roomTypeId, ratePlanId, date)
		},

		bulkUpsert: async (tenantId: string, ratePlanId: string, input: RateBulkUpsertInput) => {
			const plan = await resolvePlan(tenantId, ratePlanId)
			return repo.bulkUpsert(tenantId, plan.propertyId, plan.roomTypeId, ratePlanId, input)
		},

		deleteOne: async (tenantId: string, ratePlanId: string, date: string) => {
			const plan = await resolvePlan(tenantId, ratePlanId)
			return repo.deleteOne(tenantId, plan.propertyId, plan.roomTypeId, ratePlanId, date)
		},
	}
}
