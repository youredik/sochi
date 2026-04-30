/**
 * Payment service — orchestration of `payment.repo` + `PaymentProvider`.
 *
 * Canonical flow (memory `project_payment_domain_canonical.md`):
 *
 *   createIntent:
 *     1. Validate folio (if folioId given) — currency match, status=open.
 *     2. `repo.createIntent` — UNIQUE idempotency-key dedup at DB level.
 *        Returns `{ kind: 'created' | 'replayed', payment }`.
 *     3. On 'replayed': return existing as-is (Stripe-style, IETF idempotency).
 *     4. On 'created': invoke `provider.initiate` → snapshot. Stub provider
 *        is synchronous-success (autocapture, mirrors SBP per canon #17).
 *     5. `repo.applyTransition` to push the snapshot's status/timestamps
 *        through. Initial state `created` → terminal `succeeded` for stub.
 *
 *   applyTransition:
 *     Passthrough to repo with provider-aware SM gate (canTransitionForProvider).
 *
 *   getBy*: passthrough.
 *
 * RBAC: tenant-scoped only (route layer guards membership). Per-role
 * payment.create restrictions deferred to M6.6.1 — V1 demo any member
 * with active org can initiate (matches booking.routes.ts pattern).
 */
import type {
	Payment,
	PaymentMethod,
	PaymentProvider,
	PaymentProviderCode,
	PaymentSaleChannel,
	PaymentStatus,
} from '@horeca/shared'
import {
	FolioCurrencyMismatchError,
	FolioNotFoundError,
	InvalidFolioTransitionError,
} from '../../errors/domain.ts'
import type { FolioService } from '../folio/folio.service.ts'
import type { PaymentRepo } from './payment.repo.ts'

export interface PaymentCreateIntentInput {
	propertyId: string
	bookingId: string
	folioId: string | null
	providerCode: PaymentProviderCode
	method: PaymentMethod
	amountMinor: bigint
	currency: string
	idempotencyKey: string
	saleChannel: PaymentSaleChannel
	payerInn: string | null
}

export type PaymentCreateIntentResult =
	| { kind: 'created'; payment: Payment }
	| { kind: 'replayed'; payment: Payment }

