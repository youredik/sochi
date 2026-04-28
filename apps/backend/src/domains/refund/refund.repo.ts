/**
 * Refund repository — atomic create + state-machine writes inside `sql.begin`.
 *
 * Production-grade for the live site. Inherits canonical patterns from
 * folio.repo.ts + payment.repo.ts:
 *   - All methods take `tenantId` first; tenant isolation absolute.
 *   - `sql.begin({ idempotent: true })` for OCC retry on TRANSACTION_LOCKS_INVALIDATED.
 *   - Manual `err.cause` unwrap (gotcha #11) + `err.cause.code === 400120`
 *     translation for UNIQUE PRECONDITION_FAILED collisions.
 *   - Full-row UPSERT for state transitions (gotcha #14).
 *   - `Date` columns wrapped via `dateFromIso`; `Timestamp` via `toTs`/`tsFromIso`
 *     (gotcha #10/#10b).
 *   - `version Int32` (NOT Uint32 per gotcha #9).
 *   - `NULL_FLOAT` / `NULL_TEXT` / `NULL_TIMESTAMP` typed nulls — never raw null.
 *   - OCC version-CAS: every UPDATE bumps version exactly +1.
 *
 * Methods (M6.3 surface):
 *   - create: insert pending refund. Caller passes capturedMinor + currentSum
 *     for canon #1 cap check; repo enforces invariant + UNIQUE causalityId
 *     dedup + UNIQUE providerRefundId dedup.
 *   - getById: tenant-scoped lookup
 *   - getByCausalityId: dedup-trigger lookup (dispute retry, etc.)
 *   - getByProviderRefundId: webhook dedup lookup
 *   - listByPayment: cumulative-sum source for canon #1 + UI display
 *   - applyTransition: pending → succeeded | failed with version-CAS + SM-guard
 *
 * Key invariants enforced:
 *   - canon #1 (refund-cumulative-cap): create() asserts via assertRefundCap
 *   - canon #20 (refund-amount-positive): Zod schema rejects amount <= 0
 *   - SM legality via canTransitionRefund
 *   - UNIQUE causality + UNIQUE providerRefundId — DB-level + 400120 catch
 *   - Cross-tenant absolute
 */
import type { Refund, RefundCausality, RefundStatus } from '@horeca/shared'
import { encodeCausalityId, newId } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import type { sql as SQL } from '../../db/index.ts'
import { isYdbUniqueConflict } from '../../db/index.ts'
import { NULL_TEXT, NULL_TIMESTAMP, textOpt, timestampOpt, toTs } from '../../db/ydb-helpers.ts'
import {
	InvalidRefundTransitionError,
	ProviderRefundIdTakenError,
	RefundCausalityCollisionError,
	RefundExceedsCaptureError,
	RefundNotFoundError,
	RefundVersionConflictError,
} from '../../errors/domain.ts'
import { assertRefundCap, canTransitionRefund, sumActiveMinor } from './lib/refund-math.ts'

type SqlInstance = typeof SQL

/* ============================================================ row shape */

type RefundDbRow = {
	tenantId: string
	paymentId: string
	id: string
	providerCode: string
	providerRefundId: string | null
	causalityId: string | null
	status: string
	amountMinor: number | bigint
	currency: string
	reason: string
	version: number | bigint
	requestedAt: Date
	succeededAt: Date | null
	failedAt: Date | null
	failureReason: string | null
	createdAt: Date
	updatedAt: Date
	createdBy: string
	updatedBy: string
}

function rowToRefund(r: RefundDbRow): Refund {
	return {
		tenantId: r.tenantId,
		paymentId: r.paymentId,
		id: r.id,
		providerCode: r.providerCode,
		providerRefundId: r.providerRefundId,
		causalityId: r.causalityId,
		status: r.status as RefundStatus,
		amountMinor: BigInt(r.amountMinor).toString(),
		currency: r.currency,
		reason: r.reason,
		version: Number(r.version),
		requestedAt: r.requestedAt.toISOString(),
		succeededAt: r.succeededAt?.toISOString() ?? null,
		failedAt: r.failedAt?.toISOString() ?? null,
		failureReason: r.failureReason,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}
}

/* ============================================================== helpers */

async function loadByIdForTx(tx: TX, tenantId: string, id: string): Promise<Refund | null> {
	const [rows = []] = await tx<RefundDbRow[]>`
		SELECT * FROM refund WHERE tenantId = ${tenantId} AND id = ${id} LIMIT 1
	`
	const row = rows[0]
	return row ? rowToRefund(row) : null
}

async function loadByPaymentForTx(tx: TX, tenantId: string, paymentId: string): Promise<Refund[]> {
	const [rows = []] = await tx<RefundDbRow[]>`
		SELECT * FROM refund WHERE tenantId = ${tenantId} AND paymentId = ${paymentId}
		ORDER BY requestedAt ASC, id ASC
	`
	return rows.map(rowToRefund)
}

function assertVersion(r: Refund, expected: number): void {
	if (r.version !== expected) {
		throw new RefundVersionConflictError(r.id, expected, r.version)
	}
}

