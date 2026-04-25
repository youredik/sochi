/**
 * Payment state-machine — pure FSM for the 9-state Payment SM.
 *
 * Production-grade for the live site. NO I/O. NO Date.now (caller passes
 * timestamps explicitly). NO Math.random. Everything deterministic in inputs
 * so Stryker mutation testing has a clean target (≥90% target, like the
 * folio-balance lib in M6.1).
 *
 * Canon (memory `project_payment_domain_canonical.md`, "State machines"):
 *
 *   created
 *     → pending             (system.providerCall — initiate sent)
 *
 *   pending
 *     → waiting_for_capture (webhook: ЮKassa-style auth-hold path)
 *     → succeeded           (webhook: SBP/stub/autocapture path)
 *     → failed              (webhook: preauth_decline | 3ds_failed | fraud_suspected)
 *
 *   waiting_for_capture
 *     → succeeded           (user/system.capture — possibly partial)
 *     → canceled            (user.void — guest no-show / manual)
 *     → expired             (scheduler — T+holdPeriodHours)
 *
 *   succeeded
 *     → partially_refunded  (derived: 0 < sum(refunds.succeeded) < captured)
 *     → refunded            (derived: sum(refunds.succeeded) = captured)
 *
 *   partially_refunded
 *     → refunded            (derived: cumulative full)
 *
 * Terminal: failed | canceled | expired | refunded.
 * Pseudo-terminal: succeeded | partially_refunded (mutate only via Refund children).
 *
 * Per-provider rules:
 *   - SBP-native MUST NEVER pass through `waiting_for_capture` (canon
 *     invariant #17 sbp-no-preauth). Enforced in `assertTransitionForProvider`.
 *   - Stub provider behaves like SBP for synchronous flow.
 *   - ЮKassa: T+72h hold expiry. T-Kassa: T+168h. SBP/stub: 0 (synchronous).
 */

import type { PaymentProviderCode, PaymentStatus } from '@horeca/shared'
import { TERMINAL_PAYMENT_STATUSES } from '@horeca/shared'

/* =================================================================== terminal */

/** True iff `status` is one of the 4 terminal states (no further transition). */
export function isTerminal(status: PaymentStatus): boolean {
	return (TERMINAL_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(status)
}

/**
 * True iff `status` is post-capture (succeeded or any refund-derived).
 * These are the only states from which Refund children may be inserted.
 */
export function isPostCapture(status: PaymentStatus): boolean {
	return status === 'succeeded' || status === 'partially_refunded' || status === 'refunded'
}

/**
 * True iff a Refund may be inserted referencing a payment in this state.
 * `refunded` is excluded — once cumulative refund reaches captured, no more
 * refunds may be added (canon invariant #1 cap).
 */
export function canRefund(status: PaymentStatus): boolean {
	return status === 'succeeded' || status === 'partially_refunded'
}

/* ============================================================= transition map */

/**
 * Allowed direct transitions. Only source states with outgoing edges are
 * present — terminal states are handled by an early-return in `canTransition`,
 * which avoids the dead-array entries that a literal-mutation pass (Stryker)
 * cannot meaningfully kill.
 *
 * The "derived" transitions (succeeded → partially_refunded → refunded) live
 * in this map because the service layer applies them via `transition()`
 * after recomputing refund projection in `deriveRefundStatus`.
 */
const ALLOWED_TRANSITIONS = {
	created: ['pending'],
	pending: ['waiting_for_capture', 'succeeded', 'failed'],
	waiting_for_capture: ['succeeded', 'canceled', 'expired'],
	succeeded: ['partially_refunded', 'refunded'],
	partially_refunded: ['refunded'],
} as const satisfies Partial<Record<PaymentStatus, readonly PaymentStatus[]>>

/** True iff `from → to` is a legal Payment SM edge. */
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
	if (isTerminal(from)) return false
	// After the terminal filter, `from` MUST be one of the 5 source-state keys
	// in ALLOWED_TRANSITIONS. The cast is sound by exhaustive type analysis;
	// the lookup never resolves to undefined in practice. Widen tuple type
	// for `.includes(to)` because TS narrows literal-tuple inclusion checks.
	const allowed: readonly PaymentStatus[] =
		ALLOWED_TRANSITIONS[from as keyof typeof ALLOWED_TRANSITIONS]
	return allowed.includes(to)
}

/**
 * Per-provider transition guard. Layered on top of `canTransition`:
 *   - SBP-native (`sbp`): forbids `pending → waiting_for_capture` (canon #17).
 *     SBP has no preauth; the webhook always lands as `succeeded` directly.
 *   - Other providers: pass through `canTransition` unchanged.
 */
export function canTransitionForProvider(
	provider: PaymentProviderCode,
	from: PaymentStatus,
	to: PaymentStatus,
): boolean {
	if (!canTransition(from, to)) return false
	if (provider === 'sbp' && from === 'pending' && to === 'waiting_for_capture') {
		return false
	}
	return true
}