export function createPaymentService(
	repo: PaymentRepo,
	provider: PaymentProvider,
	folioService: FolioService,
) {
	return {
		async createIntent(
			tenantId: string,
			input: PaymentCreateIntentInput,
			actorUserId: string,
		): Promise<PaymentCreateIntentResult> {
			// 1. Folio validation — only if a folio is bound. The intent CAN exist
			//    standalone (e.g. pre-booking deposit), but если bound, currency
			//    must match and folio must be open (canon invariant #14).
			if (input.folioId !== null) {
				const folio = await folioService.getById(tenantId, input.folioId)
				if (!folio) throw new FolioNotFoundError(input.folioId)
				if (folio.currency !== input.currency) {
					throw new FolioCurrencyMismatchError(folio.currency, input.currency)
				}
				if (folio.status !== 'open') {
					throw new InvalidFolioTransitionError(folio.status, 'post payment')
				}
			}

			// 2. Repo INSERT with UNIQUE idempotency dedup.
			const result = await repo.createIntent(
				tenantId,
				input.propertyId,
				input.bookingId,
				{
					folioId: input.folioId,
					providerCode: input.providerCode,
					method: input.method,
					amountMinor: input.amountMinor,
					currency: input.currency,
					idempotencyKey: input.idempotencyKey,
					saleChannel: input.saleChannel,
					payerInn: input.payerInn,
				},
				actorUserId,
			)

			// 3. Replay path — caller saw the same idempotency-key before. The
			//    payment is already in some state (potentially terminal); we
			//    don't re-call the provider. IETF idempotency-key semantics.
			if (result.kind === 'replayed') {
				return { kind: 'replayed', payment: result.payment }
			}

			// 4. Provider initiate. For stub: synchronous success (capturedMinor
			//    == amountMinor, status='succeeded'). For real providers: typically
			//    'pending' or 'waiting_for_capture' — caller polls or waits for
			//    webhook to advance state.
			const snapshot = await provider.initiate({
				localPaymentId: result.payment.id,
				providerIdempotencyKey: input.idempotencyKey,
				amountMinor: input.amountMinor,
				currency: input.currency,
				method: input.method,
			})

			// 5. Walk the Payment SM to the snapshot's terminal/intermediate state.
			//    SM (canon `payment-transitions.ts`):
			//        created → pending → waiting_for_capture | succeeded | failed
			//        waiting_for_capture → succeeded | canceled | expired
			//    Stub + SBP: synchronous-success path = created → pending → succeeded
			//    (skip waiting_for_capture per canon #17 sbp-no-preauth).
			//    Real providers (ЮKassa/T-Kassa): typically created → pending,
			//    then await webhook for the next leg.
			//
			//    First leg always created → pending.
			let current = await repo.applyTransition(
				tenantId,
				result.payment.id,
				result.payment.version,
				{
					status: 'pending',
					providerPaymentId: snapshot.providerPaymentId,
					confirmationUrl: snapshot.confirmationUrl,
					authorizedMinor: snapshot.authorizedMinor,
					capturedMinor: snapshot.capturedMinor,
				},
				actorUserId,
			)

			// Second leg: only if the snapshot is already terminal-ish (succeeded /
			// failed). For real providers returning 'pending', stop here — the
			// webhook handler will advance state in Phase 3.
			if (snapshot.status === 'succeeded') {
				current = await repo.applyTransition(
					tenantId,
					current.id,
					current.version,
					{
						status: 'succeeded',
						authorizedMinor: snapshot.authorizedMinor,
						capturedMinor: snapshot.capturedMinor,
						authorizedAt: new Date(),
						capturedAt: new Date(),
					},
					actorUserId,
				)
			} else if (snapshot.status === 'failed') {
				current = await repo.applyTransition(
					tenantId,
					current.id,
					current.version,
					{
						status: 'failed',
						failureReason: snapshot.failureReason,
						failedAt: new Date(),
					},
					actorUserId,
				)
			}
			return { kind: 'created', payment: current }
		},

		async getById(tenantId: string, id: string): Promise<Payment | null> {
			return await repo.getById(tenantId, id)
		},

		async getByIdempotencyKey(tenantId: string, key: string): Promise<Payment | null> {
			return await repo.getByIdempotencyKey(tenantId, key)
		},

		async listByFolio(tenantId: string, folioId: string): Promise<Payment[]> {
			return await repo.listByFolio(tenantId, folioId)
		},

		async listByBooking(
			tenantId: string,
			propertyId: string,
			bookingId: string,
		): Promise<Payment[]> {
			return await repo.listByBooking(tenantId, propertyId, bookingId)
		},

		/**
		 * Manual transition — used by webhook handler (Phase 3) and by the
		 * stub-provider integration test path. The repo enforces per-provider
		 * SM gate so calling this with a forbidden edge throws.
		 */
		async applyTransition(
			tenantId: string,
			id: string,
			expectedVersion: number,
			next: {
				status: PaymentStatus
				providerPaymentId?: string | null
				confirmationUrl?: string | null
				authorizedMinor?: bigint
				capturedMinor?: bigint
				holdExpiresAt?: Date | null
				failureReason?: string | null
				authorizedAt?: Date | null
				capturedAt?: Date | null
				refundedAt?: Date | null
				canceledAt?: Date | null
				failedAt?: Date | null
				expiredAt?: Date | null
			},
			actorUserId: string,
		): Promise<Payment> {
			return await repo.applyTransition(tenantId, id, expectedVersion, next, actorUserId)
		},
	}
}

export type PaymentService = ReturnType<typeof createPaymentService>
