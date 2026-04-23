import { Optional } from '@ydbjs/value/optional'
import {
	Int32Type,
	Json,
	JsonType,
	TextType,
	Timestamp,
	TimestampType,
	Date as YdbDate,
} from '@ydbjs/value/primitive'

/**
 * Shared YDB type helpers for repo layer.
 *
 * Why these exist:
 *   - `@ydbjs/query` rejects raw JS `null` in tagged templates → must bind
 *     `Optional(null, Type)` instead. Preallocated singletons avoid per-call GC.
 *   - `@ydbjs/value` infers plain JS `Date` as `Datetime` (seconds), silently
 *     truncating milliseconds even when the column is `Timestamp`. Always wrap
 *     via `toTs` / `tsFromIso` to preserve ms precision.
 *   - YDB `Int32`/`Int64` columns deserialize as `number | bigint | null` in
 *     `@ydbjs/query`; `toNumber` normalizes to `number | null`, throwing if a
 *     value exceeds safe-integer range (would silently lose precision otherwise).
 *
 * See `project_ydb_specifics.md` memory items 9–11 for the full story.
 */

/** Typed null for nullable `Utf8` columns. */
export const NULL_TEXT = new Optional(null, new TextType())

/** Typed null for nullable `Int32` columns. */
export const NULL_INT32 = new Optional(null, new Int32Type())

/** Typed null for nullable `Timestamp` columns. */
export const NULL_TIMESTAMP = new Optional(null, new TimestampType())

/**
 * Typed null for nullable `Json` columns. Consumed internally by `toJson` —
 * NOT exported: external callers should use `toJson(null)` which returns this
 * singleton. Keeping the module's public surface minimal.
 */
const NULL_JSON = new Optional(null, new JsonType())

/**
 * Bind a `Date` value (or null) to a nullable `Timestamp` column (µs precision).
 * Bare `${date}` inference is `Datetime` and does NOT match a nullable
 * `Timestamp` column; YDB rejects with "Expected optional, ... but got:".
 * See `project_ydb_specifics.md` #14 for when to prefer this over UPSERT.
 */
export function timestampOpt(value: Date | null): Optional<TimestampType> {
	return value === null ? NULL_TIMESTAMP : new Optional(new Timestamp(value), new TimestampType())
}

/**
 * Wrap a JS object as a YDB `Json` primitive (server stores it as serialized
 * text — there's no struct inference for Json columns). Returns NULL_JSON if
 * the input is `null` or `undefined`.
 *
 * BigInt support: JS `JSON.stringify` throws on bigint by default; we serialize
 * them as decimal strings. Consumers on the read side must reconstruct them
 * with `BigInt(...)` for fields they know are bigint (e.g. Int64 micros
 * embedded in snapshots).
 */
export function toJson(value: unknown): Json | typeof NULL_JSON {
	if (value === null || value === undefined) return NULL_JSON
	return new Json(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

/** Normalize a YDB integer column value to a JS `number`. Throws on unsafe bigint. */
export function toNumber(v: number | bigint | null): number | null {
	if (v === null) return null
	if (typeof v === 'number') return v
	const n = Number(v)
	if (!Number.isSafeInteger(n)) {
		throw new Error(`YDB integer value ${v} exceeds Number.MAX_SAFE_INTEGER`)
	}
	return n
}

/** Wrap a JS `Date` as a YDB `Timestamp` (microsecond precision). */
export function toTs(d: Date): Timestamp {
	return new Timestamp(d)
}

/** Convert an ISO-8601 string back into a YDB `Timestamp`. Used on update() paths. */
export function tsFromIso(iso: string): Timestamp {
	return new Timestamp(new Date(iso))
}

/**
 * Convert an ISO-8601 `YYYY-MM-DD` string into a YDB `Date` (calendar day).
 *
 * Why the wrap: plain JS Date inference in `@ydbjs/value` is `Datetime`
 * (seconds), which YDB rejects for `Date`-typed columns with
 * `ERROR(1030): Type annotation`. Add the wrap or the INSERT fails.
 * See `project_ydb_specifics.md` #10 for the empirical lesson.
 */
export function dateFromIso(iso: string): YdbDate {
	return new YdbDate(new Date(iso))
}

/**
 * Money helpers — we store amounts as `Int64` "micros" (× 10^6) because
 * @ydbjs/value 6.x has no Decimal wrapper (see `project_ydb_specifics.md`
 * #13). 1 RUB = 1_000_000 micros. Follows Google Ads / Google Cloud Billing
 * / Stripe conventions.
 */
const MICROS_PER_UNIT = 1_000_000n

/** Convert a decimal string like "1234.56" or "0.000001" to Int64 micros. */
export function decimalToMicros(decimal: string): bigint {
	if (!/^-?\d+(\.\d+)?$/.test(decimal)) {
		throw new Error(`Invalid decimal string: ${decimal}`)
	}
	const negative = decimal.startsWith('-')
	const abs = negative ? decimal.slice(1) : decimal
	const [whole, fraction = ''] = abs.split('.') as [string, string?]
	// Pad/truncate fraction to exactly 6 digits (round towards zero on truncation).
	const fracPadded = `${fraction}000000`.slice(0, 6)
	const micros = BigInt(whole) * MICROS_PER_UNIT + BigInt(fracPadded)
	return negative ? -micros : micros
}

/** Convert Int64 micros to a decimal string with up to 6 fractional digits. */
export function microsToDecimal(micros: bigint): string {
	const negative = micros < 0n
	const abs = negative ? -micros : micros
	const whole = abs / MICROS_PER_UNIT
	const fraction = abs % MICROS_PER_UNIT
	const fractionStr =
		fraction === 0n ? '' : `.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`
	return `${negative ? '-' : ''}${whole}${fractionStr}`
}
