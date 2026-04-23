import { Optional } from '@ydbjs/value/optional'
import { Int32Type, TextType, Timestamp } from '@ydbjs/value/primitive'

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
