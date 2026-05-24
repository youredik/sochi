/**
 * Yandex Service Account JWT verifier — canonical 2026 service-to-service
 * auth pattern (offline PS256 verification via `jose`).
 *
 * **Why this exists (Round 7 2026-05-24)**: AI agents (Claude) + CI smoke
 * runners need a repeatable way к verify captcha-protected production sites
 * without shared static secrets that leak/rotate-burden. The 2026 canonical
 * Russian-cloud-native answer = Service Account JWT.
 *
 * **Flow**:
 *   1. Client (smoke runner / AI agent) has SA RSA private key (Lockbox-stored).
 *   2. Client signs PS256 JWT with claims `{iss, sub: SA_ID, aud, iat, exp}`.
 *   3. Client sends `Authorization: Bearer <jwt>` к backend.
 *   4. Backend verifies signature using SA's PUBLIC key (mounted via Lockbox).
 *   5. Backend checks claims: `sub === trustedSaId`, `aud === expectedAudience`,
 *      `exp < now`.
 *   6. If valid → caller is identified as trusted SA → bypass captcha.
 *
 * **Security**:
 *   - Signature: RSA-2048 PS256 (canonical Yandex SA key algorithm).
 *   - Audience binding: prevents token re-use across services.
 *   - Short lifetime: client enforces ≤1h `exp`; backend rejects если token
 *     `exp - iat > 3600`. JWT is not refreshed — new sig per request burst.
 *   - Offline verification: no remote Yandex IAM call (no latency, no
 *     IAM-downtime dependency).
 *   - Audit-logged on each bypass (Pino warn-level) per ст.18.1 records canon.
 *
 * **Why not Yandex IAM token introspect**: tested empirically 2026-05-24 —
 * `https://iam.api.cloud.yandex.net/iam/v1/tokens:resolve` returns 404.
 * Yandex has no public introspect endpoint. SA-JWT-offline is the only
 * canonical Russian-cloud-native option without third-party SaaS.
 *
 * **Production guard**: callers выше (captcha-gate) should restrict bypass to
 * non-production environments OR specific paths. This module does pure
 * cryptographic verification — caller decides trust policy.
 */

import { importSPKI, jwtVerify, type JWTPayload } from 'jose'

export interface VerifyServiceAccountJwtOptions {
	/** PEM-encoded RSA public key (from SA key file `.public_key`). */
	readonly publicKeyPem: string
	/** Expected `sub` claim — SA ID (e.g. `aje54tid7ibbh6ci70bl`). */
	readonly expectedServiceAccountId: string
	/** Expected `aud` claim — usually deployment hostname (`demo.sepshn.ru`). */
	readonly expectedAudience: string
	/** Reject tokens с `exp - iat > maxLifetimeSeconds`. Default 3600 (1h). */
	readonly maxLifetimeSeconds?: number
}

export interface VerifyServiceAccountJwtResult {
	readonly ok: true
	readonly serviceAccountId: string
	readonly expiresAt: Date
}

export interface VerifyServiceAccountJwtError {
	readonly ok: false
	readonly reason:
		| 'invalid_format'
		| 'invalid_signature'
		| 'wrong_issuer'
		| 'wrong_subject'
		| 'wrong_audience'
		| 'expired'
		| 'lifetime_too_long'
		| 'public_key_load_error'
}

const DEFAULT_MAX_LIFETIME_SECONDS = 3600

/**
 * Verify a Yandex Service Account JWT signed with PS256.
 *
 * Returns structured result; caller decides what к do с failure. Pure
 * function: no logging, no audit (callers can add Pino warn / audit-row
 * around this).
 */
export async function verifyServiceAccountJwt(
	jwt: string,
	options: VerifyServiceAccountJwtOptions,
): Promise<VerifyServiceAccountJwtResult | VerifyServiceAccountJwtError> {
	// Cheap pre-check: JWT format (3 dot-separated base64url segments).
	if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
		return { ok: false, reason: 'invalid_format' }
	}

	let publicKey: CryptoKey
	try {
		publicKey = (await importSPKI(options.publicKeyPem, 'PS256')) as CryptoKey
	} catch {
		return { ok: false, reason: 'public_key_load_error' }
	}

	let payload: JWTPayload
	try {
		const verified = await jwtVerify(jwt, publicKey, {
			algorithms: ['PS256'],
			audience: options.expectedAudience,
		})
		payload = verified.payload
	} catch (err) {
		// jose throws JWTClaimValidationFailed для audience mismatch (different
		// error from expired). `name` distinguishes; for claim-fails additionally
		// `claim` field carries which claim. Use string-match on `code` / `claim`
		// для robust detection across jose versions.
		if (err instanceof Error) {
			if (err.name === 'JWTExpired') return { ok: false, reason: 'expired' }
			// jose's JWTClaimValidationFailed exposes `.claim` field — check first.
			const claim = (err as Error & { claim?: string }).claim
			if (claim === 'aud' || claim === 'audience') {
				return { ok: false, reason: 'wrong_audience' }
			}
			if (err.name === 'JWTClaimValidationFailed') {
				// Other claim failure (not aud/expired) — surface as wrong_audience
				// if это аудитория ошибка (covers minor jose version drift).
				const msg = err.message.toLowerCase()
				if (msg.includes('audience') || msg.includes('aud ')) {
					return { ok: false, reason: 'wrong_audience' }
				}
			}
		}
		return { ok: false, reason: 'invalid_signature' }
	}

	if (payload.sub !== options.expectedServiceAccountId) {
		return { ok: false, reason: 'wrong_subject' }
	}
	// Yandex canon: `iss` should equal `sub` (SA signs JWT identifying itself).
	if (payload.iss !== payload.sub) {
		return { ok: false, reason: 'wrong_issuer' }
	}

	const iat = typeof payload.iat === 'number' ? payload.iat : 0
	const exp = typeof payload.exp === 'number' ? payload.exp : 0
	const maxLifetime = options.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS
	if (exp - iat > maxLifetime) {
		return { ok: false, reason: 'lifetime_too_long' }
	}

	return {
		ok: true,
		serviceAccountId: payload.sub,
		expiresAt: new Date(exp * 1000),
	}
}
