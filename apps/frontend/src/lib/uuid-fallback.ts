/**
 * crypto.randomUUID() fallback для LAN-HTTP scenarios.
 *
 * Sprint C 2026-05-22 — Round 5 expert flagged: sales demos via LAN
 * (192.168.x.x:5273) → non-secure context → `crypto.randomUUID` undefined → throws.
 * Polyfill через Math.random RFC4122 v4 — adequate для idempotency keys (НЕ для
 * security tokens где entropy critical).
 *
 * Web Crypto API canonical reference:
 *   https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID
 *
 * Secure context list (where crypto.randomUUID работает):
 *   - https://*
 *   - http://localhost / 127.0.0.1 / [::1]
 *   - http://*.localhost
 *
 * LAN HTTP (e.g. http://192.168.1.100:5273) → НЕ secure context → fallback path.
 */

export function generateUuid(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID()
	}
	// RFC 4122 v4 fallback via Math.random.
	// Acceptable для idempotency keys (Stripe canon — uniqueness, не secrecy).
	// НЕ использовать для session tokens, CSRF tokens, encryption keys.
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0
		const v = c === 'x' ? r : (r & 0x3) | 0x8
		return v.toString(16)
	})
}
