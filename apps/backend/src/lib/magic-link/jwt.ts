/**
 * Magic-link JWT signing + verification (M9.widget.5 — Track A3).
 *
 * Per `plans/m9_widget_5_canonical.md` §D2 + §D5:
 *   - HS256 (jose 6.2.3) — single-issuer / single-verifier (same backend),
 *     no JWKS overhead. Per-tenant secret resolved separately.
 *   - TTL: mutate=15min; view=24h (override-able via `ttlSeconds`).
 *   - Claims: sub=bookingId, aud='widget'|'portal', iss=tenantId, exp/iat,
 *     jti (UUID v7 sortable for index pruning), prp='view'|'mutate', tid=tenantId.
 *
 * `verify()` returns claims if signature + exp + iss + aud match (no DB
 * read — that's `magic-link.service.consume()`'s job).
 *
 * `crypto.timingSafeEqual` is internal к `jose.jwtVerify` (HMAC-SHA-256
 * via `crypto.subtle.verify`) — constant-time signature compare.
 */

import { randomUUID } from 'node:crypto'
import { decodeJwt, jwtVerify, SignJWT } from 'jose'

export type MagicLinkScope = 'view' | 'mutate'

export interface MagicLinkClaims {
	readonly bookingId: string
	readonly scope: MagicLinkScope
	readonly tenantId: string
	readonly jti: string
	readonly issuedAt: number /** seconds-since-epoch */
	readonly expiresAt: number /** seconds-since-epoch */
}

/** Default TTL by scope per plan §D2. Override via `signMagicLinkJwt({ttlSeconds})`. */
export const MAGIC_LINK_TTL_SECONDS: Record<MagicLinkScope, number> = {
	view: 24 * 60 * 60,
	mutate: 15 * 60,
}

const ISSUER_PREFIX = 'sochi-horeca'
const AUDIENCE_BY_SCOPE: Record<MagicLinkScope, string> = {
	view: 'widget',
	mutate: 'portal',
}

/**
 * Sign HS256 JWT for magic-link delivery.
 *
 * @param secret — base64url-encoded per-tenant secret (`MagicLinkSecretResolver`)
 * @param input.bookingId — booking subject (sub claim)
 * @param input.scope — 'view' (24h voucher access) | 'mutate' (15min portal action)
 * @param input.tenantId — tenant context (iss + tid; isolation guard)
 * @param input.ttlSeconds — optional override (default per scope)
 * @returns `{ jwt, claims }` — `jwt` for URL embedding; `claims` for DB row insert.
 */
export async function signMagicLinkJwt(
	secret: string,
	input: {
		readonly bookingId: string
		readonly scope: MagicLinkScope
		readonly tenantId: string
		readonly ttlSeconds?: number
	},
): Promise<{ readonly jwt: string; readonly claims: MagicLinkClaims }> {
	const issuedAt = Math.floor(Date.now() / 1000)
	const ttl = input.ttlSeconds ?? MAGIC_LINK_TTL_SECONDS[input.scope]
	const expiresAt = issuedAt + ttl
	const jti = randomUUID()

	const secretBytes = decodeSecret(secret)
	const jwt = await new SignJWT({
		prp: input.scope,
		tid: input.tenantId,
	})
		.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
		.setSubject(input.bookingId)
		.setIssuer(`${ISSUER_PREFIX}:${input.tenantId}`)
		.setAudience(AUDIENCE_BY_SCOPE[input.scope])
		.setIssuedAt(issuedAt)
		.setExpirationTime(expiresAt)
		.setJti(jti)
		.sign(secretBytes)

	return {
		jwt,
		claims: {
			bookingId: input.bookingId,
			scope: input.scope,
			tenantId: input.tenantId,
			jti,
			issuedAt,
			expiresAt,
		},
	}
}

/**
 * Verify HS256 JWT signature + standard claims (exp / iss / aud).
 *
 * Throws on:
 *   - Invalid signature (wrong secret)
 *   - Expired (`exp` past)
 *   - Wrong issuer (cross-tenant rejection)
 *   - Malformed JWT
 *
 * Returns parsed claims. Does NOT check DB-side `consumedAt` — that's
 * `magic-link.service.consume()`'s atomic gate.
 */
export async function verifyMagicLinkJwt(
	secret: string,
	jwt: string,
	tenantId: string,
): Promise<MagicLinkClaims> {
	const secretBytes = decodeSecret(secret)
	const { payload } = await jwtVerify(jwt, secretBytes, {
		issuer: `${ISSUER_PREFIX}:${tenantId}`,
	})

	// Validate scope-specific audience separately (jose accepts string|string[]).
	const scope = payload.prp
	if (scope !== 'view' && scope !== 'mutate') {
		throw new Error(`magic-link JWT: invalid scope claim "${String(scope)}"`)
	}
	const expectedAudience = AUDIENCE_BY_SCOPE[scope]
	const actualAudience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud
	if (actualAudience !== expectedAudience) {
		throw new Error(
			`magic-link JWT: audience mismatch (expected ${expectedAudience}, got ${String(actualAudience)})`,
		)
	}

	if (payload.tid !== tenantId) {
		throw new Error(
			`magic-link JWT: tenantId claim mismatch (expected ${tenantId}, got ${String(payload.tid)})`,
		)
	}

	const bookingId = payload.sub
	if (typeof bookingId !== 'string' || bookingId.length === 0) {
		throw new Error('magic-link JWT: missing or invalid sub claim')
	}

	const jti = payload.jti
	if (typeof jti !== 'string' || jti.length === 0) {
		throw new Error('magic-link JWT: missing or invalid jti claim')
	}

	const issuedAt = payload.iat
	const expiresAt = payload.exp
	if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number') {
		throw new Error('magic-link JWT: missing iat or exp claim')
	}

	return {
		bookingId,
		scope,
		tenantId,
		jti,
		issuedAt,
		expiresAt,
	}
}

function decodeSecret(secret: string): Uint8Array {
	return Buffer.from(secret, 'base64url')
}

const ISSUER_PATTERN = /^sochi-horeca:(.+)$/

/**
 * Decode JWT iss claim WITHOUT verifying signature — used for tenant
 * resolution before full verify (need tenantId to load per-tenant secret).
 *
 * Throws if JWT malformed or iss claim missing/wrong format. Does NOT
 * validate signature, expiry, or any other claim — caller MUST follow up
 * with `verifyMagicLinkJwt(secret, jwt, tenantId)`.
 *
 * Security: returning untrusted tenantId from this function is OK — it's
 * only used to load the secret. If attacker forged an iss claim для tenant
 * B, they'd load tenant B's secret and signature verification would fail
 * (their fake JWT wasn't signed with tenant B's secret).
 */
export function extractTenantIdFromJwtUnsafe(jwt: string): string {
	const claims = decodeJwt(jwt)
	const iss = claims.iss
	if (typeof iss !== 'string') {
		throw new Error('magic-link JWT: missing iss claim')
	}
	const match = ISSUER_PATTERN.exec(iss)
	if (!match || !match[1]) {
		throw new Error(`magic-link JWT: invalid iss format "${iss}"`)
	}
	return match[1]
}
