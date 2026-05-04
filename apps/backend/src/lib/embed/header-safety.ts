/**
 * Header value sanitization helpers for embed routes (M9.widget.6 / А4.3 D24).
 *
 * Per R2 Critical finding (Apr 2026):
 *   * Hono `c.header()` does not centrally reject CR/LF in values; relies
 *     on the underlying `Headers` class. On Node's undici-fetch path it
 *     does throw, but on edge runtimes (workerd/Bun) it does NOT
 *     consistently. Tenant operators who get to write
 *     `property.publicEmbedDomains` could craft an origin with embedded
 *     `\r\nSet-Cookie: ...` and inject arbitrary response headers when
 *     we splice it into `Content-Security-Policy: frame-ancestors {value}`.
 *   * Reference: GHSA-26PP-8WGV-HJVM, CVE-2026-29086 (Hono setCookie CRLF
 *     class — patched 4.12.4; we're 4.12.16 OK at framework level but
 *     defensive layer below stays critical for our application code).
 *
 * Defense-in-depth: ALL string values that originate (directly OR
 * transitively) from operator-controlled storage and flow into a response
 * header MUST pass `assertHeaderSafe` first. The function throws — never
 * silently truncate. Callers translate the throw to a 5xx so the response
 * never contains a partially-built compromised header.
 */

/**
 * Returns true if `value` contains any byte from the header-injection trio:
 * CR (0x0D), LF (0x0A), NUL (0x00). Implemented via `charCodeAt` loop —
 * not regex — to side-step Biome's `noControlCharactersInRegex` warning
 * AND to avoid Unicode-class subtleties. HTTP header byte rules are
 * byte-literal по RFC 7230 — there is no «match a control byte but only
 * if not in a Unicode emoji modifier» edge case.
 */
function containsHeaderInjectionByte(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code === 0x0d || code === 0x0a || code === 0x00) return true
	}
	return false
}

/**
 * Allowlist for embed-origin values: HTTPS URL with hostname-letters,
 * dots, hyphens, optional port. Non-ASCII hosts MUST be punycode-encoded
 * upstream (we never see Cyrillic here). Matches the same regex zod
 * uses on write-side (single source of truth).
 */
export const HTTPS_ORIGIN_REGEX = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i

/**
 * Throw if `value` contains CR / LF / NUL — header-splice classes.
 * @param value — string heading into a `c.header(name, value)` call
 * @param context — hint for log/throw message (`'CSP frame-ancestors'` etc)
 */
export function assertHeaderSafe(value: string, context: string): void {
	if (containsHeaderInjectionByte(value)) {
		throw new Error(`embed.routes: header-injection attempt in ${context}`)
	}
}

/**
 * Combined check: value matches HTTPS-origin allowlist AND has no header-
 * splice bytes. Returns the value unchanged so callers can chain
 * `c.header('X', assertOriginSafe(o, 'foo'))`.
 *
 * False-positive footprint: tightened-safe — Cyrillic hostnames,
 * non-HTTPS schemes, IP literals (without registrable domain) all
 * REJECTED. Operators must register punycode form. Documented in
 * onboarding pack (M11 carry-forward).
 */
export function assertOriginSafe(value: string, context: string): string {
	assertHeaderSafe(value, context)
	if (!HTTPS_ORIGIN_REGEX.test(value)) {
		throw new Error(`embed.routes: invalid origin format in ${context}`)
	}
	return value
}
