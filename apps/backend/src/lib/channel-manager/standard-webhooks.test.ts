/**
 * Standard Webhooks signature verifier — strict tests SW1-SW8 (M10 / A7.1 / D25).
 *
 * Per plan §5: «8 SW tests (timing-safe verify / 300s replay reject / multi-key
 * rotation kid resolution / wrong-length sig / truncated sig / prefix-only
 * attack / body raw bytes NOT parsed JSON / IP-allowlist fallback)».
 *
 * Strict-test canon: adversarial signatures (truncated / wrong-length / prefix-only),
 * exact failure-mode reason string, multi-key rotation grace.
 */

import { describe, expect, it } from 'vitest'
import {
	computeSignature,
	ipAllowlistVerify,
	verifySignature,
	type WebhookSecretSlot,
} from './standard-webhooks.ts'

const NOW = 1_700_000_000
const SECRET_ACTIVE = 'whsec_active_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const SECRET_PREVIOUS = 'whsec_previous_xxxxxxxxxxxxxxxxxxxxxxxxxxxx'

const ACTIVE: WebhookSecretSlot = { kid: 'k1', secret: SECRET_ACTIVE, status: 'active' }
const PREVIOUS: WebhookSecretSlot = { kid: 'k0', secret: SECRET_PREVIOUS, status: 'previous' }
const EXPIRED: WebhookSecretSlot = { kid: 'k_exp', secret: 'irrelevant', status: 'expired' }

function signedHeaders(input: {
	secret: string
	webhookId: string
	timestamp: number
	body: string
}) {
	const sig = computeSignature({
		webhookId: input.webhookId,
		timestamp: String(input.timestamp),
		rawBody: input.body,
		secret: input.secret,
	})
	return {
		webhookId: input.webhookId,
		timestamp: String(input.timestamp),
		signature: `v1,${sig}`,
		rawBody: input.body,
	}
}

describe('verifySignature — happy path', () => {
	it('[SW1] valid signature with active secret → ok with kid', () => {
		const headers = signedHeaders({
			secret: SECRET_ACTIVE,
			webhookId: 'msg_001',
			timestamp: NOW,
			body: '{"hello":"world"}',
		})
		const result = verifySignature({ ...headers, nowSeconds: NOW }, [ACTIVE, PREVIOUS, EXPIRED])
		expect(result).toEqual({ ok: true, kid: 'k1' })
	})

	it('[SW1.b] valid with previous secret (rotation grace) → ok with previous kid', () => {
		const headers = signedHeaders({
			secret: SECRET_PREVIOUS,
			webhookId: 'msg_002',
			timestamp: NOW,
			body: '{"x":1}',
		})
		const result = verifySignature({ ...headers, nowSeconds: NOW }, [ACTIVE, PREVIOUS])
		expect(result).toEqual({ ok: true, kid: 'k0' })
	})

	it('[SW1.c] expired secret rejected even if signature matches', () => {
		const headers = signedHeaders({
			secret: EXPIRED.secret,
			webhookId: 'msg_003',
			timestamp: NOW,
			body: '{}',
		})
		const result = verifySignature({ ...headers, nowSeconds: NOW }, [EXPIRED])
		// Only EXPIRED in the candidates → no_matching_secret (none has active|previous)
		expect(result).toEqual({ ok: false, reason: 'no_matching_secret' })
	})
})

describe('verifySignature — replay window', () => {
	it('[SW2] |now - timestamp| > 300s → replay_window_exceeded', () => {
		const headers = signedHeaders({
			secret: SECRET_ACTIVE,
			webhookId: 'msg_replay',
			timestamp: NOW - 301,
			body: '{}',
		})
		const result = verifySignature({ ...headers, nowSeconds: NOW }, [ACTIVE])
		expect(result).toEqual({ ok: false, reason: 'replay_window_exceeded' })
	})

	it('[SW2.b] timestamp slightly in future (clock-skew) within window → ok', () => {
		const headers = signedHeaders({
			secret: SECRET_ACTIVE,
			webhookId: 'msg_skew',
			timestamp: NOW + 60, // 1 min ahead
			body: '{}',
		})
		const result = verifySignature({ ...headers, nowSeconds: NOW }, [ACTIVE])
		expect(result.ok).toBe(true)
	})

	it('[SW2.c] custom replayWindow (600s for slow RU channels)', () => {
		const headers = signedHeaders({
			secret: SECRET_ACTIVE,
			webhookId: 'msg_slow',
			timestamp: NOW - 500,
			body: '{}',
		})
		const result = verifySignature({ ...headers, nowSeconds: NOW }, [ACTIVE], {
			replayWindowSeconds: 600,
		})
		expect(result.ok).toBe(true)
	})
})

