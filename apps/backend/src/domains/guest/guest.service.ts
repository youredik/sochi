import type { GuestCreateInput, GuestUpdateInput } from '@horeca/shared'
import type { GuestRepo } from './guest.repo.ts'

/**
 * Guest service. Thin wrapper — no cross-domain parents to validate (guests
 * exist independent of properties; they are attached to a property only via
 * bookings). Tenant scoping enforced by every repo method.
 */
export function createGuestService(repo: GuestRepo) {
	return {
		list: (tenantId: string) => repo.list(tenantId),
		getById: (tenantId: string, id: string) => repo.getById(tenantId, id),
		create: (tenantId: string, input: GuestCreateInput) => repo.create(tenantId, input),
		update: (tenantId: string, id: string, patch: GuestUpdateInput) =>
			repo.update(tenantId, id, patch),
		delete: (tenantId: string, id: string) => repo.delete(tenantId, id),
	}
}

export type GuestService = ReturnType<typeof createGuestService>
