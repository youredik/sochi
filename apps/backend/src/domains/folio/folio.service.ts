/**
 * Folio service — thin orchestration layer over `FolioRepo`.
 *
 * Responsibilities (canon `project_payment_domain_canonical.md`):
 *   - Tenant-scoping: every method takes `tenantId` first, propagates into
 *     repo. Cross-tenant isolation absolute.
 *   - Default actor: `actorUserId` always passed through to repo for audit
 *     trails (CDC will materialise into `activity` rows).
 *   - Domain-error pass-through: repo throws structured domain errors;
 *     route handler's `onError` translates to JSON. Service does not catch.
 *
 * V1 surface (M6.6): 7 methods covering the demo flow. Group folios +
 * settle (open → settled) deferred to V2 per canon.
 */
import type { Folio, FolioKind, FolioLine } from '@horeca/shared'
import type { FolioRepo } from './folio.repo.ts'

export interface FolioCreateForBookingInput {
	propertyId: string
	bookingId: string
	kind: FolioKind
	currency: string
	companyId: string | null
}

export interface FolioPostLineInput {
	category: FolioLine['category']
	description: string
	amountMinor: bigint
	isAccommodationBase: boolean
	taxRateBps: number
	routingRuleId: string | null
	expectedFolioCurrency: string
	expectedFolioVersion: number
}

export function createFolioService(repo: FolioRepo) {
	return {
		async createForBooking(
			tenantId: string,
			input: FolioCreateForBookingInput,
			actorUserId: string,
		): Promise<Folio> {
			return await repo.createForBooking(tenantId, input.propertyId, input.bookingId, input.kind, {
				actorUserId,
				currency: input.currency,
				companyId: input.companyId,
			})
		},

		async getById(tenantId: string, id: string): Promise<Folio | null> {
			return await repo.getById(tenantId, id)
		},

		async listByBooking(tenantId: string, bookingId: string): Promise<Folio[]> {
			return await repo.listByBooking(tenantId, bookingId)
		},

		/**
		 * Receivables / aging dashboard: open+closed folios с positive balance
		 * для конкретного property. Pure passthrough — фильтрация и aging
		 * buckets вычисляются клиентом из выдаваемого списка.
		 */
		async listReceivables(tenantId: string, propertyId: string): Promise<Folio[]> {
			return await repo.listReceivablesByProperty(tenantId, propertyId)
		},

		async listLines(tenantId: string, folioId: string): Promise<FolioLine[]> {
			return await repo.listLinesByFolio(tenantId, folioId)
		},

		async postLine(
			tenantId: string,
			folioId: string,
			input: FolioPostLineInput,
			actorUserId: string,
		): Promise<{ folio: Folio; line: FolioLine }> {
			return await repo.postLine(tenantId, folioId, input, actorUserId)
		},

		async voidLine(
			tenantId: string,
			folioId: string,
			lineId: string,
			reason: string,
			actorUserId: string,
		): Promise<{ folio: Folio; line: FolioLine }> {
			return await repo.voidLine(tenantId, folioId, lineId, reason, actorUserId)
		},

		async close(tenantId: string, folioId: string, actorUserId: string): Promise<Folio> {
			return await repo.close(tenantId, folioId, actorUserId)
		},
	}
}

export type FolioService = ReturnType<typeof createFolioService>
