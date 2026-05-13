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
}

export type SendEmailResult =
	| { kind: 'sent'; messageId: string }
	| { kind: 'permanent'; reason: string }
	| { kind: 'transient'; reason: string }

export interface EmailAdapter {
	send(input: SendEmailInput): Promise<SendEmailResult>
}
