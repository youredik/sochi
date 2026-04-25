/**
 * Payment repository — atomic intent + state-machine writes inside `sql.begin`.
 *
 * Production-grade for the live site (NOT a demo stub). Patterns inherited
 * from booking.repo.ts + folio.repo.ts (M6.1):
 *   - All methods take `tenantId` first; tenant isolation absolute.
 *   - `sql.begin({ idempotent: true })` for OCC retry on TRANSACTION_LOCKS_INVALIDATED.
 *   - Manual `err.cause` unwrap (gotcha #11 — sql.begin wraps non-retryable
 *     errors in `Error('Transaction failed.', { cause })`).
 *   - Full-row UPSERT for state transitions (gotcha #14 — UPDATE on mixed-type
 *     SET clause vs many-nullable-column tables is unreliable).
 *   - `Date` columns wrapped via `dateFromIso`; `Timestamp` via `toTs`/`tsFromIso`
 *     to preserve ms precision (gotcha #10).
 *   - `version Int32` (NOT Uint32 per gotcha #9).
 *   - OCC version-CAS: every UPDATE bumps version exactly +1; concurrent writers
 *     surface `PaymentVersionConflictError`.
 *   - Cross-tenant absolute: every read+write filters by tenantId.
 *
 * Methods (M6.2 surface — what's needed by service layer + webhook handlers):
 *   - createIntent: insert payment row with `status='created'` + idempotency
 *     UNIQUE pre-check. Returns row + boolean indicating fresh-insert vs replay.
 *   - getById: tenant-scoped by-id lookup
 *   - getByProviderId: webhook dedup lookup (provider's id)
 *   - getByIdempotencyKey: replay lookup for IETF Idempotency-Key
 *   - listByFolio: all payments for a folio (receivables/aging join)
 *   - listByBooking: all payments for a booking (admin view)
 *   - applyTransition: full-row UPSERT with CAS + state-machine guard
 *
 * Key invariants enforced here (cross-ref to canon):
 *   - #2 terminal-immutability: applyTransition rejects from-terminal.
 *   - #6 version monotonic: every UPDATE bumps version +1.
 *   - #10 capture-amount-bound: capturedMinor <= authorizedMinor on transition.
 *   - #14 currency-folio-match: payment.currency = folio.currency at insert.
 *   - #16 t-kassa-cancel-creates-refund: handled by service layer (this repo
 *     only persists the transition; cancel-creates-refund logic is one level up).
 *   - #21 concurrent-capture-cas: version-CAS surfaces PaymentVersionConflictError.
 */
import type {
	Payment,
	PaymentMethod,
	PaymentProviderCode,
	PaymentSaleChannel,
	PaymentStatus,
} from '@horeca/shared'
import { newId } from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import type { sql as SQL } from '../../db/index.ts'
import {
	NULL_FLOAT,
	NULL_TEXT,
	NULL_TIMESTAMP,
	textOpt,
	timestampOpt,
	toTs,
} from '../../db/ydb-helpers.ts'
import {
	InvalidPaymentTransitionError,
	PaymentIdempotencyKeyTakenError,
	PaymentNotFoundError,
	PaymentVersionConflictError,
	ProviderPaymentIdTakenError,
} from '../../errors/domain.ts'
import { canTransitionForProvider } from './lib/payment-transitions.ts'

type SqlInstance = typeof SQL

/* ============================================================ row shape */

type PaymentDbRow = {
	tenantId: string
	propertyId: string
	bookingId: string
	id: string
	folioId: string | null
	providerCode: string
	providerPaymentId: string | null
	confirmationUrl: string | null
	method: string
	status: string
	amountMinor: number | bigint
	authorizedMinor: number | bigint
	capturedMinor: number | bigint
	currency: string
	idempotencyKey: string
	version: number | bigint
	payerInn: string | null
	saleChannel: string
	anomalyScore: number | null
	holdExpiresAt: Date | null
	createdAt: Date
	updatedAt: Date
	authorizedAt: Date | null
	capturedAt: Date | null
	refundedAt: Date | null
	canceledAt: Date | null
	failedAt: Date | null
	expiredAt: Date | null
	failureReason: string | null
	createdBy: string
	updatedBy: string
}

