/**
 * Inbox idempotency primitive — M10 / A7.1 / D11+D12 (stankoff-v2 028 borrow).
 *
 * Per `plans/m10_canonical.md` §2:
 *   - D11: CloudEvents 1.0.2 (source, id) tuple = canonical idempotency key
 *   - D12: UNIQUE(source, eventId) inside booking-create transaction
 *
 * Pure helpers — DB I/O lives в repo layer (channel-inbox.repo.ts будет в A7.5).
 *
 * **Stankoff-v2 028 borrow (per D31)**: composite PK + 7-day TTL + bodyHash
 * для tamper detection.
 */

import { createHash } from 'node:crypto'

/**
 * Compute SHA-256 hash of raw body bytes для tamper detection. Used to detect
 * replay-attack class «same eventId, different body» — indicates malicious replay.
 */
export function computeBodyHash(rawBody: Uint8Array | Buffer | string): string {
	const buf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : Buffer.from(rawBody)
	return createHash('sha256').update(buf).digest('hex')
}

/**
 * Inbox row shape (matches migration 0053_inbox.sql).
 */
export interface InboxRow {
	readonly source: string
	readonly eventId: string
	readonly tenantId: string
	readonly channelId: string
	readonly eventType: string
	readonly receivedAt: Date
	readonly bodyHash: string
	readonly signatureKid: string | null
	readonly status: 'received' | 'processing' | 'processed' | 'failed'
	readonly responseJson: unknown
	readonly retryCount: number
}

export type InboxLookupResult =
	| { readonly kind: 'new' }
	| { readonly kind: 'duplicate'; readonly cached: InboxRow }
	| { readonly kind: 'tampered'; readonly originalBodyHash: string }

/**
 * Decide processing action based on lookup of `(source, eventId)` tuple +
 * body-hash check.
 *
 * **Three outcomes:**
 *   - `new` — never seen → caller proceeds к INSERT + handler
 *   - `duplicate` — seen before AND body matches → caller returns cached `responseJson`
 *   - `tampered` — seen before BUT body differs → caller MUST 400 (replay attack
 *     OR sender bug). Surface tampering для admin alert.
 *
 * Pure function — caller fetches existing row (если any) + delivers decision.
 */
export function classifyIncoming(input: {
	existing: InboxRow | null
	currentBodyHash: string
}): InboxLookupResult {
	if (input.existing === null) return { kind: 'new' }
	if (input.existing.bodyHash === input.currentBodyHash) {
		return { kind: 'duplicate', cached: input.existing }
	}
	return { kind: 'tampered', originalBodyHash: input.existing.bodyHash }
}
