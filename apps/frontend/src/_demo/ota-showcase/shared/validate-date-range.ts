/**
 * Round 12 self-review SR-4 + SR-7 — shared date-range validator для demo
 * search forms (Yandex + Ostrovok + future channels).
 *
 * Previously logic was copy-pasted в Yandex + Ostrovok search pages →
 * duplication root cause: if rules drift, both sides need manual sync.
 * Self-review canon `feedback_self_review_finds_halfmeasure` mandates
 * factor-out at second site.
 *
 * SR-7 — guards against invalid date strings (`'2030-13-45'`, empty, etc).
 * Previous inline impl let `Date.parse('2030-13-45') === NaN` through because
 * `NaN <= X` is always false. Hard-rejected via `Number.isNaN` here.
 */

export type DateRangeValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: 'empty' | 'invalid' | 'order' }

/**
 * Validate that both `checkIn` and `checkOut` are non-empty ISO YYYY-MM-DD
 * strings AND `checkOut > checkIn`. Returns reason-tagged failure для UX
 * messaging.
 *
 * Both inputs go through `Date.parse`; non-finite results (`Invalid Date`)
 * map to `'invalid'` rather than `'order'` (the old `NaN <= X === false`
 * gap that let bad dates through).
 */
export function validateDateRange(checkIn: string, checkOut: string): DateRangeValidation {
	if (checkIn.length === 0 || checkOut.length === 0) return { ok: false, reason: 'empty' }
	const inMs = Date.parse(checkIn)
	const outMs = Date.parse(checkOut)
	if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) return { ok: false, reason: 'invalid' }
	if (outMs <= inMs) return { ok: false, reason: 'order' }
	return { ok: true }
}

/**
 * Russian-localized error message по reason. Centralized so Yandex +
 * Ostrovok search pages render identical UX strings (UX consistency canon).
 */
export function dateRangeErrorMessage(reason: 'empty' | 'invalid' | 'order'): string {
	switch (reason) {
		case 'empty':
			return 'Заполните обе даты — заезд и выезд.'
		case 'invalid':
			return 'Дата указана некорректно. Используйте формат ДД.ММ.ГГГГ.'
		case 'order':
			return 'Дата выезда должна быть позже даты заезда.'
	}
}
