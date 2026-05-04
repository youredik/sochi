/**
 * Standard Webhooks signature verifier — M10 / A7.1 / D25-D25.c.
 *
 * Per `plans/m10_canonical.md` §2:
 *   - D25: Standard Webhooks spec (Svix-led community spec, 2026 canonical для new).
 *     Format: `Webhook-Id` + `Webhook-Timestamp` + `Webhook-Signature: v1,<base64>`
 *     (multi-key rotation built-in via space-separated). NOT GitHub
 *     `X-Hub-Signature-256` (no replay protection).
 *   - D25.b: CE 1.0.2 has NO signature extension → sign opaque body bytes.
 *   - D25.c: IP-allowlist primary для non-HMAC channels (ЮKassa parity).
 *
 * Canonical signed string: `${webhookId}.${timestamp}.${rawBodyUtf8}`.
 *
 * Replay window: 300s default (Stripe + Standard Webhooks consensus 2026).
 * Multi-key kid rotation via `webhook_secret` table (NOT JWKS).
 *
 * Body MUST be raw bytes — NOT parsed-then-restringified JSON. In Hono use
 * `c.req.raw.arrayBuffer()` BEFORE any `.json()`.
 *
 * @see https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const DEFAULT_REPLAY_WINDOW_SECONDS = 300

/** Webhook secret variant — supports active + previous (sliding-window rotation). */
export interface WebhookSecretSlot {
	readonly kid: string
	readonly secret: string
	readonly status: 'active' | 'previous' | 'expired'
}

export interface SignatureVerificationInput {
	readonly webhookId: string
	readonly timestamp: string
	readonly signature: string
	readonly rawBody: Uint8Array | Buffer | string
	readonly nowSeconds: number
}

export type VerifyResult =
	| { readonly ok: true; readonly kid: string | null }
	| { readonly ok: false; readonly reason: SignatureFailure }

export type SignatureFailure =
	| 'missing_id'
	| 'missing_timestamp'
	| 'missing_signature'
	| 'malformed_timestamp'
	| 'replay_window_exceeded'
	| 'malformed_signature'
	| 'no_matching_secret'
	| 'invalid_signature'

/**
 * Compute base64 HMAC-SHA256 over canonical signed string.
 *
 * Canonical input format (Standard Webhooks spec):
 *   `${webhookId}.${timestamp}.${rawBody}`
 *
 * Body MUST be raw bytes; do NOT canonicalize/strip whitespace/CRLF.
 */
export function computeSignature(input: {
	webhookId: string
	timestamp: string
	rawBody: Uint8Array | Buffer | string
	secret: string
}): string {
	const bodyBuf =
		typeof input.rawBody === 'string'
			? Buffer.from(input.rawBody, 'utf-8')
			: Buffer.from(input.rawBody)
	const signedString = Buffer.concat([
		Buffer.from(`${input.webhookId}.${input.timestamp}.`, 'utf-8'),
		bodyBuf,
	])
	return createHmac('sha256', input.secret).update(signedString).digest('base64')
}

/**
 * Verify inbound webhook signature.
 *
 * Performs:
 *   1. Header presence + format check (id, timestamp, signature)
 *   2. Replay window enforcement (`|now - timestamp| ≤ window`)
 *   3. Multi-key candidate verification with `crypto.timingSafeEqual`
 *
 * @returns `{ ok: true, kid }` if any candidate secret matched
 *          (kid identifies which secret matched — for telemetry on rotation).
 *          `{ ok: false, reason }` describing exact failure mode.
 *
 * **Security**: returns same failure mode for invalid_signature regardless of
 * which secret tried, preventing kid enumeration via timing differences.
 */
