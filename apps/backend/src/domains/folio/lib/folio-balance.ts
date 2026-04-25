/**
 * Folio balance — pure money math.
 *
 * Source-of-truth helpers for the payment domain (M6, see memory
 * `project_payment_domain_canonical.md`). NO I/O. NO Date.now. NO Math.random.
 * Everything is deterministic in its inputs so Stryker mutation testing has
 * a clean target (mutation floor ≥80% per `project_coverage_mutation_gates.md`).
 *
 * Money convention recap (canonical decision):
 *   - Booking domain: `Int64 amountMicros` (× 10^6). 1 RUB = 1_000_000 micros.
 *   - Payment + Folio domains: `Int64 amountMinor` (копейки). 1 RUB = 100 minor.
 *   - Conversion at the post boundary: `minor = round-half-up(micros / 10_000)`.
 *
 * The booking domain stays in micros because of the YDB Decimal workaround
 * documented in memory `project_ydb_specifics.md` #13. Payments diverge to
 * копейки because every Russian provider API (ЮKassa / T-Kassa / СБП) and
 * the 54-ФЗ FFD 1.2 spec works in копейки natively. Diverging once at the
 * boundary is cheaper than converting at every webhook handler.
 *
 * Tourism tax floor (НК РФ ст.418.5, Сочи 2026 = 2%):
 *   tax = max(base * rateBps / 10_000, 10_000 * nights)
 *   where 10_000 minor = 100₽ (the regulated per-night minimum).
 */

import type { FolioLine } from '@horeca/shared'

/** 1 ruble in копейки. */
const MINOR_PER_RUBLE = 100n

/** Tourism tax floor: 100 RUB per night = 10_000 копейки per night. НК РФ ст.418.5. */
const TOURISM_TAX_FLOOR_MINOR_PER_NIGHT = 100n * MINOR_PER_RUBLE

/** Basis-point divisor: 10_000 bps = 100%. */
const BPS_DIVISOR = 10_000n

/** 1 копейка = 10_000 micros (since 1 RUB = 100 копейки = 1_000_000 micros). */
const MICROS_PER_MINOR = 10_000n

/* ============================================================== conversions */

/**
 * Convert booking-domain `Int64 micros` to payment-domain `Int64 minor` (копейки)
 * using **round-half-up** (5 → up). Banker's rounding (half-to-even) was
 * considered but rejected: Russian invoice/чек precision is whole копейки and
 * round-half-up matches ФНС rounding rules + ЮKassa's own conversion.
 *
 * Examples (in 100₽ scale where 1₽ = 1_000_000 micros = 100 minor):
 *   - 1.5 копейки  (15_000 micros) → 2 минор копейки (rounded up)
 *   - 1.4 копейки  (14_000 micros) → 1 минор
 *   - 1.6 копейки  (16_000 micros) → 2 минор
 *   - -1.5 копейки (-15_000 micros) → -2 минор (half-up away from zero)
 *   - 0 micros → 0 minor (no allocation)
 */
export function microsToMinor(micros: bigint): bigint {
	if (micros >= 0n) {
		// Round half-up: add half-divisor before integer div.
		return (micros + MICROS_PER_MINOR / 2n) / MICROS_PER_MINOR
	}
	// Negatives: away from zero. -(|micros| + half) / divisor.
	return -((-micros + MICROS_PER_MINOR / 2n) / MICROS_PER_MINOR)
}

/**
 * Convert копейки → micros (exact, no rounding loss). Used when we need to
 * project a folio amount back into a booking-domain field for legacy storage.
 */
export function minorToMicros(minor: bigint): bigint {
	return minor * MICROS_PER_MINOR
}

/* ====================================================== folio balance math */

/**
 * Lines that contribute to the folio balance. Posted = active charge; void =
 * reversed; draft = not yet committed (does NOT affect balance).
 */
function isPostedLine(line: Pick<FolioLine, 'lineStatus'>): boolean {
	return line.lineStatus === 'posted'
}

/** Convert `FolioLine.amountMinor` (string-serialized bigint) to BigInt. */
function lineAmountMinor(line: Pick<FolioLine, 'amountMinor'>): bigint {
	return BigInt(line.amountMinor)
}

/**
 * Sum of posted-line amounts (charges minus reversals). Negative lines are
 * supported: discounts and partial reversals as compensating postings.
 *
 * Invariant #12 (folio-balance-conservation):
 *   stored balance MUST equal computeChargesMinor(lines)
 *     - sum(payments_applied)
 *     + sum(refunds_applied)
 *
 * Only `lineStatus === 'posted'` rows count. Draft rows are work-in-progress;
 * void rows are reversed (they SHOULD have a paired compensating row, but we
 * defensively also exclude them from the sum).
 */
export function computeChargesMinor(
	lines: ReadonlyArray<Pick<FolioLine, 'amountMinor' | 'lineStatus'>>,
): bigint {
	let sum = 0n
	for (const line of lines) {
		if (!isPostedLine(line)) continue
		sum += lineAmountMinor(line)
	}
	return sum
}

/**
 * Sum of accommodation-base amounts (lines flagged `isAccommodationBase=true`).
 * Used as the input to tourism-tax computation per НК РФ ch.33.1 — only
 * room-revenue contributes, NOT F&B / parking / extras.
 *
 * Anti-pattern guard: the tax line itself does NOT recurse into its own base,
 * which is why the Zod schema sets `isAccommodationBase=false` for category
 * `tourismTax`. We trust the flag here; service layer enforces it.
 */
