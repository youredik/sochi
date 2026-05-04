/**
 * Magic-link service (M9.widget.5 — Track A3).
 *
 * Composes:
 *   - `MagicLinkSecretResolver` — per-tenant HS256 secret (lazy back-fill)
 *   - `signMagicLinkJwt` / `verifyMagicLinkJwt` — jose 6.2.3 wrappers
 *   - `MagicLinkTokenRepo` — DB-side single-use enforcement
 *
 * Operations:
 *   - `issue({ tenantId, bookingId, scope, ttlSeconds?, issuedFromIp? })`
 *     → generate JWT + persist token row. Returns `{ jwt, claims }`.
 *   - `verify({ tenantId, jwt })` — verify JWT signature + read DB row.
 *     Returns `{ claims, token }` или throws (`MagicLinkVerifyError`).
 *     Does NOT mutate. Used для two-step GET-render endpoint.
 *   - `consume({ tenantId, jwt, fromIp, fromUa })` — verify + atomic
 *     decrement. Returns `{ claims, fullyConsumed }`.
 *     Used для two-step POST-consume endpoint.
 *
 * Two-step pattern (Apple MPP / Slack unfurl prefetch DoS защита):
 *   GET /booking/jwt/:jwt/render → verify(), render confirm-button page
 *   POST /booking/jwt/:jwt/consume → consume(), atomic decrement, set cookie
 *
 * Per `feedback_behaviour_faithful_mock_canon.md`: same canonical interface
 * works для demo + production tenants. Live-flip = factory binding swap.
 */

import {
	type MagicLinkClaims,
	type MagicLinkScope,
	signMagicLinkJwt,
	verifyMagicLinkJwt,
} from '../../lib/magic-link/jwt.ts'
import type { MagicLinkSecretResolver } from '../../lib/magic-link/secret.ts'
import {
	DEFAULT_ATTEMPTS_BY_SCOPE,
	type MagicLinkTokenRepo,
	type MagicLinkTokenRow,
} from './magic-link.repo.ts'

/** Domain error raised when JWT/DB verification fails. */
export type MagicLinkVerifyReason =
	| 'invalid_signature'
	| 'expired'
	| 'tenant_mismatch'
	| 'malformed'
	| 'not_found'
	| 'fully_consumed'

export class MagicLinkVerifyError extends Error {
	readonly reason: MagicLinkVerifyReason

	constructor(message: string, reason: MagicLinkVerifyReason) {
		super(message)
		this.name = 'MagicLinkVerifyError'
		this.reason = reason
	}
}

export interface MagicLinkIssueInput {
	readonly tenantId: string
	readonly bookingId: string
	readonly scope: MagicLinkScope
	readonly ttlSeconds?: number
	readonly issuedFromIp?: string | null
	readonly attemptsRemaining?: number
}

export interface MagicLinkServiceDeps {
	readonly secretResolver: MagicLinkSecretResolver
	readonly tokenRepo: MagicLinkTokenRepo
}

export type MagicLinkService = ReturnType<typeof createMagicLinkService>

