/**
 * Demo deployment in-process SMS inbox — captures outgoing SMS per recipient
 * so the frontend `DemoSmsInboxPanel` (future) can render the OTP / booking
 * confirmation inline. Symmetric к `DemoInboxAdapter` (email canon since
 * 2026-05-13 `feedback_demo_inbox_canon`).
 *
 * **Capture-only**: this adapter does NOT actually transmit SMS. In a demo
 * deployment the prospect types whatever phone they want; sending real SMS
 * к random typed phones would:
 *   - Burn cost (~2-5 ₽ per SMS, cumulative)
 *   - Expose к SMS pumping fraud ($71B 2026 global losses per Infobip)
 *   - Violate 152-ФЗ if guest didn't actually consent
 *   - Risk RBL listing / sender ID reputation damage
 *
 * The captured body appears в the UI panel — that IS the «delivery» mechanism
 * for demo. Real production adapter lives behind `SMS_PROVIDER=yandex_cloud_cns`
 * (future P3.live) с opt-in verified-destination phone canon (AWS End User
 * Messaging Sandbox pattern).
 *
 * **Ring buffer per recipient** + **global LRU** + **TTL** — exactly mirrors
 * email DemoInboxAdapter constants для consistency. Bounded memory: prospect
 * spamming the form can't blow up RAM.
 *
 * **Production safety**: this class is constructed ONLY when
 * `env.DEMO_DEPLOYMENT === true`. Symmetric к email canon.
 */

import { normalizePhoneE164 } from './sms-adapter.types.ts'
import type { SendSmsInput, SendSmsResult, SmsAdapter } from './sms-adapter.types.ts'

export const MAX_PER_RECIPIENT = 20
export const MAX_TOTAL_RECIPIENTS = 500
/** SMS lifetime — typical OTP / booking confirmation expires in 5 min. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000

export interface CapturedSms {
	readonly to: string
	readonly body: string
	readonly capturedAt: Date
}

interface CapturedSmsMutable {
	to: string
	body: string
	capturedAt: Date
}

interface DemoInboxSmsAdapterOptions {
	/** Override `Date.now` for test determinism. */
	readonly now?: () => number
	/** Override TTL for tests. */
	readonly ttlMs?: number
}

export class DemoInboxSmsAdapter implements SmsAdapter {
	private readonly perRecipient = new Map<string, CapturedSmsMutable[]>()
	private readonly now: () => number
	private readonly ttlMs: number
	private nextId = 1

	constructor(opts: DemoInboxSmsAdapterOptions = {}) {
		this.now = opts.now ?? (() => Date.now())
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
	}

	async send(input: SendSmsInput): Promise<SendSmsResult> {
		// Validate + normalize E.164. Bad format = permanent error (no retry).
		const normalized = normalizePhoneE164(input.to)
		if (normalized === null) {
			return {
				kind: 'permanent',
				reason: 'phone is not valid E.164 format',
			}
		}
		if (input.body.length === 0) {
			return {
				kind: 'permanent',
				reason: 'sms body cannot be empty',
			}
		}

		const captured: CapturedSmsMutable = {
			to: normalized,
			body: input.body,
			capturedAt: new Date(this.now()),
		}

		// LRU-on-insert: evict oldest recipient wholesale when over total cap.
		if (!this.perRecipient.has(normalized) && this.perRecipient.size >= MAX_TOTAL_RECIPIENTS) {
			const oldestKey = this.perRecipient.keys().next().value
			if (oldestKey !== undefined) {
				this.perRecipient.delete(oldestKey)
			}
		}

		const bucket = this.perRecipient.get(normalized) ?? []
		bucket.push(captured)
		while (bucket.length > MAX_PER_RECIPIENT) {
			bucket.shift()
		}
		this.perRecipient.set(normalized, bucket)

		const id = `demo-sms-${this.nextId++}`
		return { kind: 'sent', messageId: id }
	}

	/**
	 * Latest non-expired SMS for the recipient, or `null` if no fresh capture
	 * exists. Used by `/api/public/demo/sms-inbox` polling endpoint.
	 */
	getLatest(to: string): CapturedSms | null {
		const normalized = normalizePhoneE164(to)
		if (normalized === null) return null
		const bucket = this.perRecipient.get(normalized)
		if (!bucket || bucket.length === 0) return null
		const cutoff = this.now() - this.ttlMs
		for (let i = bucket.length - 1; i >= 0; i -= 1) {
			const entry = bucket[i]
			if (entry && entry.capturedAt.getTime() >= cutoff) {
				return { ...entry }
			}
		}
		return null
	}

	/** Reset all captures — for tests / refresh-cron parity. */
	clear(): void {
		this.perRecipient.clear()
	}

	/** Diagnostic: number of distinct recipient buckets currently stored. */
	recipientCount(): number {
		return this.perRecipient.size
	}
}

/**
 * Process-global singleton — initialized once at boot if `DEMO_DEPLOYMENT=true`.
 * Symmetric к email DemoInboxAdapter singleton pattern.
 */
let demoInboxSmsSingleton: DemoInboxSmsAdapter | null = null

export function getDemoInboxSmsIfActive(): DemoInboxSmsAdapter | null {
	return demoInboxSmsSingleton
}

export function initDemoInboxSms(opts: DemoInboxSmsAdapterOptions = {}): DemoInboxSmsAdapter {
	if (demoInboxSmsSingleton === null) {
		demoInboxSmsSingleton = new DemoInboxSmsAdapter(opts)
	}
	return demoInboxSmsSingleton
}

/** Test-only reset. */
export function __resetDemoInboxSms(): void {
	demoInboxSmsSingleton = null
}
