import { extractMagicLinkUrl } from '@horeca/shared'
import type { sql as SQL } from '../../db/index.ts'
import { toTs } from '../../db/ydb-helpers.ts'
import type { EmailAdapter, SendEmailInput, SendEmailResult } from './email-adapter.types.ts'
import { isReservedTestDomain } from './reserved-test-ranges.ts'

type SqlInstance = typeof SQL

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
	/**
	 * Round 7 v3 2026-05-25 — optional YDB client для multi-instance race
	 * elimination. Когда set, captures persisted к `demoInboxCapture` table
	 * (migration 0075). All container instances share same state — поллер
	 * sees captures regardless of which instance handled the send.
	 *
	 * Без sql → in-process `Map<email, captures[]>` (legacy single-instance
	 * mode, sufficient для local dev tests где multi-instance не is at play).
	 *
	 * Production wiring: `createEmailAdapter` factory passes sql when
	 * `DEMO_DEPLOYMENT=true` (см. postbox-adapter.ts).
	 */
	readonly sql?: SqlInstance
}

export class DemoInboxAdapter implements EmailAdapter {
	private readonly perRecipient = new Map<string, CapturedMessageMutable[]>()
	private readonly now: () => number
	private readonly ttlMs: number
	private readonly downstream?: EmailAdapter
	private readonly sql?: SqlInstance
	private nextId = 1

	constructor(opts: DemoInboxAdapterOptions = {}) {
		this.now = opts.now ?? (() => Date.now())
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
		if (opts.downstream !== undefined) {
			this.downstream = opts.downstream
		}
		if (opts.sql !== undefined) {
			this.sql = opts.sql
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

		// Round 7 v3 2026-05-25 — YDB persist eliminates multi-instance race.
		// Когда sql provided, write к demoInboxCapture (TTL P6M auto-cleanup).
		// All container instances share state. См. migration 0075.
		// Note: `toTs(Date)` обязателен — без него @ydbjs/value infers Datetime
		// (seconds), теряет ms precision + SELECT comparison ловит type mismatch
		// (см. project_ydb_specifics.md item 10).
		if (this.sql) {
			await this.sql`
				INSERT INTO demoInboxCapture (email, capturedAt, magicLinkUrl, subject)
				VALUES (${key}, ${toTs(captured.capturedAt)}, ${captured.magicLinkUrl}, ${captured.subject})
			`
		} else {
			// In-process Map fallback — local dev / tests / single-instance mode.
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
		}

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
	 *
	 * Optional `after` parameter (Round 7 v3 fix 2026-05-25 — E2 smoke race):
	 * returns only captures с capturedAt STRICTLY greater than `after`. Mirrors
	 * since-based polling canon (Mailosaur, Mailhook). Race-free для repeat-
	 * send scenarios где BA could reuse same magic-link token (identical URL)
	 * — каноничный URL-based filter would loop forever; time-based filter
	 * captures NEW send irrespective of URL identity.
	 */
	async getLatest(to: string, after?: Date): Promise<CapturedMessage | null> {
		const key = normalizeEmail(to)
		const cutoff = new Date(this.now() - this.ttlMs)
		const afterMs = after?.getTime()

		if (this.sql) {
			// YDB query — TTL handles cutoff at storage layer, но also filter
			// для defensive consistency с in-process Map semantic.
			// `toTs()` обязателен — без него Date → Datetime (seconds) type
			// mismatch против Timestamp column. См. project_ydb_specifics.md
			// item 10. Conditional WHERE → две отдельных query вместо inline
			// template fragment (не supported by @ydbjs/query template tag).
			type CapturedRow = {
				email: string
				capturedAt: Date
				magicLinkUrl: string | null
				subject: string
			}
			const result = after
				? await this.sql<CapturedRow[]>`
					SELECT email, capturedAt, magicLinkUrl, subject
					FROM demoInboxCapture
					WHERE email = ${key}
					  AND capturedAt >= ${toTs(cutoff)}
					  AND capturedAt > ${toTs(after)}
					ORDER BY capturedAt DESC
					LIMIT 1
				`
						.isolation('snapshotReadOnly')
						.idempotent(true)
				: await this.sql<CapturedRow[]>`
					SELECT email, capturedAt, magicLinkUrl, subject
					FROM demoInboxCapture
					WHERE email = ${key}
					  AND capturedAt >= ${toTs(cutoff)}
					ORDER BY capturedAt DESC
					LIMIT 1
				`
						.isolation('snapshotReadOnly')
						.idempotent(true)
			const [rows = []] = result
			const row = rows[0]
			if (!row) return null
			return {
				to: row.email,
				subject: row.subject,
				capturedAt: row.capturedAt,
				magicLinkUrl: row.magicLinkUrl,
			}
		}

		// In-process Map fallback
		const bucket = this.perRecipient.get(key)
		if (!bucket || bucket.length === 0) return null
		const cutoffMs = cutoff.getTime()
		// Walk back-to-front: latest entries first, return first non-expired.
		for (let i = bucket.length - 1; i >= 0; i -= 1) {
			const entry = bucket[i]
			if (!entry) continue
			const entryMs = entry.capturedAt.getTime()
			if (entryMs < cutoffMs) continue // expired
			if (afterMs !== undefined && entryMs <= afterMs) continue // not new enough
			return { ...entry }
		}
		return null
	}

	/** Reset all captures — for tests / refresh-cron parity in future. */
	async clear(): Promise<void> {
		this.perRecipient.clear()
		if (this.sql) {
			await this.sql`DELETE FROM demoInboxCapture`
		}
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

// `isReservedTestDomain` moved к `./reserved-test-ranges.ts` — shared seam
// for outbound-side-effect-discipline canon 2026-05-22 (also consumed by
// `PostboxAdapter` для defense-in-depth + future SMS-live adapter via the
// sibling `isReservedTestPhone` predicate). Re-export сохраняет backward
// compat с existing test imports.
export { isReservedTestDomain } from './reserved-test-ranges.ts'