export function createMagicLinkService(deps: MagicLinkServiceDeps) {
	return {
		/**
		 * Issue fresh magic-link JWT + persist token row.
		 *
		 * Defaults: `attemptsRemaining` = 5 для view scope, 1 для mutate scope
		 * (per `etodd.io/2026/03/22/magic-link-pitfalls/` Apple MPP defense canon).
		 */
		async issue(input: MagicLinkIssueInput): Promise<{
			readonly jwt: string
			readonly claims: MagicLinkClaims
		}> {
			const secret = await deps.secretResolver.resolve(input.tenantId)
			const { jwt, claims } = await signMagicLinkJwt(secret, {
				bookingId: input.bookingId,
				scope: input.scope,
				tenantId: input.tenantId,
				...(input.ttlSeconds !== undefined && { ttlSeconds: input.ttlSeconds }),
			})
			const attempts = input.attemptsRemaining ?? DEFAULT_ATTEMPTS_BY_SCOPE[input.scope]

			await deps.tokenRepo.insert({
				tenantId: input.tenantId,
				jti: claims.jti,
				bookingId: input.bookingId,
				scope: input.scope,
				issuedAt: new Date(claims.issuedAt * 1000),
				expiresAt: new Date(claims.expiresAt * 1000),
				issuedFromIp: input.issuedFromIp ?? null,
				attemptsRemaining: attempts,
			})

			return { jwt, claims }
		},

		/**
		 * Verify JWT + read token row (no mutation).
		 *
		 * Used для two-step GET render endpoint. Allows confirming token
		 * validity без consuming attempt — Apple MPP / Outlook SafeLinks
		 * scanner GET requests don't burn attempts.
		 */
		async verify(input: { readonly tenantId: string; readonly jwt: string }): Promise<{
			readonly claims: MagicLinkClaims
			readonly token: MagicLinkTokenRow
		}> {
			const secret = await deps.secretResolver.resolve(input.tenantId)
			let claims: MagicLinkClaims
			try {
				claims = await verifyMagicLinkJwt(secret, input.jwt, input.tenantId)
			} catch (err) {
				throw mapJoseError(err)
			}

			const token = await deps.tokenRepo.findByJti(input.tenantId, claims.jti)
			if (!token) {
				throw new MagicLinkVerifyError(
					`magic-link token row not found (jti=${claims.jti})`,
					'not_found',
				)
			}
			if (token.attemptsRemaining <= 0) {
				throw new MagicLinkVerifyError(
					`magic-link token already fully consumed (jti=${claims.jti})`,
					'fully_consumed',
				)
			}
			if (token.tenantId !== input.tenantId) {
				throw new MagicLinkVerifyError(
					`magic-link token tenant mismatch (jti=${claims.jti})`,
					'tenant_mismatch',
				)
			}
			return { claims, token }
		},

		/**
		 * Verify + atomic consume (decrement attemptsRemaining).
		 *
		 * Returns `{ claims, fullyConsumed }`. `fullyConsumed=true` when
		 * attemptsRemaining hit 0 — caller should issue cookie + redirect
		 * к destination. `fullyConsumed=false` для view tokens с attempts
		 * remaining (shouldn't happen для mutate per default attempts=1).
		 *
		 * Throws `MagicLinkVerifyError('not_found' | 'fully_consumed' | ...)`
		 * на verify failure; caller maps to 410 Gone or 401.
		 */
		async consume(input: {
			readonly tenantId: string
			readonly jwt: string
			readonly fromIp: string
			readonly fromUa: string | null
		}): Promise<{
			readonly claims: MagicLinkClaims
			readonly fullyConsumed: boolean
			readonly token: MagicLinkTokenRow
		}> {
			const secret = await deps.secretResolver.resolve(input.tenantId)
			let claims: MagicLinkClaims
			try {
				claims = await verifyMagicLinkJwt(secret, input.jwt, input.tenantId)
			} catch (err) {
				throw mapJoseError(err)
			}

			const result = await deps.tokenRepo.consume({
				tenantId: input.tenantId,
				jti: claims.jti,
				fromIp: input.fromIp,
				fromUa: input.fromUa,
				now: new Date(),
			})
			if (!result.consumed) {
				if (!result.token) {
					throw new MagicLinkVerifyError(
						`magic-link token row missing (jti=${claims.jti})`,
						'not_found',
					)
				}
				if (result.fullyConsumed) {
					throw new MagicLinkVerifyError(
						`magic-link token already fully consumed (jti=${claims.jti})`,
						'fully_consumed',
					)
				}
				throw new MagicLinkVerifyError(`magic-link token expired (jti=${claims.jti})`, 'expired')
			}

			if (result.token === null) {
				throw new Error('magic-link consume succeeded but token row missing — invariant violation')
			}

			return {
				claims,
				fullyConsumed: result.fullyConsumed,
				token: result.token,
			}
		},
	}
}

function mapJoseError(err: unknown): MagicLinkVerifyError {
	if (err instanceof Error) {
		const msg = err.message
		if (
			msg.includes('signature') ||
			msg.includes('JWSSignatureVerificationFailed') ||
			err.name === 'JWSSignatureVerificationFailed'
		) {
			return new MagicLinkVerifyError(msg, 'invalid_signature')
		}
		if (msg.includes('exp') || msg.includes('expired') || err.name === 'JWTExpired') {
			return new MagicLinkVerifyError(msg, 'expired')
		}
		if (msg.includes('issuer') || msg.includes('iss') || msg.includes('tenantId')) {
			return new MagicLinkVerifyError(msg, 'tenant_mismatch')
		}
	}
	return new MagicLinkVerifyError(String(err), 'malformed')
}
