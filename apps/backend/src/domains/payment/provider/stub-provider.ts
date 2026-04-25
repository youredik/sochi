/**
 * StubPaymentProvider — production-grade test/dev implementation of
 * `PaymentProvider`. Used when `PAYMENT_PROVIDER=stub` (default in dev,
 * pre-integration period before YooKassa/T-Kassa/SBP impls land).
 *
 * NOT a smoke-test stub — this runs in production-quality contracts:
 *   - Idempotent: same `providerIdempotencyKey` → same response (replay-safe).
 *   - Deterministic: no random, no clock-call inside the provider impl.
 *     Caller (service) injects `now()` via constructor for tests; default
 *     uses `Date.now()` at injection time. We DON'T put randomness in the
 *     transition logic — randomness lives only in id generation.
 *   - Synchronous semantics: `initiate` returns `succeeded` immediately
 *     (autocapture path, like SBP). Mirrors the SBP rail in canon's #17.
 *   - Webhook verification: stable header `X-Stub-Signature: stub-ok`,
 *     dedupKey from a request-id field. Defensive path so future code
 *     can swap in a real verifier without callsite changes.
 *
 * The 100ms artificial delay is intentional UX simulation — surfaces
 * loading-state in the demo UI without forcing real provider integration.
 */

import type {
	PaymentInitiateRequest,
	PaymentProvider,
	PaymentProviderCapabilities,
	PaymentProviderSnapshot,
	PaymentRefundRequest,
	RefundProviderSnapshot,
	VerifiedWebhookEvent,
} from '@horeca/shared'
import { newId } from '@horeca/shared'

/**
 * Replay cache: maps `providerIdempotencyKey` → snapshot returned the first
 * time the key was seen. In real provider impls this lives at the provider
 * server side; for the stub we keep it in-memory per process, scoped to a
 * provider instance.
 *
 * Important: this is NOT for cross-process / cross-instance dedup —
 * production idempotency lives in the `payment.idempotencyKey` UNIQUE index.
 * The stub-side cache only ensures THIS provider instance returns identical
 * snapshots on retry, mimicking how a real provider behaves.
 */
type ReplayCache = Map<string, PaymentProviderSnapshot>
type RefundReplayCache = Map<string, RefundProviderSnapshot>

const STUB_CAPABILITIES: PaymentProviderCapabilities = Object.freeze({
	partialCapture: true,
	holdPeriodHours: 0, // synchronous, no separate hold
	sbpNative: false,
	fiscalization: 'none',
	supportsCorrection: false,
})

/** Default delay (ms) — intentional UX simulation. Configurable for tests. */
const DEFAULT_DELAY_MS = 100

/** Stable HMAC-equivalent for stub webhook verification. */
const STUB_SIGNATURE_HEADER = 'x-stub-signature'
const STUB_SIGNATURE_VALUE = 'stub-ok'

export type StubPaymentProviderOptions = {
	/**
	 * Delay before resolving each operation (simulates network latency).
	 * Set to 0 in tests for fast assertions; default = 100ms in dev.
	 */
	delayMs?: number
	/**
	 * Clock injection. Caller passes a function returning the current Date;
	 * defaults to `() => new Date()`. Tests use a frozen clock for assertions.
	 */
	now?: () => Date
}

