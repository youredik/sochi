/**
 * Strict tests на canonical Yandex SA JWT verifier (Round 7 2026-05-24).
 *
 * Test matrix:
 *   [V1] valid JWT (signed by trusted SA key) → ok + serviceAccountId returned
 *   [V2] wrong signature (signed by different key) → invalid_signature
 *   [V3] sub mismatch → wrong_subject
 *   [V4] iss !== sub → wrong_issuer
 *   [V5] aud mismatch → wrong_audience
 *   [V6] expired (exp < now) → expired
 *   [V7] lifetime > maxLifetime → lifetime_too_long
 *   [V8] malformed JWT (not 3 segments) → invalid_format
 *   [V9] bad public key PEM → public_key_load_error
 *   [V10] explicit short lifetime (5min) enforced
 */
import { describe, expect, test } from 'bun:test'
import { generateKeyPair, SignJWT, exportSPKI } from 'jose'
import { verifyServiceAccountJwt } from './sa-jwt-verify.ts'

const SA_ID = 'aje54tid7ibbh6ci70blTEST'
const ALT_SA_ID = 'ajeOTHERSAID00000000000T'
const AUDIENCE = 'demo.sepshn.ru'

/** Generates fresh PS256 key pair + helper to sign JWT с given claims. */
async function makeKeySetup(saId: string = SA_ID) {
	const { publicKey, privateKey } = await generateKeyPair('PS256', { extractable: true })
	const publicKeyPem = await exportSPKI(publicKey)

	async function sign(
		opts: {
			iss?: string
			sub?: string
			aud?: string
			lifetimeSeconds?: number
			now?: number
		} = {},
	) {
		const now = opts.now ?? Math.floor(Date.now() / 1000)
		const lifetime = opts.lifetimeSeconds ?? 300 // 5 min default
		return await new SignJWT({})
			.setProtectedHeader({ alg: 'PS256' })
			.setIssuer(opts.iss ?? saId)
			.setSubject(opts.sub ?? saId)
			.setAudience(opts.aud ?? AUDIENCE)
			.setIssuedAt(now)
			.setExpirationTime(now + lifetime)
			.sign(privateKey)
	}

	return { publicKeyPem, sign }
}

describe('verifyServiceAccountJwt', () => {
	test('[V1] valid JWT → ok with serviceAccountId', async () => {
		const { publicKeyPem, sign } = await makeKeySetup()
		const jwt = await sign()
		const result = await verifyServiceAccountJwt(jwt, {
			publicKeyPem,
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
		})
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.serviceAccountId).toBe(SA_ID)
			expect(result.expiresAt).toBeInstanceOf(Date)
		}
	})

	test('[V2] wrong signature (different key) → invalid_signature', async () => {
		const { sign } = await makeKeySetup()
		const jwt = await sign()
		// Verify with DIFFERENT key pair's public key.
		const otherSetup = await makeKeySetup()
		const result = await verifyServiceAccountJwt(jwt, {
			publicKeyPem: otherSetup.publicKeyPem,
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
		})
		expect(result).toEqual({ ok: false, reason: 'invalid_signature' })
	})

	test('[V3] sub mismatch → wrong_subject', async () => {
		const { publicKeyPem, sign } = await makeKeySetup()
		const jwt = await sign({ sub: ALT_SA_ID, iss: ALT_SA_ID })
		const result = await verifyServiceAccountJwt(jwt, {
			publicKeyPem,
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
		})
		expect(result).toEqual({ ok: false, reason: 'wrong_subject' })
	})

	test('[V4] iss !== sub → wrong_issuer (canonical Yandex SA invariant)', async () => {
		const { publicKeyPem, sign } = await makeKeySetup()
		const jwt = await sign({ iss: 'someOtherIssuer' })
		const result = await verifyServiceAccountJwt(jwt, {
			publicKeyPem,
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
		})
		expect(result).toEqual({ ok: false, reason: 'wrong_issuer' })
	})

	test('[V5] aud mismatch → wrong_audience', async () => {
		const { publicKeyPem, sign } = await makeKeySetup()
		const jwt = await sign({ aud: 'app.sepshn.ru' })
		const result = await verifyServiceAccountJwt(jwt, {
			publicKeyPem,
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
		})
		expect(result).toEqual({ ok: false, reason: 'wrong_audience' })
	})

	test('[V6] expired (exp < now) → expired', async () => {
		const { publicKeyPem, sign } = await makeKeySetup()
		const now = Math.floor(Date.now() / 1000)
		// Sign with `now` minus 100s, lifetime 50s → exp = now - 50 (past).
		const jwt = await sign({ now: now - 100, lifetimeSeconds: 50 })
		const result = await verifyServiceAccountJwt(jwt, {
			publicKeyPem,
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
		})
		expect(result).toEqual({ ok: false, reason: 'expired' })
	})

	test('[V7] lifetime > maxLifetime → lifetime_too_long', async () => {
		const { publicKeyPem, sign } = await makeKeySetup()
		const jwt = await sign({ lifetimeSeconds: 7200 }) // 2h
		const result = await verifyServiceAccountJwt(jwt, {
			publicKeyPem,
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
			maxLifetimeSeconds: 3600,
		})
		expect(result).toEqual({ ok: false, reason: 'lifetime_too_long' })
	})

	test('[V8] malformed JWT (not 3 segments) → invalid_format', async () => {
		const { publicKeyPem } = await makeKeySetup()
		const result = await verifyServiceAccountJwt('not.a.jwt.but-four-parts', {
			publicKeyPem,
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
		})
		expect(result).toEqual({ ok: false, reason: 'invalid_format' })
	})

	test('[V9] bad public key PEM → public_key_load_error', async () => {
		const { sign } = await makeKeySetup()
		const jwt = await sign()
		const result = await verifyServiceAccountJwt(jwt, {
			publicKeyPem: 'NOT A PEM',
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
		})
		expect(result).toEqual({ ok: false, reason: 'public_key_load_error' })
	})

	test('[V10] explicit short maxLifetime (5min) enforced', async () => {
		const { publicKeyPem, sign } = await makeKeySetup()
		const jwt = await sign({ lifetimeSeconds: 600 }) // 10min
		const result = await verifyServiceAccountJwt(jwt, {
			publicKeyPem,
			expectedServiceAccountId: SA_ID,
			expectedAudience: AUDIENCE,
			maxLifetimeSeconds: 300, // strict 5min cap
		})
		expect(result).toEqual({ ok: false, reason: 'lifetime_too_long' })
	})
})
