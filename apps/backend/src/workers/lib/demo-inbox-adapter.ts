import { extractMagicLinkUrl } from '@horeca/shared'
import type { EmailAdapter, SendEmailInput, SendEmailResult } from './email-adapter.types.ts'

/**
 * Demo deployment in-process inbox — captures outgoing emails per recipient
 * so the frontend `DemoInboxPanel` can render the magic-link verify URL inline
 * (publicly-hosted demo runs friction-free per `[[demo_strategy]]`; prospect
 * shouldn't need an email account to evaluate the product).
 *
 * **Capture-only**: this adapter does NOT actually transmit anything. In a
 * demo deployment the user types whatever email they want; sending real
 * email to random typed addresses would create spam reports / RBL listings
 * and corrupt the sender domain reputation. The captured URL appears in the
 * panel — that IS the «delivery» mechanism for demo.
 *
 * **Ring buffer per recipient**: each `to` email keeps the last
 * `MAX_PER_RECIPIENT` captures in FIFO order. Older entries are dropped to
 * bound memory growth — a prospect spamming the form can't blow up RAM.
 * Across-recipients cap is `MAX_TOTAL_RECIPIENTS` distinct email keys; when
 * the cap is exceeded the LEAST-RECENTLY-INSERTED recipient is evicted
 * wholesale. Both numbers are conservatively low — demo is for individual
 * prospect evaluation, не a load test.
 *
 * **TTL** matches the BA magic-link expiry (5 min) plus a 60-second slack —
 * captures older than that auto-expire from the listing. Beyond the visual
 * UX of «свежая ссылка», TTL also enforces canon: the URL stored alongside
 * a 6-minute window is consistent с BA's verify-endpoint refusing tokens
 * older than 5 min. No persistent leak.
 *
 * **Production safety**: this class is constructed ONLY when
 * `env.DEMO_DEPLOYMENT === true` (see `createEmailAdapter` factory). The
 * paired `/api/v1/public/demo/inbox` route is mounted conditionally on the
 * same env. Mismatch shouldn't be possible — both read same env.
 */

export const MAX_PER_RECIPIENT = 20
export const MAX_TOTAL_RECIPIENTS = 500
export const DEFAULT_TTL_MS = 6 * 60 * 1000 // 5-min BA magic-link + 1-min slack

export interface CapturedMessage {
	readonly to: string
	readonly subject: string
	readonly capturedAt: Date
	/** Magic-link verify URL extracted from html/text body, or null if absent. */
	readonly magicLinkUrl: string | null
}

interface CapturedMessageMutable {
	to: string
	subject: string
	capturedAt: Date
	magicLinkUrl: string | null
}

interface DemoInboxAdapterOptions {
	/** Override `Date.now` для test determinism. Defaults to `Date.now`. */
	readonly now?: () => number
	/** Override TTL для tests; defaults to `DEFAULT_TTL_MS`. */
	readonly ttlMs?: number
	/**
	 * Optional downstream adapter (e.g. PostboxAdapter) для DUAL-WRITE mode:
	 * capture внутри DemoInbox (panel UI rendering) + forward к real adapter
	 * (transmit real email). 2026-05-22 canon: demo + real email одновременно
	 * (prospect видит link в panel UI + real users получают email).
	 *
	 * Без downstream — capture-only (старый pure demo mode).
	 */
	readonly downstream?: EmailAdapter
}

export class DemoInboxAdapter implements EmailAdapter {
	private readonly perRecipient = new Map<string, CapturedMessageMutable[]>()
	private readonly now: () => number
	private readonly ttlMs: number
	private readonly downstream?: EmailAdapter
	private nextId = 1

	constructor(opts: DemoInboxAdapterOptions = {}) {
		this.now = opts.now ?? (() => Date.now())
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
		if (opts.downstream !== undefined) {
			this.downstream = opts.downstream
		}
	}