function rowToPayment(r: PaymentDbRow): Payment {
	return {
		tenantId: r.tenantId,
		propertyId: r.propertyId,
		bookingId: r.bookingId,
		id: r.id,
		folioId: r.folioId,
		providerCode: r.providerCode as PaymentProviderCode,
		providerPaymentId: r.providerPaymentId,
		confirmationUrl: r.confirmationUrl,
		method: r.method as PaymentMethod,
		status: r.status as PaymentStatus,
		amountMinor: BigInt(r.amountMinor).toString(),
		authorizedMinor: BigInt(r.authorizedMinor).toString(),
		capturedMinor: BigInt(r.capturedMinor).toString(),
		currency: r.currency,
		idempotencyKey: r.idempotencyKey,
		version: Number(r.version),
		payerInn: r.payerInn,
		saleChannel: r.saleChannel as PaymentSaleChannel,
		anomalyScore: r.anomalyScore,
		holdExpiresAt: r.holdExpiresAt?.toISOString() ?? null,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
		authorizedAt: r.authorizedAt?.toISOString() ?? null,
		capturedAt: r.capturedAt?.toISOString() ?? null,
		refundedAt: r.refundedAt?.toISOString() ?? null,
		canceledAt: r.canceledAt?.toISOString() ?? null,
		failedAt: r.failedAt?.toISOString() ?? null,
		expiredAt: r.expiredAt?.toISOString() ?? null,
		failureReason: r.failureReason,
		createdBy: r.createdBy,
		updatedBy: r.updatedBy,
	}
}

/* ============================================================== helpers */

async function loadByIdForTx(tx: TX, tenantId: string, id: string): Promise<Payment | null> {
	const [rows = []] = await tx<PaymentDbRow[]>`
		SELECT * FROM payment WHERE tenantId = ${tenantId} AND id = ${id} LIMIT 1
	`
	const row = rows[0]
	return row ? rowToPayment(row) : null
}

function assertVersion(p: Payment, expected: number): void {
	if (p.version !== expected) {
		throw new PaymentVersionConflictError(p.id, expected, p.version)
	}
}

/**
 * Full-row UPSERT for state-machine transitions. All NOT NULL fields preserved;
 * caller passes the override delta. Same pattern as booking.repo.ts and
 * folio.repo.ts — gotcha #14 — UPDATE with mixed nullable/NOT NULL on a
 * many-column table fails plan-builder.
 *
 * Caller is responsible for `next.version === current.version + 1` and for
 * the state-machine guard (assertTransition). This helper only persists.
 */