type TransitionOverride = {
	status: RefundStatus
	version: number
	updatedAt: Date
	updatedBy: string
	providerRefundId?: string | null
	succeededAt?: Date | null
	failedAt?: Date | null
	failureReason?: string | null
}

function pickNullable<K extends keyof TransitionOverride>(
	next: TransitionOverride,
	key: K,
	currentValue: string | null,
): string | null {
	if (key in next) {
		const v = next[key] as string | null | undefined
		return v ?? null
	}
	return currentValue
}

function dateOrCurrent(
	next: TransitionOverride,
	key: keyof TransitionOverride,
	currentIso: string | null,
): Date | null {
	if (key in next) {
		const v = next[key] as Date | null | undefined
		return v ?? null
	}
	return currentIso ? new Date(currentIso) : null
}

async function upsertRefundRow(tx: TX, current: Refund, next: TransitionOverride): Promise<void> {
	const nowTs = toTs(next.updatedAt)
	const providerRefundId = pickNullable(next, 'providerRefundId', current.providerRefundId)
	const succeededAt = dateOrCurrent(next, 'succeededAt', current.succeededAt)
	const failedAt = dateOrCurrent(next, 'failedAt', current.failedAt)
	const failureReason = pickNullable(next, 'failureReason', current.failureReason)

	await tx`
		UPSERT INTO refund (
			\`tenantId\`, \`paymentId\`, \`id\`,
			\`providerCode\`, \`providerRefundId\`, \`causalityId\`,
			\`status\`, \`amountMinor\`, \`currency\`, \`reason\`,
			\`version\`,
			\`requestedAt\`, \`succeededAt\`, \`failedAt\`, \`failureReason\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${current.tenantId}, ${current.paymentId}, ${current.id},
			${current.providerCode},
			${providerRefundId === null ? NULL_TEXT : textOpt(providerRefundId)},
			${current.causalityId === null ? NULL_TEXT : textOpt(current.causalityId)},
			${next.status}, ${BigInt(current.amountMinor)}, ${current.currency}, ${current.reason},
			${next.version},
			${toTs(new Date(current.requestedAt))},
			${timestampOpt(succeededAt)},
			${timestampOpt(failedAt)},
			${failureReason === null ? NULL_TEXT : textOpt(failureReason)},
			${toTs(new Date(current.createdAt))}, ${nowTs}, ${current.createdBy}, ${next.updatedBy}
		)
	`
}

function applyTransitionInMemory(current: Refund, next: TransitionOverride): Refund {
	return {
		...current,
		status: next.status,
		version: next.version,
		updatedAt: next.updatedAt.toISOString(),
		updatedBy: next.updatedBy,
		...('providerRefundId' in next ? { providerRefundId: next.providerRefundId ?? null } : {}),
		...('succeededAt' in next
			? { succeededAt: next.succeededAt ? next.succeededAt.toISOString() : null }
			: {}),
		...('failedAt' in next ? { failedAt: next.failedAt ? next.failedAt.toISOString() : null } : {}),
		...('failureReason' in next ? { failureReason: next.failureReason ?? null } : {}),
	}
}

/* =========================================================== public API */

export type CreateRefundInput = {
	paymentId: string
	providerCode: string
	amountMinor: bigint
	currency: string
	reason: string
	causality: RefundCausality | null
	/**
	 * Snapshot of `payment.capturedMinor` taken under the same tx that loads
	 * existing refunds for the cumulative-cap check. Caller (service) loads
	 * payment + refunds, performs in-tx assertion, then calls this method.
	 *
	 * Repo accepts the snapshot directly to keep the cap check at the
	 * deepest authoritative point (just before INSERT).
	 */
	capturedMinor: bigint
}