	async send(input: SendEmailInput): Promise<SendEmailResult> {
		const key = normalizeEmail(input.to)
		const captured: CapturedMessageMutable = {
			to: input.to,
			subject: input.subject,
			capturedAt: new Date(this.now()),
			magicLinkUrl: extractMagicLinkUrl(input.html) ?? extractMagicLinkUrl(input.text),
		}

		// Evict oldest recipient wholesale when over total cap (LRU-on-insert).
		if (!this.perRecipient.has(key) && this.perRecipient.size >= MAX_TOTAL_RECIPIENTS) {
			const oldestKey = this.perRecipient.keys().next().value
			if (oldestKey !== undefined) {
				this.perRecipient.delete(oldestKey)
			}
		}

		const bucket = this.perRecipient.get(key) ?? []
		bucket.push(captured)
		// Drop oldest within recipient bucket when over per-recipient cap.
		while (bucket.length > MAX_PER_RECIPIENT) {
			bucket.shift()
		}
		this.perRecipient.set(key, bucket)

		// Dual-write mode: forward к downstream adapter (e.g. PostboxAdapter)
		// для real email delivery. DemoInboxPanel UI работает через capture
		// выше, real recipient получает email через downstream. 2026-05-22 canon.
		// Если downstream errors → return его result (caller знает что real
		// delivery failed). Capture в DemoInbox уже сделана — UI всё равно
		// покажет link.
		//
		// **RFC 2606/6761 reserved-domain shield** (security canon 2026-05-22):
		// demo seed создаёт fake guests с `@example.com` адресами для UI
		// fixtures. Без этого фильтра каждый container boot forwards 32+ writes
		// в Postbox → hard bounces → quota burn (наблюдалось 5 deploys × 32
		// = 160 emails / quota 200 daily free tier). Reserved domains никогда
		// не разрешимы в real DNS — forwarding gratuitously жжёт reputation +
		// quota. Skip downstream BUT return synthetic success так чтобы
		// bookingService NotificationDispatcher не retry'ил. Capture в UI
		// остаётся для testing visibility.
		if (this.downstream !== undefined && !isReservedTestDomain(input.to)) {
			return this.downstream.send(input)
		}

		const id = `demo-inbox-${this.nextId++}`
		return { kind: 'sent', messageId: id }
	}

	/**
	 * Latest non-expired captured message for the recipient, or `null` if no
	 * unexpired capture exists. Used by `/api/v1/public/demo/inbox`.
	 */
	getLatest(to: string): CapturedMessage | null {
		const key = normalizeEmail(to)
		const bucket = this.perRecipient.get(key)
		if (!bucket || bucket.length === 0) return null
		const cutoff = this.now() - this.ttlMs
		// Walk back-to-front: latest entries first, return first non-expired.
		for (let i = bucket.length - 1; i >= 0; i -= 1) {
			const entry = bucket[i]
			if (entry && entry.capturedAt.getTime() >= cutoff) {
				return { ...entry }
			}
		}
		return null
	}

	/** Reset all captures — for tests / refresh-cron parity in future. */
	clear(): void {
		this.perRecipient.clear()
	}

	/** Diagnostic: number of distinct recipient buckets currently stored. */
	recipientCount(): number {
		return this.perRecipient.size
	}
}

/**
 * Canonical email-normalization for inbox keying. Lower-cases + trims; does
 * NOT do RFC-5321 local-part case-sensitivity preservation because demo
 * mailbox semantics treat case-insensitivity as the operator-friendly
 * default (prospect types `User@Example.com` once, polls с `user@example.com`
 * — both must hit the same bucket).
 */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase()
}

/**
 * RFC 2606 (BCP 32) + RFC 6761 reserved-for-testing domain detection.
 *
 * These domains are **guaranteed never deliverable** in real DNS by IANA:
 *   - Second-level: `example.com`, `example.net`, `example.org`
 *   - TLDs: `.test`, `.example`, `.invalid`, `.localhost`
 *
 * Sending к таким адресам:
 *   1. ВСЕГДА hard-bounce → MTA reputation damage
 *   2. Жжёт Postbox quota gratuitously (наблюдалось 2026-05-22:
 *      demo seed × N deploys = 160+ writes / 200 daily free quota)
 *   3. Может попасть в анти-spam blocklists некоторых receivers
 *
 * Used by `DemoInboxAdapter.send` для gate downstream forward — capture
 * в UI panel остаётся (test visibility), но real send skipped.
 *
 * Source: tools.ietf.org/html/rfc2606 + rfc6761.
 */
export function isReservedTestDomain(email: string): boolean {
	const at = email.lastIndexOf('@')
	if (at === -1) return false
	const domain = email
		.slice(at + 1)
		.trim()
		.toLowerCase()
	if (domain === '') return false
	// Exact second-level matches per RFC 2606 §3.
	if (domain === 'example.com' || domain === 'example.net' || domain === 'example.org') {
		return true
	}
	// Reserved TLDs per RFC 2606 §2 + RFC 6761 §6.3.
	// Match как точное domain (e.g. `localhost`) или suffix (e.g. `foo.test`).
	const reservedTlds = ['test', 'example', 'invalid', 'localhost']
	for (const tld of reservedTlds) {
		if (domain === tld || domain.endsWith(`.${tld}`)) return true
	}
	return false
}