describe('verifySignature — adversarial malformed', () => {
	it('[SW3] missing webhookId → missing_id', () => {
		const result = verifySignature(
			{ webhookId: '', timestamp: '100', signature: 'v1,abc', rawBody: '{}', nowSeconds: 100 },
			[ACTIVE],
		)
		expect(result).toEqual({ ok: false, reason: 'missing_id' })
	})

	it('[SW3.b] missing timestamp → missing_timestamp', () => {
		const result = verifySignature(
			{ webhookId: 'msg', timestamp: '', signature: 'v1,abc', rawBody: '{}', nowSeconds: 100 },
			[ACTIVE],
		)
		expect(result).toEqual({ ok: false, reason: 'missing_timestamp' })
	})

	it('[SW3.c] missing signature → missing_signature', () => {
		const result = verifySignature(
			{ webhookId: 'msg', timestamp: '100', signature: '', rawBody: '{}', nowSeconds: 100 },
			[ACTIVE],
		)
		expect(result).toEqual({ ok: false, reason: 'missing_signature' })
	})

	it('[SW4] malformed timestamp (non-numeric) → malformed_timestamp', () => {
		const result = verifySignature(
			{
				webhookId: 'msg',
				timestamp: 'not-a-number',
				signature: 'v1,abc',
				rawBody: '{}',
				nowSeconds: 100,
			},
			[ACTIVE],
		)
		expect(result).toEqual({ ok: false, reason: 'malformed_timestamp' })
	})

	it('[SW4.b] malformed signature (no v1, prefix) → invalid_signature', () => {
		const result = verifySignature(
			{
				webhookId: 'msg',
				timestamp: String(NOW),
				signature: 'just-base64-no-version',
				rawBody: '{}',
				nowSeconds: NOW,
			},
			[ACTIVE],
		)
		expect(result).toEqual({ ok: false, reason: 'invalid_signature' })
	})

	it('[SW5] truncated signature (4 base64 chars short) → invalid_signature (timing-safe)', () => {
		const headers = signedHeaders({
			secret: SECRET_ACTIVE,
			webhookId: 'msg_trunc',
			timestamp: NOW,
			body: '{}',
		})
		// Corrupt: drop last 4 base64 chars. (Truncating 1 char may align with
		// padding `=` and produce same decoded bytes; 4 chars guaranteed differ.)
		const truncated = headers.signature.slice(0, -4)
		const result = verifySignature({ ...headers, signature: truncated, nowSeconds: NOW }, [ACTIVE])
		expect(result).toEqual({ ok: false, reason: 'invalid_signature' })
	})

	it('[SW5.b] prefix-only attack (correct prefix, wrong tail) → invalid_signature', () => {
		const headers = signedHeaders({
			secret: SECRET_ACTIVE,
			webhookId: 'msg_prefix',
			timestamp: NOW,
			body: '{}',
		})
		// Replace last 4 base64 chars with 'AAAA'.
		const tampered = `${headers.signature.slice(0, -4)}AAAA`
		const result = verifySignature({ ...headers, signature: tampered, nowSeconds: NOW }, [ACTIVE])
		expect(result).toEqual({ ok: false, reason: 'invalid_signature' })
	})
})

describe('verifySignature — body raw-bytes canon (NOT parsed JSON)', () => {
	it('[SW6] body byte-for-byte exact (включая trailing whitespace if any) verified', () => {
		const bodyExact = '{"a":1,"b":"тест"}\n'
		const headers = signedHeaders({
			secret: SECRET_ACTIVE,
			webhookId: 'msg_body',
			timestamp: NOW,
			body: bodyExact,
		})
		const result = verifySignature({ ...headers, nowSeconds: NOW }, [ACTIVE])
		expect(result.ok).toBe(true)
	})

	it('[SW6.b] body whitespace differ → invalid_signature (no canonicalization)', () => {
		const bodyOriginal = '{"a":1}'
		const bodyWithExtraSpace = '{"a": 1}'
		const headers = signedHeaders({
			secret: SECRET_ACTIVE,
			webhookId: 'msg_ws',
			timestamp: NOW,
			body: bodyOriginal,
		})
		// Send with different body — signature should NOT match.
		const result = verifySignature({ ...headers, rawBody: bodyWithExtraSpace, nowSeconds: NOW }, [
			ACTIVE,
		])
		expect(result).toEqual({ ok: false, reason: 'invalid_signature' })
	})
})

describe('IP allowlist (D25.c — non-HMAC channels)', () => {
	it('[SW7] empty allowlist → false (deny by default)', () => {
		expect(ipAllowlistVerify({ xForwardedFor: '1.2.3.4', allowedIps: [] })).toBe(false)
	})

	it('[SW7.b] missing X-Forwarded-For → false', () => {
		expect(ipAllowlistVerify({ xForwardedFor: undefined, allowedIps: ['1.2.3.4'] })).toBe(false)
	})

	it('[SW7.c] direct LB hop matches → true', () => {
		expect(ipAllowlistVerify({ xForwardedFor: '5.45.207.10', allowedIps: ['5.45.207.10'] })).toBe(
			true,
		)
	})

	it('[SW8] X-Forwarded-For chain — trust LAST hop NOT first (anti-spoof)', () => {
		// Attacker can spoof first hop in chain; we trust the last hop set by our LB.
		expect(
			ipAllowlistVerify({
				xForwardedFor: '6.6.6.6, 5.45.207.10',
				allowedIps: ['5.45.207.10'],
			}),
		).toBe(true)
		// Attacker tries to spoof a trusted IP at chain[0] — должен fail.
		expect(
			ipAllowlistVerify({
				xForwardedFor: '5.45.207.10, 6.6.6.6',
				allowedIps: ['5.45.207.10'],
			}),
		).toBe(false)
	})
})