export function createStubPaymentProvider(opts: StubPaymentProviderOptions = {}): PaymentProvider {
	const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS
	const now = opts.now ?? (() => new Date())
	const initiateCache: ReplayCache = new Map()
	const refundCache: RefundReplayCache = new Map()

	async function delay(): Promise<void> {
		if (delayMs <= 0) return
		await new Promise((resolve) => setTimeout(resolve, delayMs))
	}

	return {
		code: 'stub',
		capabilities: STUB_CAPABILITIES,

		async initiate(req: PaymentInitiateRequest): Promise<PaymentProviderSnapshot> {
			await delay()
			// Replay-safety: same idempotency key → return identical snapshot.
			const cached = initiateCache.get(req.providerIdempotencyKey)
			if (cached) return cached
			// Synchronous success path (mirrors SBP autocapture).
			const snapshot: PaymentProviderSnapshot = {
				providerPaymentId: newId('payment'),
				status: 'succeeded',
				authorizedMinor: req.amountMinor,
				capturedMinor: req.amountMinor,
				confirmationUrl: null,
				holdExpiresAt: null,
				failureReason: null,
			}
			initiateCache.set(req.providerIdempotencyKey, snapshot)
			return snapshot
		},

		async capture(
			providerPaymentId: string,
			amountMinor: bigint | null,
		): Promise<PaymentProviderSnapshot> {
			await delay()
			// Stub flow auto-captures on initiate, so capture is a no-op-style
			// reconciliation: returns the post-capture snapshot. Real providers
			// would track per-id state; for stub we re-derive from the cache.
			const cached = findInitiatedById(initiateCache, providerPaymentId)
			if (!cached) {
				throw new Error(
					`Stub provider: capture against unknown providerPaymentId ${providerPaymentId}`,
				)
			}
			// Partial capture: clamp captured to min(amountMinor, authorized).
			// `null` means capture full authorized.
			const captureAmount = amountMinor ?? cached.authorizedMinor
			if (captureAmount < 0n) {
				throw new RangeError(`Stub capture amount must be >= 0, got ${captureAmount}`)
			}
			if (captureAmount > cached.authorizedMinor) {
				throw new RangeError(
					`Stub capture ${captureAmount} exceeds authorized ${cached.authorizedMinor}`,
				)
			}
			return {
				...cached,
				status: 'succeeded',
				capturedMinor: captureAmount,
			}
		},

		async cancel(
			providerPaymentId: string,
		): Promise<PaymentProviderSnapshot | RefundProviderSnapshot> {
			await delay()
			const cached = findInitiatedById(initiateCache, providerPaymentId)
			if (!cached) {
				throw new Error(
					`Stub provider: cancel against unknown providerPaymentId ${providerPaymentId}`,
				)
			}
			// Stub auto-captures on initiate, so cancel is polymorphic-as-refund
			// (same as T-Kassa cancel-after-capture).
			if (cached.capturedMinor > 0n) {
				const refundKey = `cancel:${providerPaymentId}`
				const existing = refundCache.get(refundKey)
				if (existing) return existing
				const refund: RefundProviderSnapshot = {
					providerRefundId: newId('refund'),
					status: 'succeeded',
					amountMinor: cached.capturedMinor,
					failureReason: null,
				}
				refundCache.set(refundKey, refund)
				return refund
			}
			// Pre-capture cancel path (not reachable for stub today, but typed).
			return {
				...cached,
				status: 'canceled',
			}
		},

		async refund(req: PaymentRefundRequest): Promise<RefundProviderSnapshot> {
			await delay()
			// Replay-safety: same providerIdempotencyKey → identical refund.
			const cached = refundCache.get(req.providerIdempotencyKey)
			if (cached) return cached
			if (req.amountMinor < 0n) {
				throw new RangeError(`Stub refund amount must be >= 0, got ${req.amountMinor}`)
			}
			const refund: RefundProviderSnapshot = {
				providerRefundId: newId('refund'),
				status: 'succeeded',
				amountMinor: req.amountMinor,
				failureReason: null,
			}
			refundCache.set(req.providerIdempotencyKey, refund)
			return refund
		},

		async verifyWebhook(headers: Headers, rawBody: Uint8Array): Promise<VerifiedWebhookEvent> {
			const sig = headers.get(STUB_SIGNATURE_HEADER)
			if (sig !== STUB_SIGNATURE_VALUE) {
				throw new Error(
					`Stub webhook signature mismatch: header '${STUB_SIGNATURE_HEADER}' must equal '${STUB_SIGNATURE_VALUE}'`,
				)
			}
			// Body must be valid JSON with a `requestId` field — that's our dedupKey.
			let payload: unknown
			try {
				const text = new TextDecoder().decode(rawBody)
				payload = JSON.parse(text)
			} catch (err) {
				throw new Error(`Stub webhook body is not valid JSON: ${(err as Error).message}`)
			}
			if (
				typeof payload !== 'object' ||
				payload === null ||
				typeof (payload as { requestId?: unknown }).requestId !== 'string'
			) {
				throw new Error(`Stub webhook body must include a string 'requestId' for dedup`)
			}
			const requestId = (payload as { requestId: string }).requestId
			// For stub, the "subject" inference is left to the caller — we surface a
			// minimal verified envelope with the dedupKey and the rest reconstructed
			// from initiateCache state.
			const providerPaymentId = (payload as { providerPaymentId?: string }).providerPaymentId
			if (typeof providerPaymentId !== 'string') {
				throw new Error(`Stub webhook body must include 'providerPaymentId'`)
			}
			const cached = findInitiatedById(initiateCache, providerPaymentId)
			if (!cached) {
				throw new Error(`Stub webhook references unknown providerPaymentId ${providerPaymentId}`)
			}
			return {
				dedupKey: `stub:${requestId}`,
				providerCode: 'stub',
				subject: { kind: 'payment', snapshot: cached },
				receivedAt: now().toISOString(),
			}
		},

		async releaseResidualHold(_providerPaymentId: string): Promise<void> {
			// Stub auto-captures and never holds. No-op for parity with ЮKassa
			// (also auto-releases) — only T-Kassa requires explicit release.
		},
	}
}

/**
 * Lookup a snapshot in the in-memory cache by providerPaymentId.
 * Used because the cache is keyed by idempotencyKey, not provider id.
 */
function findInitiatedById(
	cache: ReplayCache,
	providerPaymentId: string,
): PaymentProviderSnapshot | undefined {
	for (const snapshot of cache.values()) {
		if (snapshot.providerPaymentId === providerPaymentId) return snapshot
	}
	return undefined
}
