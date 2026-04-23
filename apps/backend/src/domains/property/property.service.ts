import type { PropertyCreateInput, PropertyUpdateInput } from '@horeca/shared'
import type { PropertyRepo } from './property.repo.ts'

/**
 * Property service — thin layer on top of the repo.
 * Business rules live here (not in repo, not in routes).
 * Always takes `tenantId` as the first argument.
 */
export function createPropertyService(repo: PropertyRepo) {
	return {
		list: (tenantId: string, includeInactive = false) => repo.list(tenantId, { includeInactive }),

		getById: (tenantId: string, id: string) => repo.getById(tenantId, id),

		create: (tenantId: string, input: PropertyCreateInput) => repo.create(tenantId, input),

		update: (tenantId: string, id: string, patch: PropertyUpdateInput) =>
			repo.update(tenantId, id, patch),

		/**
		 * Soft-delete variant kept for symmetry — actual hard delete through repo.
		 * If/when we add bookings, switch to `update({ isActive: false })`.
		 */
		delete: (tenantId: string, id: string) => repo.delete(tenantId, id),
	}
}

export type PropertyService = ReturnType<typeof createPropertyService>
