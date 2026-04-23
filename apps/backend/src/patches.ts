/**
 * Global runtime patches applied at process boot. Import this module ONCE,
 * at the top of `app.ts`, before any code that renders JSON responses.
 *
 * Currently just BigInt serialization: JSON spec has no bigint literal and
 * `JSON.stringify` throws on bigint by default. We keep bigints in memory
 * for arithmetic (money micros, IDs) and stringify at the HTTP boundary —
 * matches Google Ads / Stripe / Mews API conventions for integer-based
 * money + 64-bit identifiers.
 */

declare global {
	interface BigInt {
		toJSON(): string
	}
}
BigInt.prototype.toJSON = function () {
	return this.toString()
}

export {}