export function createRefundRepo(sql: SqlInstance) {
	return {
		/**
		 * Create a `pending` refund. Performs canon #1 cap check + UNIQUE causality
		 * dedup INSIDE the tx so concurrent callers see consistent state.
		 *
		 * Throws:
		 *   - `RefundExceedsCaptureError` (canon #1 — the most critical money check)
		 *   - `RefundCausalityCollisionError` (UNIQUE causalityId)
		 *   - `ProviderRefundIdTakenError` (UNIQUE providerRefundId — at insert time
		 *     it's NULL so this only fires on later transitions)
		 */
		async create(tenantId: string, input: CreateRefundInput, actorUserId: string): Promise<Refund> {
			const id = newId('refund')
			const now = new Date()
			const nowTs = toTs(now)
			const causalityIdStr = input.causality ? encodeCausalityId(input.causality) : null

			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					// 1. Causality dedup (defense-in-depth before the UNIQUE-index race)
					if (causalityIdStr) {
						const [existingRows = []] = await tx<RefundDbRow[]>`
							SELECT * FROM refund VIEW ixRefundCausality
							WHERE tenantId = ${tenantId} AND causalityId = ${causalityIdStr}
							LIMIT 1
						`
						if (existingRows.length > 0) {
							throw new RefundCausalityCollisionError(causalityIdStr)
						}
					}

					// 2. Cumulative cap check (canon #1) — load all refunds for the
					// payment IN THE SAME TX so concurrent inserts see consistent state.
					const existingRefunds = await loadByPaymentForTx(tx, tenantId, input.paymentId)
					const currentSum = sumActiveMinor(existingRefunds)
					try {
						assertRefundCap({
							capturedMinor: input.capturedMinor,
							currentSumMinor: currentSum,
							newAmountMinor: input.amountMinor,
						})
					} catch (err) {
						if (err instanceof RangeError && /Refund cap exceeded/.test(err.message)) {
							throw new RefundExceedsCaptureError(input.capturedMinor, input.amountMinor)
						}
						throw err
					}

					// 3. INSERT the pending row.
					await tx`
						UPSERT INTO refund (
							\`tenantId\`, \`paymentId\`, \`id\`,
							\`providerCode\`, \`providerRefundId\`, \`causalityId\`,
							\`status\`, \`amountMinor\`, \`currency\`, \`reason\`,
							\`version\`,
							\`requestedAt\`, \`succeededAt\`, \`failedAt\`, \`failureReason\`,
							\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
						) VALUES (
							${tenantId}, ${input.paymentId}, ${id},
							${input.providerCode}, ${NULL_TEXT},
							${causalityIdStr === null ? NULL_TEXT : textOpt(causalityIdStr)},
							${'pending'}, ${input.amountMinor}, ${input.currency}, ${input.reason},
							${1},
							${nowTs}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT},
							${nowTs}, ${nowTs}, ${actorUserId}, ${actorUserId}
						)
					`

					return {
						tenantId,
						paymentId: input.paymentId,
						id,
						providerCode: input.providerCode,
						providerRefundId: null,
						causalityId: causalityIdStr,
						status: 'pending',
						amountMinor: input.amountMinor.toString(),
						currency: input.currency,
						reason: input.reason,
						version: 1,
						requestedAt: now.toISOString(),
						succeededAt: null,
						failedAt: null,
						failureReason: null,
						createdAt: now.toISOString(),
						updatedAt: now.toISOString(),
						createdBy: actorUserId,
						updatedBy: actorUserId,
					}
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof RefundExceedsCaptureError) throw err.cause
				if (err instanceof Error && err.cause instanceof RefundCausalityCollisionError)
					throw err.cause
				// UNIQUE-race past our SELECT pre-check (broadened M9.5 Phase B).
				if (isYdbUniqueConflict(err) && causalityIdStr !== null) {
					throw new RefundCausalityCollisionError(causalityIdStr)
				}
				throw err
			}
		},

		async getById(tenantId: string, id: string): Promise<Refund | null> {
			const [rows = []] = await sql<RefundDbRow[]>`
				SELECT * FROM refund WHERE tenantId = ${tenantId} AND id = ${id} LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToRefund(row) : null
		},

		async getByCausalityId(tenantId: string, causalityId: string): Promise<Refund | null> {
			const [rows = []] = await sql<RefundDbRow[]>`
				SELECT * FROM refund VIEW ixRefundCausality
				WHERE tenantId = ${tenantId} AND causalityId = ${causalityId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToRefund(row) : null
		},

		async getByProviderRefundId(
			tenantId: string,
			providerCode: string,
			providerRefundId: string,
		): Promise<Refund | null> {
			const [rows = []] = await sql<RefundDbRow[]>`
				SELECT * FROM refund VIEW ixRefundProvider
				WHERE tenantId = ${tenantId}
					AND providerCode = ${providerCode}
					AND providerRefundId = ${providerRefundId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToRefund(row) : null
		},

		async listByPayment(tenantId: string, paymentId: string): Promise<Refund[]> {
			const [rows = []] = await sql<RefundDbRow[]>`
				SELECT * FROM refund
				WHERE tenantId = ${tenantId} AND paymentId = ${paymentId}
				ORDER BY requestedAt ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToRefund)
		},

		async applyTransition(
			tenantId: string,
			id: string,
			expectedVersion: number,
			next: Omit<TransitionOverride, 'version' | 'updatedAt' | 'updatedBy'>,
			actorUserId: string,
		): Promise<Refund> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) throw new RefundNotFoundError(id)
					assertVersion(current, expectedVersion)
					if (!canTransitionRefund(current.status, next.status)) {
						throw new InvalidRefundTransitionError(current.status, next.status)
					}
					const now = new Date()
					const newVersion = current.version + 1
					const fullNext: TransitionOverride = {
						...next,
						version: newVersion,
						updatedAt: now,
						updatedBy: actorUserId,
					}
					await upsertRefundRow(tx, current, fullNext)
					return applyTransitionInMemory(current, fullNext)
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof RefundNotFoundError) throw err.cause
				if (err instanceof Error && err.cause instanceof RefundVersionConflictError) throw err.cause
				if (err instanceof Error && err.cause instanceof InvalidRefundTransitionError)
					throw err.cause
				if (
					isYdbUniqueConflict(err) &&
					next.providerRefundId !== undefined &&
					next.providerRefundId !== null
				) {
					throw new ProviderRefundIdTakenError(next.providerRefundId)
				}
				throw err
			}
		},
	}
}

export type RefundRepo = ReturnType<typeof createRefundRepo>