export function verifySignature(
	input: SignatureVerificationInput,
	secrets: ReadonlyArray<WebhookSecretSlot>,
	opts: { replayWindowSeconds?: number } = {},
): VerifyResult {
	const replayWindow = opts.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS

	if (input.webhookId.length === 0) return { ok: false, reason: 'missing_id' }
	if (input.timestamp.length === 0) return { ok: false, reason: 'missing_timestamp' }
	if (input.signature.length === 0) return { ok: false, reason: 'missing_signature' }

	const ts = Number.parseInt(input.timestamp, 10)
	if (!Number.isFinite(ts) || String(ts) !== input.timestamp) {
		return { ok: false, reason: 'malformed_timestamp' }
	}

	const skewSeconds = Math.abs(input.nowSeconds - ts)
	if (skewSeconds > replayWindow) return { ok: false, reason: 'replay_window_exceeded' }

	// Standard Webhooks signature header format: `v1,<base64>` (or multiple
	// space-separated for kid rotation). We support both single + multi.
	const sigVariants = input.signature
		.split(' ')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)

	if (sigVariants.length === 0) return { ok: false, reason: 'malformed_signature' }

	// Active + previous secrets are candidates (expired excluded).
	const candidates = secrets.filter((s) => s.status === 'active' || s.status === 'previous')
	if (candidates.length === 0) return { ok: false, reason: 'no_matching_secret' }

	for (const sig of sigVariants) {
		const parts = sig.split(',')
		if (parts.length !== 2) continue
		const [version, providedB64] = parts
		if (version !== 'v1') continue
		if (providedB64 === undefined || providedB64.length === 0) continue

		for (const slot of candidates) {
			const expectedB64 = computeSignature({
				webhookId: input.webhookId,
				timestamp: input.timestamp,
				rawBody: input.rawBody,
				secret: slot.secret,
			})
			if (constantTimeCompareBase64(expectedB64, providedB64)) {
				return { ok: true, kid: slot.kid }
			}
		}
	}

	return { ok: false, reason: 'invalid_signature' }
}

/**
 * Constant-time base64 comparison via `crypto.timingSafeEqual`.
 *
 * `timingSafeEqual` requires equal-length buffers — wrap в try/catch returning
 * false на length mismatch (cannot accidentally false-positive).
 */
function constantTimeCompareBase64(a: string, b: string): boolean {
	const aBuf = Buffer.from(a, 'base64')
	const bBuf = Buffer.from(b, 'base64')
	if (aBuf.length !== bBuf.length) return false
	try {
		return timingSafeEqual(aBuf, bBuf)
	} catch {
		return false
	}
}

/**
 * IP allowlist primary path for non-HMAC channels (D25.c).
 *
 * Trust `chain[len-1]` (last hop set by our LB), NOT `chain[0]` (spoofable).
 * Returns true if extracted client IP matches any allowed CIDR.
 *
 * For our purpose: ЮKassa-style channels (no HMAC) + Yandex.Travel (no documented
 * signature). For HMAC channels (Ostrovok ETG TBD), use `verifySignature`.
 *
 * **NOTE**: this is a thin wrapper. Production CIDR matching should use
 * `ip-cidr` or similar lib for IPv4 + IPv6. For now, exact-match string list
 * (plenty for known ЮKassa + YT IP ranges, expand to CIDR при first-tenant onboard).
 */
export function ipAllowlistVerify(input: {
	xForwardedFor: string | undefined
	allowedIps: ReadonlyArray<string>
}): boolean {
	if (input.allowedIps.length === 0) return false
	const xff = input.xForwardedFor
	if (typeof xff !== 'string' || xff.length === 0) return false
	const chain = xff
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
	if (chain.length === 0) return false
	// Trust last hop (set by our LB) to avoid spoofing via X-Forwarded-For
	// chain manipulation by upstream attacker. For chain length 1 (direct LB
	// hop), this is also the canonical client IP per RFC 7239.
	const trustedSourceIp = chain[chain.length - 1]
	if (trustedSourceIp === undefined) return false
	return input.allowedIps.includes(trustedSourceIp)
}
