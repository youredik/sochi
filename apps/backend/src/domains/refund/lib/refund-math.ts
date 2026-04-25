/**
 * Refund math — pure functions for the most critical money invariant in
 * the entire payment domain (canon invariant #1 refund-cumulative-cap).
 *
 * Production-grade for the live site. NO I/O. NO Date.now. NO Math.random.
 * Stryker mutation target ≥97% (same bar as folio-balance.ts and
 * payment-transitions.ts). Money never lies.
 *
 * Canon (memory `project_payment_domain_canonical.md`):
 *   - Cumulative cap: `SUM(refunds.succeeded.amountMinor) ≤ payment.capturedMinor`
 *     (canon #1). Enforced BEFORE provider call so the tx rolls back cleanly.
 *   - Refund amount strictly positive (canon #20 refund-amount-positive).
 *     Reversals are compensating refunds (separate rows), never negative amounts.
 *   - Causality dedup: each `causalityId` UNIQUE per tenant — duplicate
 *     create attempts (e.g. dispute-lost retry) blocked at DB level.
 *
 * Pure lib responsibilities:
 *   - sumSucceeded(refunds) — projection used to compute `payment.capturedMinor
 *     - sumSucceeded` available headroom.
 *   - sumPendingPlusSucceeded(refunds) — pessimistic projection for cap check
 *     during create (treat pending as if it'll succeed; rollback compensating
 *     not yet committed).
 *   - assertRefundCap(captured, currentSum, newAmount) — canon #1 check;
 *     throws RefundExceedsCaptureError-equivalent RangeError for callsite
 *     to translate.
 *   - cumulativeStatus — already in payment-transitions.ts (`deriveRefundStatus`),
 *     re-exported here for ergonomic local use.
 */

import {
	encodeCausalityId,
	type Refund,
	type RefundCausality,
	type RefundStatus,
} from '@horeca/shared'

/* ============================================================== sums + projections */

/** Convert Refund.amountMinor (string) to BigInt. */
function refundAmountMinor(r: Pick<Refund, 'amountMinor'>): bigint {
	return BigInt(r.amountMinor)
}

/**
 * Sum of `succeeded` refund amounts. The authoritative projection used to
 * compare against `payment.capturedMinor` (canon #1).
 *
 * Excludes `pending` (not yet confirmed) and `failed` (never landed at provider).
 */
export function sumSucceededMinor(
	refunds: ReadonlyArray<Pick<Refund, 'amountMinor' | 'status'>>,
): bigint {
	let sum = 0n
	for (const r of refunds) {
		if (r.status !== 'succeeded') continue
		sum += refundAmountMinor(r)
	}
	return sum
}

/**
 * Pessimistic sum: `succeeded + pending`. Used at refund-create time to gate
 * canon #1 against in-flight provider calls — if a pending refund is racing
 * to commit, we treat it as "going to succeed" and refuse to over-allocate.
 *
 * Adds defensive headroom: a created-but-not-yet-succeeded refund still
 * blocks new refunds from exceeding cap.
 */
export function sumActiveMinor(
	refunds: ReadonlyArray<Pick<Refund, 'amountMinor' | 'status'>>,
): bigint {
	let sum = 0n
	for (const r of refunds) {
		if (r.status === 'failed') continue
		sum += refundAmountMinor(r)
	}
	return sum
}

/* =========================================================== cap invariant */

/**
 * Canon invariant #1 (refund-cumulative-cap): the most critical money check.
 *
 *   currentSum + newAmount <= capturedMinor
 *
 * Throws `RangeError` on violation. Caller catches and translates to the
 * proper domain error (`RefundExceedsCaptureError`).
 *
 * Preconditions: all amounts >= 0. Negative inputs throw — caller layer
 * already validated, this is defensive.
 */
export function assertRefundCap(args: {
	capturedMinor: bigint
	currentSumMinor: bigint
	newAmountMinor: bigint
}): void {
	if (args.capturedMinor < 0n) {
		throw new RangeError(`capturedMinor must be >= 0, got ${args.capturedMinor}`)
	}
	if (args.currentSumMinor < 0n) {
		throw new RangeError(`currentSumMinor must be >= 0, got ${args.currentSumMinor}`)
	}
	if (args.newAmountMinor <= 0n) {
		throw new RangeError(`newAmountMinor must be > 0, got ${args.newAmountMinor}`)
	}
	if (args.currentSumMinor + args.newAmountMinor > args.capturedMinor) {
		throw new RangeError(
			`Refund cap exceeded: ${args.currentSumMinor} + ${args.newAmountMinor} > ${args.capturedMinor}`,
		)
	}
}

/**
 * Headroom = `capturedMinor - sumSucceededMinor`. The largest refund the
 * caller may issue WITHOUT violating canon #1 (assuming no concurrent
 * pending refunds). Surface in the UI to show "max refundable" slider.
 *
 * Returns 0n when sum >= captured (fully refunded — no headroom).
 */
export function refundHeadroomMinor(capturedMinor: bigint, sumSucceededMinor: bigint): bigint {
	if (capturedMinor < 0n) {
		throw new RangeError(`capturedMinor must be >= 0, got ${capturedMinor}`)
	}
	if (sumSucceededMinor < 0n) {
		throw new RangeError(`sumSucceededMinor must be >= 0, got ${sumSucceededMinor}`)
	}
	const headroom = capturedMinor - sumSucceededMinor
	return headroom > 0n ? headroom : 0n
}

/* =================================================== causality helpers */

/**
 * True iff the refund list contains an entry with the same causality string,
 * scoped to non-failed status (a failed refund's causality may be re-tried
 * by the application — DB UNIQUE allows it because failed rows are kept for
 * audit, but our domain layer asserts dedup explicitly).
 *
 * Used at create time to short-circuit before provider call, alongside the
 * UNIQUE index for defense-in-depth.
 */
export function hasActiveCausality(
	refunds: ReadonlyArray<Pick<Refund, 'causalityId' | 'status'>>,
	causality: RefundCausality,
): boolean {
	const target = encodeCausalityId(causality)
	return refunds.some((r) => r.status !== 'failed' && r.causalityId === target)
}

/* =================================================== status set helpers */

/** True iff `status` is one of the 2 terminal states (no further transition). */
export function isTerminalRefund(status: RefundStatus): boolean {
	return status === 'succeeded' || status === 'failed'
}

/** Allowed direct Refund SM transitions: pending → succeeded | failed. */
const ALLOWED_REFUND_TRANSITIONS: Record<'pending', readonly RefundStatus[]> = {
	pending: ['succeeded', 'failed'],
}

/** True iff `from → to` is a legal Refund SM edge. */
export function canTransitionRefund(from: RefundStatus, to: RefundStatus): boolean {
	if (isTerminalRefund(from)) return false
	// After the terminal filter, `from` is narrowed to 'pending' — the only
	// source state in ALLOWED_REFUND_TRANSITIONS. Cast is sound by exhaustive
	// type analysis.
	const allowed: readonly RefundStatus[] =
		ALLOWED_REFUND_TRANSITIONS[from as keyof typeof ALLOWED_REFUND_TRANSITIONS]
	return allowed.includes(to)
}

/** Strict assert — throws on forbidden edge. Caller translates to domain error. */
export function assertTransitionRefund(from: RefundStatus, to: RefundStatus): void {
	if (!canTransitionRefund(from, to)) {
		throw new Error(`Forbidden Refund SM transition: '${from}' → '${to}'`)
	}
}
