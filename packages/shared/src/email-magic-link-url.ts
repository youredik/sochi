/**
 * Magic-link URL extraction helper.
 *
 * Better Auth's magic-link plugin embeds the verify URL into the outgoing
 * email body (HTML `<a href>` + plain-text variants). This helper extracts
 * the FIRST occurrence so e2e tests (Mailpit fetch flow per
 * `[[auth-passwordless-canon]]`) и future support tooling parse it from a
 * single canonical place.
 *
 * Pattern anchors on the BA endpoint path `/api/auth/magic-link/verify?…`
 * — host/port-agnostic so dev (`localhost:8787`) / staging / prod URLs all
 * match. URL terminates at whitespace OR HTML-attribute terminators
 * (`"`, `'`, `<`, `>`) so embedded inside `<a href="…">` or text-only
 * variants both extract cleanly.
 *
 * Returns `null` when no magic-link URL is present (legitimate when the
 * email is a non-auth notification OR the search hit the wrong message).
 */
export function extractMagicLinkUrl(body: string): string | null {
	const match = body.match(/https?:\/\/[^\s"'<>]+\/api\/auth\/magic-link\/verify\?[^\s"'<>]+/)
	return match ? match[0] : null
}