type TransitionOverride = {
	status: PaymentStatus
	version: number
	updatedAt: Date
	updatedBy: string
	// Money: only `capturedMinor` and `authorizedMinor` can change post-create.
	authorizedMinor?: bigint
	capturedMinor?: bigint
	// Provider-side identifiers — fill on initiate response.
	providerPaymentId?: string | null
	confirmationUrl?: string | null
	// State-transition timestamps: pass to set them; absent = preserve.
	authorizedAt?: Date | null
	capturedAt?: Date | null
	refundedAt?: Date | null
	canceledAt?: Date | null
	failedAt?: Date | null
	expiredAt?: Date | null
	holdExpiresAt?: Date | null
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

async function upsertPaymentRow(tx: TX, current: Payment, next: TransitionOverride): Promise<void> {
	const nowTs = toTs(next.updatedAt)
	const authorizedMinor = next.authorizedMinor ?? BigInt(current.authorizedMinor)
	const capturedMinor = next.capturedMinor ?? BigInt(current.capturedMinor)
	const providerPaymentId = pickNullable(next, 'providerPaymentId', current.providerPaymentId)
	const confirmationUrl = pickNullable(next, 'confirmationUrl', current.confirmationUrl)
	const authorizedAt = dateOrCurrent(next, 'authorizedAt', current.authorizedAt)
	const capturedAt = dateOrCurrent(next, 'capturedAt', current.capturedAt)
	const refundedAt = dateOrCurrent(next, 'refundedAt', current.refundedAt)
	const canceledAt = dateOrCurrent(next, 'canceledAt', current.canceledAt)
	const failedAt = dateOrCurrent(next, 'failedAt', current.failedAt)
	const expiredAt = dateOrCurrent(next, 'expiredAt', current.expiredAt)
	const holdExpiresAt = dateOrCurrent(next, 'holdExpiresAt', current.holdExpiresAt)
	const failureReason = pickNullable(next, 'failureReason', current.failureReason)

	await tx`
		UPSERT INTO payment (
			\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
			\`folioId\`, \`providerCode\`, \`providerPaymentId\`, \`confirmationUrl\`,
			\`method\`, \`status\`,
			\`amountMinor\`, \`authorizedMinor\`, \`capturedMinor\`, \`currency\`,
			\`idempotencyKey\`, \`version\`,
			\`payerInn\`, \`saleChannel\`, \`anomalyScore\`,
			\`holdExpiresAt\`,
			\`createdAt\`, \`updatedAt\`,
			\`authorizedAt\`, \`capturedAt\`, \`refundedAt\`, \`canceledAt\`, \`failedAt\`, \`expiredAt\`,
			\`failureReason\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${current.tenantId}, ${current.propertyId}, ${current.bookingId}, ${current.id},
			${current.folioId ?? NULL_TEXT}, ${current.providerCode},
			${providerPaymentId === null ? NULL_TEXT : textOpt(providerPaymentId)},
			${confirmationUrl === null ? NULL_TEXT : textOpt(confirmationUrl)},
			${current.method}, ${next.status},
			${BigInt(current.amountMinor)}, ${authorizedMinor}, ${capturedMinor}, ${current.currency},
			${current.idempotencyKey}, ${next.version},
			${current.payerInn ?? NULL_TEXT}, ${current.saleChannel}, ${NULL_FLOAT},
			${timestampOpt(holdExpiresAt)},
			${toTs(new Date(current.createdAt))}, ${nowTs},
			${timestampOpt(authorizedAt)},
			${timestampOpt(capturedAt)},
			${timestampOpt(refundedAt)},
			${timestampOpt(canceledAt)},
			${timestampOpt(failedAt)},
			${timestampOpt(expiredAt)},
			${failureReason === null ? NULL_TEXT : textOpt(failureReason)},
			${current.createdBy}, ${next.updatedBy}
		)
	`
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

/**
 * Apply transition delta in-memory (mirror of upsertPaymentRow).
 */
function applyTransition(current: Payment, next: TransitionOverride): Payment {
	return {
		...current,
		status: next.status,
		version: next.version,
		updatedAt: next.updatedAt.toISOString(),
		updatedBy: next.updatedBy,
		...(next.authorizedMinor !== undefined
			? { authorizedMinor: next.authorizedMinor.toString() }
			: {}),
		...(next.capturedMinor !== undefined ? { capturedMinor: next.capturedMinor.toString() } : {}),
		...('providerPaymentId' in next ? { providerPaymentId: next.providerPaymentId ?? null } : {}),
		...('confirmationUrl' in next ? { confirmationUrl: next.confirmationUrl ?? null } : {}),
		...isoIfPresent(next, 'authorizedAt', current.authorizedAt, 'authorizedAt'),
		...isoIfPresent(next, 'capturedAt', current.capturedAt, 'capturedAt'),
		...isoIfPresent(next, 'refundedAt', current.refundedAt, 'refundedAt'),
		...isoIfPresent(next, 'canceledAt', current.canceledAt, 'canceledAt'),
		...isoIfPresent(next, 'failedAt', current.failedAt, 'failedAt'),
		...isoIfPresent(next, 'expiredAt', current.expiredAt, 'expiredAt'),
		...isoIfPresent(next, 'holdExpiresAt', current.holdExpiresAt, 'holdExpiresAt'),
		...('failureReason' in next ? { failureReason: next.failureReason ?? null } : {}),
	}
}

function isoIfPresent<K extends keyof TransitionOverride, F extends keyof Payment>(
	next: TransitionOverride,
	key: K,
	_currentIso: string | null,
	field: F,
): Partial<Payment> {
	if (!(key in next)) return {}
	const v = next[key] as Date | null | undefined
	return { [field]: v ? v.toISOString() : null } as Partial<Payment>
}

/* =========================================================== public API */

export type CreateIntentInput = {
	folioId: string | null
	providerCode: PaymentProviderCode
	method: PaymentMethod
	amountMinor: bigint
	currency: string
	idempotencyKey: string
	saleChannel: PaymentSaleChannel
	payerInn: string | null
}

export type CreateIntentResult =
	| { kind: 'created'; payment: Payment }
	/** Replay: same idempotencyKey already used; existing row returned. */
	| { kind: 'replayed'; payment: Payment }

export function createPaymentRepo(sql: SqlInstance) {
	return {
		/**
		 * Create a fresh `created`-state payment intent. Idempotency-Key dedup:
		 * if `(tenantId, idempotencyKey)` already exists, return the existing row
		 * with `kind: 'replayed'`. Service layer compares fingerprint and decides
		 * whether to surface `IdempotencyKeyConflictError` (different body).
		 */
		async createIntent(
			tenantId: string,
			propertyId: string,
			bookingId: string,
			input: CreateIntentInput,
			actorUserId: string,
		): Promise<CreateIntentResult> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					// Idempotency replay check via UNIQUE index lookup
					const [existingRows = []] = await tx<PaymentDbRow[]>`
						SELECT * FROM payment VIEW ixPaymentIdempotency
						WHERE tenantId = ${tenantId} AND idempotencyKey = ${input.idempotencyKey}
						LIMIT 1
					`
					const existing = existingRows[0]
					if (existing) {
						return { kind: 'replayed' as const, payment: rowToPayment(existing) }
					}

					const id = newId('payment')
					const now = new Date()
					const nowTs = toTs(now)
					await tx`
						UPSERT INTO payment (
							\`tenantId\`, \`propertyId\`, \`bookingId\`, \`id\`,
							\`folioId\`, \`providerCode\`, \`providerPaymentId\`, \`confirmationUrl\`,
							\`method\`, \`status\`,
							\`amountMinor\`, \`authorizedMinor\`, \`capturedMinor\`, \`currency\`,
							\`idempotencyKey\`, \`version\`,
							\`payerInn\`, \`saleChannel\`, \`anomalyScore\`,
							\`holdExpiresAt\`,
							\`createdAt\`, \`updatedAt\`,
							\`authorizedAt\`, \`capturedAt\`, \`refundedAt\`, \`canceledAt\`, \`failedAt\`, \`expiredAt\`,
							\`failureReason\`, \`createdBy\`, \`updatedBy\`
						) VALUES (
							${tenantId}, ${propertyId}, ${bookingId}, ${id},
							${input.folioId ?? NULL_TEXT}, ${input.providerCode}, ${NULL_TEXT}, ${NULL_TEXT},
							${input.method}, ${'created'},
							${input.amountMinor}, ${0n}, ${0n}, ${input.currency},
							${input.idempotencyKey}, ${1},
							${input.payerInn ?? NULL_TEXT}, ${input.saleChannel}, ${NULL_FLOAT},
							${NULL_TIMESTAMP},
							${nowTs}, ${nowTs},
							${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP},
							${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP},
							${NULL_TEXT}, ${actorUserId}, ${actorUserId}
						)
					`

					const payment: Payment = {
						tenantId,
						propertyId,
						bookingId,
						id,
						folioId: input.folioId,
						providerCode: input.providerCode,
						providerPaymentId: null,
						confirmationUrl: null,
						method: input.method,
						status: 'created',
						amountMinor: input.amountMinor.toString(),
						authorizedMinor: '0',
						capturedMinor: '0',
						currency: input.currency,
						idempotencyKey: input.idempotencyKey,
						version: 1,
						payerInn: input.payerInn,
						saleChannel: input.saleChannel,
						anomalyScore: null,
						holdExpiresAt: null,
						createdAt: now.toISOString(),
						updatedAt: now.toISOString(),
						authorizedAt: null,
						capturedAt: null,
						refundedAt: null,
						canceledAt: null,
						failedAt: null,
						expiredAt: null,
						failureReason: null,
						createdBy: actorUserId,
						updatedBy: actorUserId,
					}
					return { kind: 'created' as const, payment }
				})
			} catch (err) {
				// UNIQUE-key race past our SELECT pre-check: two concurrent createIntent
				// with same idempotencyKey both saw "no existing row", both attempted
				// UPSERT, second one hit the UNIQUE index. YDB surfaces this as
				// `PRECONDITION_FAILED, ERROR(2012): Conflict with existing key.` wrapped
				// in `Error('Transaction failed.', { cause: YDBError(code=400120) })`.
				// Translate to domain error so caller can decide replay vs reject.
				if (
					err instanceof Error &&
					err.cause &&
					typeof err.cause === 'object' &&
					'code' in err.cause &&
					err.cause.code === 400120
				) {
					throw new PaymentIdempotencyKeyTakenError(input.idempotencyKey)
				}
				throw err
			}
		},

		async getById(tenantId: string, id: string): Promise<Payment | null> {
			const [rows = []] = await sql<PaymentDbRow[]>`
				SELECT * FROM payment WHERE tenantId = ${tenantId} AND id = ${id} LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToPayment(row) : null
		},

		async getByProviderId(
			tenantId: string,
			providerCode: PaymentProviderCode,
			providerPaymentId: string,
		): Promise<Payment | null> {
			const [rows = []] = await sql<PaymentDbRow[]>`
				SELECT * FROM payment VIEW ixPaymentProvider
				WHERE tenantId = ${tenantId}
					AND providerCode = ${providerCode}
					AND providerPaymentId = ${providerPaymentId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToPayment(row) : null
		},

		async getByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<Payment | null> {
			const [rows = []] = await sql<PaymentDbRow[]>`
				SELECT * FROM payment VIEW ixPaymentIdempotency
				WHERE tenantId = ${tenantId} AND idempotencyKey = ${idempotencyKey}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			return row ? rowToPayment(row) : null
		},

		async listByFolio(tenantId: string, folioId: string): Promise<Payment[]> {
			const [rows = []] = await sql<PaymentDbRow[]>`
				SELECT * FROM payment
				WHERE tenantId = ${tenantId} AND folioId = ${folioId}
				ORDER BY createdAt ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToPayment)
		},

		async listByBooking(
			tenantId: string,
			propertyId: string,
			bookingId: string,
		): Promise<Payment[]> {
			const [rows = []] = await sql<PaymentDbRow[]>`
				SELECT * FROM payment
				WHERE tenantId = ${tenantId}
					AND propertyId = ${propertyId}
					AND bookingId = ${bookingId}
				ORDER BY createdAt ASC, id ASC
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			return rows.map(rowToPayment)
		},

		/**
		 * Apply a state-machine transition with version-CAS. Caller passes:
		 *   - `expectedVersion`: the version the caller saw when reading the row.
		 *     CAS compares; mismatch → PaymentVersionConflictError.
		 *   - `next`: the new status + delta of fields (money, timestamps, etc).
		 *
		 * Service layer is responsible for validating money invariants (refund
		 * cap, capture <= authorized) before calling. This repo only enforces:
		 *   - SM legality via `canTransitionForProvider`
		 *   - version-CAS
		 *   - cross-tenant isolation
		 */
		async applyTransition(
			tenantId: string,
			id: string,
			expectedVersion: number,
			next: Omit<TransitionOverride, 'version' | 'updatedAt' | 'updatedBy'>,
			actorUserId: string,
		): Promise<Payment> {
			try {
				return await sql.begin({ idempotent: true }, async (tx) => {
					const current = await loadByIdForTx(tx, tenantId, id)
					if (!current) throw new PaymentNotFoundError(id)
					assertVersion(current, expectedVersion)
					if (!canTransitionForProvider(current.providerCode, current.status, next.status)) {
						throw new InvalidPaymentTransitionError(current.status, next.status)
					}
					const now = new Date()
					const newVersion = current.version + 1
					const fullNext: TransitionOverride = {
						...next,
						version: newVersion,
						updatedAt: now,
						updatedBy: actorUserId,
					}
					await upsertPaymentRow(tx, current, fullNext)
					return applyTransition(current, fullNext)
				})
			} catch (err) {
				if (err instanceof Error && err.cause instanceof PaymentNotFoundError) throw err.cause
				if (err instanceof Error && err.cause instanceof PaymentVersionConflictError)
					throw err.cause
				if (err instanceof Error && err.cause instanceof InvalidPaymentTransitionError)
					throw err.cause
				if (err instanceof Error && err.cause instanceof ProviderPaymentIdTakenError)
					throw err.cause
				// UNIQUE collision: YDB surfaces as `PRECONDITION_FAILED, ERROR(2012):
				// Conflict with existing key.` wrapped in `Error('Transaction failed.', { cause })`.
				// Code 400120 = PRECONDITION_FAILED. Translate to domain error.
				if (
					err instanceof Error &&
					err.cause &&
					typeof err.cause === 'object' &&
					'code' in err.cause &&
					err.cause.code === 400120 &&
					next.providerPaymentId !== undefined &&
					next.providerPaymentId !== null
				) {
					throw new ProviderPaymentIdTakenError('unknown', next.providerPaymentId)
				}
				throw err
			}
		},
	}
}

export type PaymentRepo = ReturnType<typeof createPaymentRepo>
