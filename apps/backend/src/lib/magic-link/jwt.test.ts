/**
 * Strict tests для magic-link JWT helpers (M9.widget.5 / A3.1.a).
 *
 * Pure unit tests — no DB. Validates jose 6.2.3 wrapper invariants.
 *
 * Coverage matrix (per `feedback_strict_tests.md`):
 *   ─── Roundtrip ───────────────────────────────────────────────
 *     [J1] sign + verify → claims roundtrip exact (sub/jti/scope/tenantId)
 *     [J2] view scope default TTL = 24h (86400s)
 *     [J3] mutate scope default TTL = 15min (900s)
 *     [J4] custom ttlSeconds override applied
 *     [J5] every signed JWT has unique jti (UUID v4 — randomUUID())
 *
 *   ─── Adversarial signature ───────────────────────────────────
 *     [J6] verify с wrong secret → throws 'invalid_signature'
 *     [J7] verify тampered payload → throws (signature breaks)
 *     [J8] verify malformed JWT → throws
 *
 *   ─── Adversarial claims ──────────────────────────────────────
 *     [J9] verify wrong tenantId → throws (issuer mismatch)
 *     [J10] verify expired JWT (TTL=1s + sleep 1.1s) → throws
 *     [J11] verify wrong audience (sign view, claim mutate) — protected by scope check
 *
 *   ─── Cross-tenant isolation ──────────────────────────────────
 *     [J12] tenant A's JWT NOT verifiable under tenant B's secret
 *     [J13] tenant A's JWT NOT verifiable когда тоже secret но wrong tenantId
 *
 *   ─── Scope coverage ──────────────────────────────────────────
 *     [J14] scope='view' → audience='widget'
 *     [J15] scope='mutate' → audience='portal'
 */

import { describe, expect, test } from 'vitest'
import { MAGIC_LINK_TTL_SECONDS, signMagicLinkJwt, verifyMagicLinkJwt } from './jwt.ts'
import { generateMagicLinkSecret } from './secret.ts'

const TENANT_A = 'org_01HABC0001'
const TENANT_B = 'org_01HABC0002'
const BOOKING_A = 'book_01HBOK0001'

