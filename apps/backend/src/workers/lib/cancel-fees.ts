/**
 * Pure helpers for cancellation/no-show fee posting (M7.A.4).
 *
 * Per Apaleo / Cloudbeds canon: fee amounts are **snapshotted at booking creation**
 * via `booking.cancellationFee` / `booking.noShowFee` (Json columns, schema
 * `bookingFeeSnapshotSchema`). Editing rate plan AFTER booking does NOT
 * retroactively change the snapshot — guest sees the policy that was active
 * when they booked. CDC handler reads the snapshot, posts a folioLine.
 *
 * **Idempotency**: deterministic folioLine.id `cancelFee_<bookingId>` or
 * `noShowFee_<bookingId>` — PK collision = no-op. Status flap (cancel → uncancel
 * → recancel — illegal per SM but defensive) won't double-post.
 *
 * **Fee = 0**: rate plan with no penalty (fully flexible, BAR-flex). Skip the
 * post entirely (no $0 lines per accounting cleanliness).
 */

export function cancelFeeLineId(bookingId: string): string {
	return `cancelFee_${bookingId}`
}

export function noShowFeeLineId(bookingId: string): string {
	return `noShowFee_${bookingId}`
}

/**
 * Convert booking-snapshot fee in micros (×10^6) to folioLine minor (kopecks
 * for RUB). Both representations are safe bigint; division never throws. If
 * micros is 0 or negative (defensive — snapshot validation requires ≥0n in
 * `bigIntMicrosSchema`), returns 0n so caller short-circuits.
 *
 *   1 RUB = 1_000_000 micros = 100 kopecks → divide by 10_000.
 */
export function feeMicrosToMinor(micros: bigint): bigint {
	if (micros <= 0n) return 0n
	return micros / 10_000n
}
