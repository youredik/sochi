/**
 * Refund service — orchestration of `refund.repo` + `PaymentProvider`.
 *
 * Canonical flow (memory `project_payment_domain_canonical.md`):
 *
 *   create(paymentId, input):
 *     1. Load parent payment. Required: `succeeded`/`partially_refunded`
 *        (canRefund per `payment-transitions.canRefund`).
 *     2. Currency match (refund.currency = payment.currency).
 *     3. `repo.create` — UNIQUE causality dedup + cap check INSIDE the tx
 *        (canon #1, the most critical money invariant). Caller passes
 *        `capturedMinor` snapshot; repo loads existing refunds + asserts.
 *     4. Provider refund call. For stub: synchronous success. For real:
 *        typically pending → webhook completes (Phase 3).
 *     5. `applyTransition` pending → succeeded/failed based on snapshot.
 *
 *   applyTransition: passthrough.
 *   getBy*: passthrough.
 *
 * RBAC: tenant-scoped only (route guards membership). Per-role refund.create
 * restrictions deferred to M6.6.1.
 */
import type {
	PaymentProvider,
	PaymentStatus,
	Refund,
	RefundCausality,
	RefundStatus,
} from '@horeca/shared'
import { InvalidPaymentTransitionError, PaymentNotFoundError } from '../../errors/domain.ts'
import type { PaymentRepo } from '../payment/payment.repo.ts'

/**
 * Local mirror of `canRefund` predicate. depcruise no-cross-domain rule
 * blocks runtime imports between domains; type-only imports allowed.
 * `PaymentStatus` enum from @horeca/shared keeps compile-time narrowing.
 *
 * If payment SM expands the refundable-status set, sync this AND
 * `domains/payment/lib/payment-transitions.canRefund` в same commit
 * (both surfaces test independently — canon).
 */
function canRefund(status: PaymentStatus): boolean {
	return status === 'succeeded' || status === 'partially_refunded'
}

import type { RefundRepo } from './refund.repo.ts'

export interface RefundCreateInput {
	paymentId: string
	amountMinor: bigint
	reason: string
	causality: RefundCausality | null
}

export function createRefundService(
	repo: RefundRepo,
	paymentRepo: PaymentRepo,
	provider: PaymentProvider,
) {
	return {
		async create(tenantId: string, input: RefundCreateInput, actorUserId: string): Promise<Refund> {
			// 1. Load parent payment.
			const payment = await paymentRepo.getById(tenantId, input.paymentId)
			if (!payment) throw new PaymentNotFoundError(input.paymentId)

			// 2. SM gate — payment must be refundable (succeeded / partially_refunded).
			if (!canRefund(payment.status)) {
				throw new InvalidPaymentTransitionError(payment.status, 'refundable')
			}

			// 3. INSERT pending refund with cumulative-cap check (canon #1).
			const created = await repo.create(
				tenantId,
				{
					paymentId: input.paymentId,
					providerCode: payment.providerCode,
					amountMinor: input.amountMinor,
					currency: payment.currency,
					reason: input.reason,
					causality: input.causality,
					capturedMinor: BigInt(payment.capturedMinor),
				},
				actorUserId,
			)

			// 4. Provider refund call. Skip if no providerPaymentId (e.g. stub mock
			// paths where provider id wasn't assigned). For canonical flows,
			// providerPaymentId IS set by initiate.
			if (!payment.providerPaymentId) {
				return created
			}

			const snapshot = await provider.refund({
				providerPaymentId: payment.providerPaymentId,
				amountMinor: input.amountMinor,
				providerIdempotencyKey: created.id,
				reason: input.reason,
			})

			// 5. Persist provider terminal state. Stub returns 'succeeded'
			// synchronously; real providers typically 'pending' (webhook completes).
			if (snapshot.status === created.status) {
				return created
			}
			return await repo.applyTransition(
				tenantId,
				created.id,
				created.version,
				{
					status: snapshot.status,
					providerRefundId: snapshot.providerRefundId,
					failureReason: snapshot.failureReason,
					...(snapshot.status === 'succeeded' ? { succeededAt: new Date() } : {}),
					...(snapshot.status === 'failed' ? { failedAt: new Date() } : {}),
				},
				actorUserId,
			)
		},

		async getById(tenantId: string, id: string): Promise<Refund | null> {
			return await repo.getById(tenantId, id)
		},

		async listByPayment(tenantId: string, paymentId: string): Promise<Refund[]> {
			return await repo.listByPayment(tenantId, paymentId)
		},

		async getByCausalityId(tenantId: string, causalityId: string): Promise<Refund | null> {
			return await repo.getByCausalityId(tenantId, causalityId)
		},

		/**
		 * Manual transition — used by webhook handler (Phase 3) to advance a
		 * pending refund based on inbound webhook event.
		 */
		async applyTransition(
			tenantId: string,
			id: string,
			expectedVersion: number,
			next: {
				status: RefundStatus
				providerRefundId?: string | null
				failureReason?: string | null
				succeededAt?: Date | null
				failedAt?: Date | null
			},
			actorUserId: string,
		): Promise<Refund> {
			return await repo.applyTransition(tenantId, id, expectedVersion, next, actorUserId)
		},
	}
}