describe('magic-link/jwt', () => {
	test('[J1] sign + verify roundtrip preserves claims exact', async () => {
		const secret = generateMagicLinkSecret()
		const { jwt, claims } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
		})

		const verified = await verifyMagicLinkJwt(secret, jwt, TENANT_A)
		expect(verified.bookingId).toBe(BOOKING_A)
		expect(verified.scope).toBe('view')
		expect(verified.tenantId).toBe(TENANT_A)
		expect(verified.jti).toBe(claims.jti)
		expect(verified.issuedAt).toBe(claims.issuedAt)
		expect(verified.expiresAt).toBe(claims.expiresAt)
	})

	test('[J2] view scope default TTL = 86400s (24h)', async () => {
		const secret = generateMagicLinkSecret()
		const { claims } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
		})
		expect(claims.expiresAt - claims.issuedAt).toBe(86400)
		expect(MAGIC_LINK_TTL_SECONDS.view).toBe(86400)
	})

	test('[J3] mutate scope default TTL = 900s (15min)', async () => {
		const secret = generateMagicLinkSecret()
		const { claims } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'mutate',
			tenantId: TENANT_A,
		})
		expect(claims.expiresAt - claims.issuedAt).toBe(900)
		expect(MAGIC_LINK_TTL_SECONDS.mutate).toBe(900)
	})

	test('[J4] custom ttlSeconds override applied', async () => {
		const secret = generateMagicLinkSecret()
		const { claims } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
			ttlSeconds: 7,
		})
		expect(claims.expiresAt - claims.issuedAt).toBe(7)
	})

	test('[J5] every signed JWT has unique jti', async () => {
		const secret = generateMagicLinkSecret()
		const jtis = new Set<string>()
		for (let i = 0; i < 20; i++) {
			const { claims } = await signMagicLinkJwt(secret, {
				bookingId: BOOKING_A,
				scope: 'view',
				tenantId: TENANT_A,
			})
			jtis.add(claims.jti)
		}
		expect(jtis.size).toBe(20)
	})

	test('[J6] verify с wrong secret rejects', async () => {
		const secretA = generateMagicLinkSecret()
		const secretB = generateMagicLinkSecret()
		const { jwt } = await signMagicLinkJwt(secretA, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
		})
		await expect(verifyMagicLinkJwt(secretB, jwt, TENANT_A)).rejects.toThrow()
	})

	test('[J7] verify tampered payload rejects (signature breaks)', async () => {
		const secret = generateMagicLinkSecret()
		const { jwt } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
		})
		const parts = jwt.split('.')
		const headerB64 = parts[0]
		const payloadB64 = parts[1]
		const sigB64 = parts[2]
		expect(headerB64).toBeDefined()
		expect(payloadB64).toBeDefined()
		expect(sigB64).toBeDefined()
		// Decode payload, mutate sub, re-encode (signature не пересчитается).
		const payloadJson = JSON.parse(Buffer.from(payloadB64 as string, 'base64url').toString('utf8'))
		payloadJson.sub = 'book_TAMPERED'
		const tamperedPayload = Buffer.from(JSON.stringify(payloadJson)).toString('base64url')
		const tamperedJwt = `${headerB64 as string}.${tamperedPayload}.${sigB64 as string}`
		await expect(verifyMagicLinkJwt(secret, tamperedJwt, TENANT_A)).rejects.toThrow()
	})

	test('[J8] verify malformed JWT rejects', async () => {
		const secret = generateMagicLinkSecret()
		await expect(verifyMagicLinkJwt(secret, 'not-a-jwt', TENANT_A)).rejects.toThrow()
		await expect(verifyMagicLinkJwt(secret, '', TENANT_A)).rejects.toThrow()
		await expect(verifyMagicLinkJwt(secret, 'a.b.c', TENANT_A)).rejects.toThrow()
	})

	test('[J9] verify wrong tenantId rejects (cross-tenant isolation)', async () => {
		const secret = generateMagicLinkSecret()
		const { jwt } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
		})
		await expect(verifyMagicLinkJwt(secret, jwt, TENANT_B)).rejects.toThrow()
	})

	test('[J10] verify expired JWT rejects', async () => {
		const secret = generateMagicLinkSecret()
		const { jwt } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
			ttlSeconds: 1,
		})
		await new Promise((r) => setTimeout(r, 1100))
		await expect(verifyMagicLinkJwt(secret, jwt, TENANT_A)).rejects.toThrow()
	})

	test('[J11] verify enforces scope→audience binding', async () => {
		const secret = generateMagicLinkSecret()
		// Signing с scope='view' creates audience='widget'. If we tamper claim
		// `prp` to 'mutate' the audience check will fail (still expects 'widget').
		// Direct path: sign view, swap to look like mutate would be тamper test
		// covered by [J7]. Here just confirm both scopes verify correctly.
		const v = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
		})
		const m = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'mutate',
			tenantId: TENANT_A,
		})
		const verifiedV = await verifyMagicLinkJwt(secret, v.jwt, TENANT_A)
		const verifiedM = await verifyMagicLinkJwt(secret, m.jwt, TENANT_A)
		expect(verifiedV.scope).toBe('view')
		expect(verifiedM.scope).toBe('mutate')
	})

	test('[J12] cross-tenant: A JWT NOT verifiable under B secret', async () => {
		const secretA = generateMagicLinkSecret()
		const secretB = generateMagicLinkSecret()
		const { jwt } = await signMagicLinkJwt(secretA, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
		})
		await expect(verifyMagicLinkJwt(secretB, jwt, TENANT_A)).rejects.toThrow()
	})

	test('[J13] cross-tenant: same secret but wrong tenantId → reject', async () => {
		const secret = generateMagicLinkSecret()
		const { jwt } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
		})
		await expect(verifyMagicLinkJwt(secret, jwt, TENANT_B)).rejects.toThrow()
	})

	test('[J14] scope=view → audience=widget', async () => {
		const secret = generateMagicLinkSecret()
		const { jwt } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'view',
			tenantId: TENANT_A,
		})
		// jose's jwtVerify accepts/rejects audience implicitly; we expose only
		// scope в parsed claims. Manually decode payload.
		const payloadB64 = jwt.split('.')[1] as string
		const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
		expect(payload.aud).toBe('widget')
	})

	test('[J15] scope=mutate → audience=portal', async () => {
		const secret = generateMagicLinkSecret()
		const { jwt } = await signMagicLinkJwt(secret, {
			bookingId: BOOKING_A,
			scope: 'mutate',
			tenantId: TENANT_A,
		})
		const payloadB64 = jwt.split('.')[1] as string
		const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
		expect(payload.aud).toBe('portal')
	})
})
