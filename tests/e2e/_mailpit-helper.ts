import type { APIRequestContext } from '@playwright/test'

/**
 * Mailpit HTTP API helpers for e2e tests — the magic-link-only auth canon
 * (per `[[auth-passwordless-canon]]` 2026-05-13) needs the test to fetch
 * the verify URL out of the dev SMTP inbox and visit it programmatically.
 *
 * Mailpit ports per docker-compose.yml:
 *   - 1125 SMTP (backend sends here)
 *   - 8125 HTTP API (e2e queries here)
 *
 * Reference: github.com/axllent/mailpit `API/v1` (verified ≥ 2026-05-13).
 *   - GET /api/v1/search?query=to:user@example.com&limit=1 — search messages
 *   - GET /api/v1/message/{id} — full message body (incl. raw HTML)
 *   - DELETE /api/v1/messages — purge all (called at setup-start so the
 *     latest-message lookup is unambiguous)
 *
 * The helper polls because the backend sends async (small delay between
 * BA `signIn.magicLink` response and the SMTP receipt). Default 10s ceiling
 * — anything slower indicates a real backend regression worth surfacing.
 */

const MAILPIT_BASE = process.env.PLAYWRIGHT_MAILPIT_URL ?? 'http://localhost:8125'

interface MailpitMessage {
	ID: string
	From: { Address: string; Name: string }
	To: Array<{ Address: string; Name: string }>
	Subject: string
}

interface MailpitSearchResponse {
	messages: MailpitMessage[]
	messages_count: number
	total: number
}

interface MailpitMessageDetails {
	ID: string
	HTML: string
	Text: string
}

/**
 * Wait for a magic-link email to land for `email` and return the embedded
 * verify URL. Polls Mailpit's search API every 200ms up to `timeoutMs`.
 *
 * The verify URL pattern is the absolute BA endpoint:
 *   `http://localhost:8787/api/auth/magic-link/verify?token=…&callbackURL=…`
 * Extract via regex anchored on the BA path — robust against email-template
 * cosmetic changes which would otherwise break stricter substring matching.
 */
export async function getMagicLinkUrl(
	request: APIRequestContext,
	email: string,
	timeoutMs = 10_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs
	const query = `to:${email}`
	while (Date.now() < deadline) {
		const searchRes = await request.get(
			`${MAILPIT_BASE}/api/v1/search?query=${encodeURIComponent(query)}&limit=1`,
		)
		if (searchRes.ok()) {
			const body = (await searchRes.json()) as MailpitSearchResponse
			const latest = body.messages[0]
			if (latest) {
				const detailsRes = await request.get(`${MAILPIT_BASE}/api/v1/message/${latest.ID}`)
				if (detailsRes.ok()) {
					const details = (await detailsRes.json()) as MailpitMessageDetails
					const url = extractMagicLinkUrl(details.HTML || details.Text)
					if (url) return url
				}
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	throw new Error(`Magic-link email для ${email} не пришёл за ${timeoutMs}мс — Mailpit пуст`)
}

/**
 * Purge ALL Mailpit messages — call at e2e-setup-start so the next
 * `getMagicLinkUrl` for a fresh email lookups against a clean inbox. Без
 * этого старые seed messages могут collide со свежими test emails
 * (`to:user@example.com` query is case-insensitive AND domain-wide).
 */
export async function purgeMailpit(request: APIRequestContext): Promise<void> {
	await request.delete(`${MAILPIT_BASE}/api/v1/messages`)
}

/** Extract the first magic-link verify URL out of an email body string. */
function extractMagicLinkUrl(body: string): string | null {
	// BA verify endpoint pattern: /api/auth/magic-link/verify?... Anchor on
	// the path так any host/port (8787 dev / staging / prod) matches.
	const match = body.match(/https?:\/\/[^\s"'<>]+\/api\/auth\/magic-link\/verify\?[^\s"'<>]+/)
	return match ? match[0] : null
}
