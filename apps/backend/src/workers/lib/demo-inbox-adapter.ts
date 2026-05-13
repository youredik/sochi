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
}

export class DemoInboxAdapter implements EmailAdapter {
	private readonly perRecipient = new Map<string, CapturedMessageMutable[]>()
	private readonly now: () => number
	private readonly ttlMs: number
	private nextId = 1

	constructor(opts: DemoInboxAdapterOptions = {}) {
		this.now = opts.now ?? (() => Date.now())
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
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
