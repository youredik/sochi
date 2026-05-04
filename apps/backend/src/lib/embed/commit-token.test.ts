/**
 * `clientCommitToken` HMAC sign + verify unit tests — D25 (R2 F4).
 *
 * Covers nbf enforcement (≥0.8s after iat), kid sliding-window rotation,
 * tenant/slug round-trip via `sub`, and rejection of stale / cross-key tokens.
 */

import { jwtVerify, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { type CommitTokenSecretSource, signCommitToken, verifyCommitToken } from './commit-token.ts'

const KEY_A = new TextEncoder().encode('A'.repeat(32))
const KEY_B = new TextEncoder().encode('B'.repeat(32))
const KEY_C = new TextEncoder().encode('C'.repeat(32))

const tokenSecrets: CommitTokenSecretSource = { current: KEY_A, previous: null }
const rotatedSecrets: CommitTokenSecretSource = { current: KEY_B, previous: KEY_A }
const fullyRotatedSecrets: CommitTokenSecretSource = { current: KEY_C, previous: KEY_B }

const NOW = Math.floor(Date.now() / 1000)
const TENANT = 'tenant-aurora'
const SLUG = 'aurora'

describe('signCommitToken / verifyCommitToken — happy path', () => {
	it('[CT1] sign + verify round-trip yields tenant + slug', async () => {
		const token = await signCommitToken(
			{ tenantId: TENANT, slug: SLUG, nowSeconds: NOW - 10 },
			tokenSecrets,
		)
		const claims = await verifyCommitToken(token, tokenSecrets)
		expect(claims.tenantId).toBe(TENANT)
		expect(claims.slug).toBe(SLUG)
		expect(claims.kid).toBe('current')
	})

	it('[CT2] nbf claim enforces ≥0.8s gap from iat (D18 minimum interaction)', async () => {
		const iat = NOW
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: 'HS256', kid: 'current' })
			.setIssuer('sochi-horeca:embed')
			.setAudience('commit')
			.setSubject(`${TENANT}:${SLUG}`)
			.setIssuedAt(iat)
			.setNotBefore(iat + 1) // 1s = >= 0.8 ✓
			.setExpirationTime(iat + 300)
			.sign(KEY_A)
		// Verifier with currentDate just at iat (before nbf) MUST reject.
		await expect(
			jwtVerify(token, KEY_A, {
				issuer: 'sochi-horeca:embed',
				audience: 'commit',
				currentDate: new Date(iat * 1000),
			}),
		).rejects.toThrow()
	})

	it('[CT3] respects custom delay/ttl', async () => {
		// Use nowSeconds in the past so nbf (= iat + delaySeconds) is already
		// satisfied by wall-clock when verifier runs, but exp (= iat + ttl)
		// is still in the future.
		const issuedAt = NOW - 30
		const token = await signCommitToken(
			{
				tenantId: TENANT,
				slug: SLUG,
				nowSeconds: issuedAt,
				delaySeconds: 2,
				ttlSeconds: 600,
			},
			tokenSecrets,
		)
		const claims = await verifyCommitToken(token, tokenSecrets)
		expect(claims.notBefore).toBe(issuedAt + 2)
		expect(claims.expiresAt).toBe(issuedAt + 600)
	})
})

describe('signCommitToken / verifyCommitToken — kid rotation (D25 sliding window)', () => {
	it('[CT4] verifier accepts a token signed with previous when current rotates', async () => {
		// Sign with KEY_A while it is "current". Then rotate: previous=A, current=B.
		const token = await signCommitToken(
			{ tenantId: TENANT, slug: SLUG, nowSeconds: NOW - 10 },
			{ current: KEY_A, previous: null },
		)
		const claims = await verifyCommitToken(token, rotatedSecrets)
		expect(claims.tenantId).toBe(TENANT)
		expect(claims.kid).toBe('previous')
	})

	it('[CT5] verifier rejects a token whose key fell out of rotation window', async () => {
		// Token signed with KEY_A (oldest). Window: current=C, previous=B. KEY_A not honoured.
		const token = await signCommitToken(
			{ tenantId: TENANT, slug: SLUG, nowSeconds: NOW - 10 },
			{ current: KEY_A, previous: null },
		)
		await expect(verifyCommitToken(token, fullyRotatedSecrets)).rejects.toThrow()
	})

	it('[CT6] verifier rejects forged token (bad HMAC)', async () => {
		// Sign with an unknown key D.
		const KEY_D = new TextEncoder().encode('D'.repeat(32))
		const forged = await signCommitToken(
			{ tenantId: 'evil', slug: 'evil', nowSeconds: NOW - 10 },
			{ current: KEY_D, previous: null },
		)
		await expect(verifyCommitToken(forged, tokenSecrets)).rejects.toThrow()
	})

	it('[CT7] verifier rejects malformed sub (missing tenant:slug separator)', async () => {
		const iat = NOW - 10
		const malformed = await new SignJWT({})
			.setProtectedHeader({ alg: 'HS256', kid: 'current' })
			.setIssuer('sochi-horeca:embed')
			.setAudience('commit')
			.setSubject('no-separator')
			.setIssuedAt(iat)
			.setNotBefore(iat + 1)
			.setExpirationTime(iat + 300)
			.sign(KEY_A)
		await expect(verifyCommitToken(malformed, tokenSecrets)).rejects.toThrow(/malformed sub/)
	})
})