/* ================================================================= holdExpiry */

/**
 * Provider auth-hold lifetime in hours. Returned to schedule the
 * `expire` job at T+holdPeriodHours.
 *   - ЮKassa: 72h default (configurable up to 7 days; 72 is the safe default).
 *   - T-Kassa: 168h default (cards), shorter for SBP rails.
 *   - SBP, digital_ruble, stub: 0 (synchronous; no separate hold).
 */
export function holdPeriodHours(provider: PaymentProviderCode): number {
	switch (provider) {
		case 'yookassa':
			return 72
		case 'tkassa':
			return 168
		case 'sbp':
		case 'digital_ruble':
		case 'stub':
			return 0
	}
}

/**
 * Compute the absolute hold-expiry timestamp.
 * `null` for synchronous providers (no separate hold).
 */
export function computeHoldExpiresAt(
	provider: PaymentProviderCode,
	authorizedAt: Date,
): Date | null {
	const hours = holdPeriodHours(provider)
	if (hours === 0) return null
	return new Date(authorizedAt.getTime() + hours * 3_600_000)
}

/**
 * True iff `now >= holdExpiresAt`. Returns false if the hold field is null
 * (synchronous provider has no concept of expiry).
 *
 * Caller passes both timestamps explicitly to keep this pure (no Date.now).
 */
export function isHoldExpired(holdExpiresAt: Date | null, now: Date): boolean {
	if (holdExpiresAt === null) return false
	return now.getTime() >= holdExpiresAt.getTime()
}

/* =============================================================== refund-derived */

/**
 * Compute the derived post-capture status from refund-projection state.
 *
 *   refundedSum === 0           → succeeded
 *   0 < refundedSum < captured  → partially_refunded
 *   refundedSum === captured    → refunded
 *
 * Preconditions:
 *   - `capturedMinor >= 0`
 *   - `refundedMinor >= 0`
 *   - `refundedMinor <= capturedMinor` (canon invariant #1)
 *
 * Throws RangeError on violation — service layer catches per-batch invariants
 * before calling this.
 */
export function deriveRefundStatus(
	capturedMinor: bigint,
	refundedMinor: bigint,
): 'succeeded' | 'partially_refunded' | 'refunded' {
	if (capturedMinor < 0n) {
		throw new RangeError(`capturedMinor must be >= 0, got ${capturedMinor}`)
	}
	if (refundedMinor < 0n) {
		throw new RangeError(`refundedMinor must be >= 0, got ${refundedMinor}`)
	}
	if (refundedMinor > capturedMinor) {
		throw new RangeError(
			`refundedMinor (${refundedMinor}) must be <= capturedMinor (${capturedMinor})`,
		)
	}
	if (refundedMinor === 0n) return 'succeeded'
	if (refundedMinor === capturedMinor) return 'refunded'
	return 'partially_refunded'
}

/* ================================================================= invariants */

/**
 * Strict transition assert — throws on forbidden edge.
 *
 * Preferred over a bare `canTransition` check at service-layer because it
 * yields a structured error message that surfaces both endpoints (debug-friendly).
 *
 * Caller catches and translates to `InvalidPaymentTransitionError`.
 */
export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
	if (!canTransition(from, to)) {
		throw new Error(`Forbidden Payment SM transition: '${from}' → '${to}'`)
	}
}

/**
 * Strict per-provider transition assert.
 * Same as `assertTransition` but layered with `canTransitionForProvider`.
 */
export function assertTransitionForProvider(
	provider: PaymentProviderCode,
	from: PaymentStatus,
	to: PaymentStatus,
): void {
	if (!canTransitionForProvider(provider, from, to)) {
		throw new Error(
			`Forbidden Payment SM transition for provider '${provider}': '${from}' → '${to}'`,
		)
	}
}

/* ============================================================== amount checks */

/**
 * Capture-amount guard (canon invariant #10): `capturedMinor <= authorizedMinor`.
 * Returns the diff (negative = legal slack, zero = full-capture, positive = invalid).
 */
export function captureExcess(capturedMinor: bigint, authorizedMinor: bigint): bigint {
	return capturedMinor - authorizedMinor
}

/**
 * True iff a capture of `requestMinor` against the current authorized
 * total would exceed it. Pure check; service layer translates to a
 * domain error.
 */
export function exceedsAuthorized(
	capturedSoFarMinor: bigint,
	requestMinor: bigint,
	authorizedMinor: bigint,
): boolean {
	if (capturedSoFarMinor < 0n || requestMinor < 0n || authorizedMinor < 0n) {
		throw new RangeError('All amounts must be >= 0')
	}
	return capturedSoFarMinor + requestMinor > authorizedMinor
}
