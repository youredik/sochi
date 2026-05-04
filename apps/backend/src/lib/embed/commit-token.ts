/**
 * `clientCommitToken` HMAC sign + verify with `kid` rotation
 * (M9.widget.6 / А4.3 D25, R2 F4).
 *
 * Per plan §D18 — D25:
 *   * Server issues a signed token after the client has interacted with the
 *     widget for ≥800 ms AND the submit button passed an
 *     IntersectionObserver v2 `isVisible` check. The token is required for
 *     the booking commit POST so a clickjacking iframe (which cannot
 *     produce a real interaction) cannot forge submissions.
 *   * `nbf` claim = `iat + 0.8` (jose accepts fractional seconds when used
 *     numerically; verifier rejects until clock ≥ nbf).
 *   * Sliding-window `kid` rotation: issuer ALWAYS signs with `current` key;
 *     verifier accepts BOTH `current` and `previous`. When secret leak
 *     suspected, rotate: previous ← current, current ← new. Token TTL
 *     (300s) bounds the forge window after rotation.
 *
 * Reference:
 *   * Yandex Lockbox versioned secrets (yandex.cloud/lockbox 2026)
 *   * AWS KMS HMAC manual rotation canon (Apr 2026)
 *   * jose 6.2 JWKS pattern in `lib/magic-link/jwt.ts`
 */

import { jwtVerify, SignJWT } from 'jose'

export type CommitTokenKid = 'current' | 'previous'

export interface CommitTokenInput {
	readonly tenantId: string
	readonly slug: string
	readonly nowSeconds: number
	readonly delaySeconds?: number /** default 0.8s per D18 */
	readonly ttlSeconds?: number /** default 300s */
}

export interface CommitTokenClaims {
	readonly tenantId: string
	readonly slug: string
	readonly notBefore: number
	readonly expiresAt: number
	readonly kid: CommitTokenKid
}

const ISSUER = 'sochi-horeca:embed'
const AUDIENCE = 'commit'

const DEFAULT_DELAY_SECONDS = 0.8
const DEFAULT_TTL_SECONDS = 300

/**
 * Resolve current + previous secret bytes. Both encoded base64url strings
 * stored in env (seeded from Yandex Lockbox at boot per project canon).
 * Caller passes the env vars; we return the ordered key list.
 *
 * Boot order: read `COMMIT_TOKEN_HMAC_CURRENT` (REQUIRED) +
 * `COMMIT_TOKEN_HMAC_PREVIOUS` (OPTIONAL — only after first rotation).
 */
export interface CommitTokenSecretSource {
	readonly current: Uint8Array
	readonly previous: Uint8Array | null
}

/** Sign `clientCommitToken` HS256 with the `current` key + `kid` header. */
export async function signCommitToken(
	input: CommitTokenInput,
	secrets: CommitTokenSecretSource,
): Promise<string> {
	const delaySeconds = input.delaySeconds ?? DEFAULT_DELAY_SECONDS
	const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS
	const iat = input.nowSeconds
	const nbf = Math.floor(iat + delaySeconds)
	const exp = iat + ttlSeconds
	return new SignJWT({})
		.setProtectedHeader({ alg: 'HS256', kid: 'current' })
		.setIssuer(ISSUER)
		.setAudience(AUDIENCE)
		.setSubject(`${input.tenantId}:${input.slug}`)
		.setIssuedAt(iat)
		.setNotBefore(nbf)
		.setExpirationTime(exp)
		.sign(secrets.current)
}

/**
 * Verify token; try `current` first, then `previous` if rotation window
 * still open. Throws on any failure — caller maps to 401/403.
 */
export async function verifyCommitToken(
	token: string,
	secrets: CommitTokenSecretSource,
): Promise<CommitTokenClaims> {
	const tryVerify = async (secret: Uint8Array, kid: CommitTokenKid): Promise<CommitTokenClaims> => {
		const { payload } = await jwtVerify(token, secret, {
			issuer: ISSUER,
			audience: AUDIENCE,
		})
		const sub = typeof payload.sub === 'string' ? payload.sub : ''
		const sep = sub.indexOf(':')
		if (sep < 0) throw new Error('commit-token: malformed sub')
		const tenantId = sub.slice(0, sep)
		const slug = sub.slice(sep + 1)
		if (typeof payload.nbf !== 'number' || typeof payload.exp !== 'number') {
			throw new Error('commit-token: missing nbf/exp')
		}
		return {
			tenantId,
			slug,
			notBefore: payload.nbf,
			expiresAt: payload.exp,
			kid,
		}
	}
	try {
		return await tryVerify(secrets.current, 'current')
	} catch (currentErr) {
		if (secrets.previous === null) throw currentErr
		try {
			return await tryVerify(secrets.previous, 'previous')
		} catch {
			throw currentErr
		}
	}
}