export function computeAccommodationBaseMinor(
	lines: ReadonlyArray<Pick<FolioLine, 'amountMinor' | 'lineStatus' | 'isAccommodationBase'>>,
): bigint {
	let sum = 0n
	for (const line of lines) {
		if (!isPostedLine(line)) continue
		if (!line.isAccommodationBase) continue
		sum += lineAmountMinor(line)
	}
	return sum
}

/**
 * Compute tourism tax for a stay.
 *
 *   tax = max(base * rateBps / BPS_DIVISOR, FLOOR * nights)
 *
 * Floor is the legally-mandated ₽100/night minimum (НК РФ ст.418.5). For Сочи 2026
 * the rate is 2% (`200` bps); 5_000₽/night × 2% = 100₽ exactly, so the floor binds
 * for any rate ≤ ~₽5_000/night. Above that the proportional rate dominates.
 *
 * Precondition: nights ≥ 0 (zero-night bookings produce zero tax). Negative
 * nights are a programming error and throw to surface bugs early.
 */
export function computeTourismTaxMinor(args: {
	accommodationBaseMinor: bigint
	rateBps: number
	nights: number
}): bigint {
	if (args.nights < 0) {
		throw new RangeError(`nights must be >= 0, got ${args.nights}`)
	}
	if (args.rateBps < 0) {
		throw new RangeError(`rateBps must be >= 0, got ${args.rateBps}`)
	}
	if (args.accommodationBaseMinor < 0n) {
		throw new RangeError(`accommodationBaseMinor must be >= 0, got ${args.accommodationBaseMinor}`)
	}

	const proportional = (args.accommodationBaseMinor * BigInt(args.rateBps)) / BPS_DIVISOR
	const floor = TOURISM_TAX_FLOOR_MINOR_PER_NIGHT * BigInt(args.nights)
	return proportional > floor ? proportional : floor
}

/**
 * Compute folio balance from event projection.
 *
 *   balance = charges - paymentsApplied + refundsApplied
 *
 * `paymentsApplied` is the sum of payments where `payment.status` ∈
 * {succeeded, partially_refunded, refunded} AND `payment.folioId` = this folio.
 * (A failed/canceled payment does not reduce balance.)
 *
 * `refundsApplied` is the sum of refunds where `refund.status === 'succeeded'`.
 * (A pending or failed refund does not increase balance.)
 *
 * The caller is responsible for filtering. This pure helper does NOT know
 * about Payment / Refund entity shapes — it takes pre-summed bigints. This
 * makes the math testable in isolation.
 *
 * Invariant: `balance = 0` ⇔ folio is fully settled (terminal state SM #19).
 * Invariant: `balance < 0` ⇔ overpayment / credit balance to refund.
 */
export function computeBalanceMinor(args: {
	chargesMinor: bigint
	paymentsAppliedMinor: bigint
	refundsAppliedMinor: bigint
}): bigint {
	return args.chargesMinor - args.paymentsAppliedMinor + args.refundsAppliedMinor
}

/**
 * Apply a payment to a balance. `balance - paymentMinor`.
 *
 * Used in optimistic UI projection: the moment a payment moves to `succeeded`,
 * the folio balance shrinks by that amount. CDC consumer follows up with the
 * authoritative recompute from `computeBalanceMinor`.
 *
 * `paymentMinor` MUST be non-negative; payments don't create debt — refunds do.
 */
export function applyPayment(balance: bigint, paymentMinor: bigint): bigint {
	if (paymentMinor < 0n) {
		throw new RangeError(`paymentMinor must be >= 0, got ${paymentMinor}`)
	}
	return balance - paymentMinor
}

/**
 * Apply a refund to a balance. `balance + refundMinor`.
 *
 * `refundMinor` MUST be non-negative; the refund "increases the amount owed
 * back to the guest" semantically — so the folio balance grows toward zero
 * (or past it, into negative = overpayment territory).
 *
 * `refundMinor` MUST also be ≤ matching payment.capturedMinor at the
 * domain layer; this pure helper trusts the caller. Invariant #1 is enforced
 * elsewhere (refund-math.ts in M6.3).
 */
export function applyRefund(balance: bigint, refundMinor: bigint): bigint {
	if (refundMinor < 0n) {
		throw new RangeError(`refundMinor must be >= 0, got ${refundMinor}`)
	}
	return balance + refundMinor
}

/**
 * Test the cross-entity invariant: the stored `folio.balanceMinor` projection
 * must match the recomputed value from lines + payments + refunds. Used by
 * the integration test as a defense against CDC consumer drift.
 *
 * Returns `null` on match, or a structured diff for assertion messages.
 */
export function verifyBalanceConservation(args: {
	storedBalanceMinor: bigint
	lines: ReadonlyArray<Pick<FolioLine, 'amountMinor' | 'lineStatus'>>
	paymentsAppliedMinor: bigint
	refundsAppliedMinor: bigint
}): null | { stored: bigint; computed: bigint; delta: bigint } {
	const charges = computeChargesMinor(args.lines)
	const computed = computeBalanceMinor({
		chargesMinor: charges,
		paymentsAppliedMinor: args.paymentsAppliedMinor,
		refundsAppliedMinor: args.refundsAppliedMinor,
	})
	if (computed === args.storedBalanceMinor) return null
	return {
		stored: args.storedBalanceMinor,
		computed,
		delta: args.storedBalanceMinor - computed,
	}
}
