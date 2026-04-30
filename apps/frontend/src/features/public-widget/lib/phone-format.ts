/**
 * Phone format helpers — RU-fixed locale via libphonenumber-js (M9.widget.4 / D1).
 *
 * Per `plans/m9_widget_4_canonical.md` §5 + §16 freshness recheck (2026-04-30):
 *   - `react-phone-number-input` REJECTED — over-shoots для RU-fixed widget;
 *     country selector + flag не нужны (Сочи = RU-only).
 *   - Raw `libphonenumber-js` AsYouType('RU') sufficient.
 *
 * `formatRu` wraps AsYouType — produces «+7 (965) 123-45-67» style как user
 * types. Use в onChange handler controlled input. Idempotent — safe to call
 * with already-formatted value.
 *
 * `isValidRuPhone` strict-validates E.164 (must be valid mobile / landline RU
 * number, not just regex match). Used at submit boundary, not per-keystroke.
 *
 * `toE164` extracts canonical E.164 form (`+79651234567`) for backend submit.
 * Frontend wire format = E.164 (matches widgetGuestInputSchema.phone min/max).
 */

import { AsYouType, isValidPhoneNumber, parsePhoneNumberWithError } from 'libphonenumber-js'

/**
 * Format raw input через AsYouType('RU'). Returns formatted display value.
 * Empty input → empty string. Caller tracks raw vs formatted state separately.
 *
 * Prefix normalization: AsYouType expects `+7` (international) or `8` (RU
 * national prefix) — bare leading `7` без `+` treated as 7-digit local. Senior
 * UX choice — pre-normalize digits-only input starting с `7` или `8` к `+7`,
 * чтобы guest typing «79651234567» сразу получал «+7 (965) 123-45-67».
 */
export function formatRu(value: string): string {
	if (!value) return ''
	const trimmed = value.trim()
	const digitsOnly = trimmed.replace(/[^\d+]/g, '')
	let normalised = trimmed
	if (digitsOnly.startsWith('8') && !trimmed.startsWith('+')) {
		// Russian national prefix → international
		normalised = `+7${digitsOnly.slice(1)}`
	} else if (digitsOnly.startsWith('7') && !trimmed.startsWith('+')) {
		normalised = `+${digitsOnly}`
	}
	return new AsYouType('RU').input(normalised)
}

/**
 * Strict E.164 validation для RU numbers. Returns true только если число
 * проходит libphonenumber-js metadata check (длина, prefix, area code).
 */
export function isValidRuPhone(value: string): boolean {
	if (!value || value.length < 5) return false
	try {
		return isValidPhoneNumber(value, 'RU')
	} catch {
		return false
	}
}

/**
 * Extract canonical E.164 form (+7XXXXXXXXXX). Returns null если invalid.
 */
export function toE164(value: string): string | null {
	try {
		const parsed = parsePhoneNumberWithError(value, 'RU')
		if (!parsed?.isValid()) return null
		return parsed.number // E.164 by default in libphonenumber-js v1.10+
	} catch {
		return null
	}
}
