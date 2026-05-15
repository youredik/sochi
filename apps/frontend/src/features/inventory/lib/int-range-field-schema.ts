/**
 * `intRangeFieldSchema` — Zod string-schema mirror to a server-side integer
 * range bound. Used by inventory admin forms so a successful client parse
 * implies a successful server parse — no silent 400 on submit.
 *
 * Surfaces FieldError messages in the order a user encounters mistakes:
 *
 *   ''           → «Введите число»
 *   'abc' / '1.5'/ '-' → «Целое число»
 *   '-5' (min=1) → «Не меньше 1»   (regex permits a leading minus so we
 *                                    can surface a precise range message,
 *                                    not a misleading format error)
 *   '21' (max=20)→ «Не больше 20»
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
 */
import { z } from 'zod'

export function intRangeFieldSchema(opts: { min: number; max: number }) {
	return z
		.string()
		.min(1, 'Введите число')
		.regex(/^-?\d+$/, 'Целое число')
		.refine((v) => Number(v) >= opts.min, `Не меньше ${opts.min}`)
		.refine((v) => Number(v) <= opts.max, `Не больше ${opts.max}`)
}
