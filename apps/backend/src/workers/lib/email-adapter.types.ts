/**
 * Email adapter contract — shared DTOs and interface used by every concrete
 * email impl (`PostboxAdapter`, `MailpitAdapter`, `StubAdapter`,
 * `DemoInboxAdapter`). Lives in its own module so concrete adapters can
 * import the contract without forming a circular dependency with each other
 * (`postbox-adapter.ts` ↔ `demo-inbox-adapter.ts`).
 *
 * Error classification (research §2 — anti-pattern §9 #2):
 *   - 2xx                       → `{ kind: 'sent', messageId }`
 *   - 4xx MessageRejected /
 *     InvalidParameterValue /
 *     MailFromDomainNotVerified /
 *     AccessDenied              → `{ kind: 'permanent', reason }` — no retry
 *   - 429 Throttling /
 *     5xx / network              → `{ kind: 'transient', reason }` — retry
 *
 * Worker translates `permanent` → `status='failed'` immediately, `transient`
 * → bump retryCount + nextAttemptAt with exponential backoff. Без this
 * classifier the dispatcher wastes Postbox quota retrying permanent errors.
 */

/**
 * Email attachment payload (M9.widget.5 / A3.2.b).
 *
 * Used для .ics calendar invite + future PDF voucher attachments. Adapters
 * encode through their canonical send paths:
 *   - PostboxAdapter (SES v2): Content.Simple.Attachments[] с base64 RawContent
 *   - MailpitAdapter (SMTP): MIME multipart/mixed boundary
 *   - StubAdapter: stored verbatim для test assertions
 *   - DemoInboxAdapter: ignored (not used в magic-link flows)
 */
export interface EmailAttachment {
	/** Filename presented к recipient (e.g. `booking-BK-2026-A1B2C3.ics`). */
	filename: string
	/** Raw content (UTF-8 string для text/calendar; base64 для binary). */
	content: string
	/** MIME type (e.g. `text/calendar; method=PUBLISH; charset=utf-8`). */
	contentType: string
}

export interface SendEmailInput {
	from: string
	to: string
	subject: string
	html: string
	text: string
	attachments?: ReadonlyArray<EmailAttachment>
	/**
	 * Reply-To header (RFC 5322). Когда recipient жмёт «Reply», письмо
	 * направится к этому адресу вместо `from`. Используется для transactional
	 * emails где `from = noreply@…` (отскок) — Reply-To указывает на живой
	 * `hi@…` inbox. 2026 canon: всегда указывать Reply-To если from = noreply.
	 */
	replyTo?: string
	/**
	 * List-Unsubscribe header (RFC 8058 + Gmail/Yahoo 2024+ canon).
	 * Format: comma-separated mailto/https URIs in angle brackets, e.g.
	 *   `<mailto:unsubscribe@sepshn.ru?subject=unsub>, <https://demo.sepshn.ru/unsubscribe?token=...>`
	 * Plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` для RFC 8058
	 * one-click unsubscribe (set by adapter automatically когда listUnsubscribe
	 * present). For transactional не строго обязательно но defensively включаем.
	 */
	listUnsubscribe?: string
}

export type SendEmailResult =
	| { kind: 'sent'; messageId: string }
	| { kind: 'permanent'; reason: string }
	| { kind: 'transient'; reason: string }

export interface EmailAdapter {
	send(input: SendEmailInput): Promise<SendEmailResult>
}
