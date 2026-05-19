/**
 * SMS adapter contract — shared DTOs + interface used by every concrete SMS
 * implementation (`DemoInboxSmsAdapter` для public demo, future
 * `YandexCloudNotificationSmsAdapter` для production).
 *
 * Symmetric к `email-adapter.types.ts` pattern (existing canon since 2026-05-13
 * `feedback_demo_inbox_canon`). Result classifier mirrors email:
 *
 *   - 2xx                       → `{ kind: 'sent', messageId }`
 *   - 4xx-permanent            → `{ kind: 'permanent', reason }` — no retry
 *   - 429 / 5xx / network      → `{ kind: 'transient', reason }` — retry
 *
 * SMS-specific anti-patterns avoided (per Q2 2026 research 2026-05-19):
 *   - NO promotional content в interface — `body` is transactional-only
 *     (ФЗ-38 ст.18 transactional exception applies; promotional content =
 *     prior consent required, scope creep risk → adapter does NOT support it)
 *   - NO blocklist approach (premium-rate prefixes meaningfully change weekly);
 *     country allowlist enforced в concrete adapter, NOT in interface
 *   - 152-ФЗ phone PII: callers MUST log via `maskPhoneE164()` (last-2 visible)
 */

/** E.164-format SMS recipient. Strict regex `+<7-15 digits>`. */
export interface SendSmsInput {
	/** Recipient phone в E.164 format (e.g. `+79991234567`). */
	to: string
	/**
	 * SMS body — transactional content only (booking confirmations, OTPs,
	 * delivery notifications). Promotional content prohibited at adapter level.
	 * Latin: 160 chars per part; Cyrillic: 70 chars per part — Yandex Cloud
	 * Notification Service auto-splits.
	 */
	body: string
}

export type SendSmsResult =
	| { kind: 'sent'; messageId: string }
	| { kind: 'permanent'; reason: string }
	| { kind: 'transient'; reason: string }

export interface SmsAdapter {
	send(input: SendSmsInput): Promise<SendSmsResult>
}

// -----------------------------------------------------------------------------
// Phone normalization + validation helpers
// -----------------------------------------------------------------------------

/**
 * E.164 format regex: leading `+`, 7-15 digits (ITU-T E.164 spec).
 * Defense against header injection / control chars / non-E.164 input.
 */
const E164_PATTERN = /^\+\d{7,15}$/

/**
 * Normalize phone — strip whitespace/parens/dashes, expect remaining to match
 * E.164. Returns null on invalid input (caller treats как validation failure
 * — 400 BAD_PHONE response в route).
 */
export function normalizePhoneE164(input: string): string | null {
	const cleaned = input.replace(/[\s\-()]/g, '')
	return E164_PATTERN.test(cleaned) ? cleaned : null
}

/**
 * Mask phone для logs / UI labels (152-ФЗ PII canon).
 * `+79991112233` → `+7 *** *** ** 33` (RU 11-digit format)
 * `+12025550100` → `+12025550100` masked к `+1 **** **** 00` (US-like)
 * Generic: keep `+` and country code (1-3 digits) + last 2, mask middle.
 */
export function maskPhoneE164(phone: string): string {
	if (!E164_PATTERN.test(phone)) return '<invalid-phone>'
	const digits = phone.slice(1) // strip leading '+'
	if (digits.length <= 4) return phone // too short к meaningfully mask
	// Country code heuristic: RU/USA/CA/UK/most-EU = 1-3 digits.
	// Simpler: keep first 1 + last 2, mask rest with *.
	const cc = digits[0]
	const last2 = digits.slice(-2)
	const middleLen = digits.length - 3
	return `+${cc}${'*'.repeat(middleLen)}${last2}`
}
