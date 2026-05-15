/**
 * `intRangeFieldSchema` — Zod string-schema mirror to a server-side integer
 * range bound. Shared across feature folders (inventory, setup, bookings)
 * — moved from `features/inventory/lib/` к `lib/forms/` 2026-05-15 once
 * 3rd consumer arrived (per `[[no-half-measures]]`: feature-boundary dies
 * when generic primitive used cross-feature).
 *
 * Surfaces FieldError messages in the order a user encounters mistakes:
 *
 *   ''           → «Введите число»  (when `allowEmpty` is false / unset)
 *   'abc' / '1.5'/ '-' → «Целое число»
 *   '-5' (min=1) → «Не меньше 1»   (regex permits a leading minus so we
 *                                    can surface a precise range message,
 *                                    not a misleading format error)
 *   '21' (max=20)→ «Не больше 20»
 *
 * `allowEmpty: true` reshapes для optional fields (e.g. `rooms-bulk-add-sheet`
 * floor field: «Если пусто — этаж не присваивается»). Empty string passes
 * silently; non-empty must still satisfy format + range.
 *
 * The field's storage stays a `string` (so `<Input type="number">` empty
 * state — value '' — remains representable); the form's submit path
 * converts via `Number(value)` after validation passes.
 *
 * HTML5 `min` / `max` attrs are decorative hints only — the browser does
 * NOT enforce range when the surrounding `<form noValidate>`. This helper
 * is the load-bearing client gate; it must mirror the matching server
 * Zod bound (e.g. `roomType.ts` `occupancySchema = z.coerce.number().int()
 * .min(1).max(20)`).
 *
 * `intRangeNumberValidator` — TanStack-Form-compatible validator function
 * for fields that store `number | undefined` (when `<Input type="number">`
 * is wrapped in a component that coerces via `valueAsNumber` — see
 * `features/forms/text-field.tsx`). Same 4-message canon, different
 * input shape.
 */
import { z } from 'zod'

export function intRangeFieldSchema(opts: { min: number; max: number; allowEmpty?: boolean }) {
	const allowEmpty = opts.allowEmpty ?? false
	// When `allowEmpty`, each refine returns true для empty strings, so the
	// chain passes silently. Non-empty values flow through the full
	// format+range check identically to the required variant.
	const passIfEmpty = (predicate: (v: string) => boolean) => (v: string) =>
		(allowEmpty && v === '') || predicate(v)

	return z
		.string()
		.refine(
			passIfEmpty((v) => v.length > 0),
			'Введите число',
		)
		.refine(
			passIfEmpty((v) => /^-?\d+$/.test(v)),
			'Целое число',
		)
		.refine(
			passIfEmpty((v) => Number(v) >= opts.min),
			`Не меньше ${opts.min}`,
		)
		.refine(
			passIfEmpty((v) => Number(v) <= opts.max),
			`Не больше ${opts.max}`,
		)
}

/**
 * `intRangeNumberValidator` — same 4-message canon as `intRangeFieldSchema`,
 * но input is `number | undefined` (TanStack Form field that stores
 * coerced `valueAsNumber`). Returns error message string or `undefined`
 * (validator-canonical "pass").
 */
export function intRangeNumberValidator(opts: { min: number; max: number }) {
	return (value: number | undefined): string | undefined => {
		if (typeof value !== 'number' || !Number.isFinite(value)) return 'Введите число'
		if (!Number.isInteger(value)) return 'Целое число'
		if (value < opts.min) return `Не меньше ${opts.min}`
		if (value > opts.max) return `Не больше ${opts.max}`
		return undefined
	}
}
