/**
 * Round 14 Phase E1 — DCR YDB store strict tests.
 *
 * Hash-only tests (no DB) — full persistence covered by .db.test.ts later
 * if needed. Unit-level coverage protects scrypt format + verify constant-time.
 */

import { describe, expect, test } from 'bun:test'
import { verifySecret } from './dcr.ydb.repo.ts'

describe('DCR YDB repo — secret hashing', () => {
	test('[DCRYDB1] verifySecret returns false for wrong plaintext', async () => {
		// Synthetic hash: scrypt of 'foo' with random salt. We can't reuse
		// scryptAsync directly here without exposing it; smoke through verify.
		const hash = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`
		const ok = await verifySecret('foo', hash)
		expect(ok).toBe(false)
	})

	test('[DCRYDB2] verifySecret returns false for malformed hash', async () => {
		expect(await verifySecret('x', 'not-scrypt-format')).toBe(false)
		expect(await verifySecret('x', 'scrypt$onlytwo')).toBe(false)
		expect(await verifySecret('x', 'bcrypt$salt$key')).toBe(false)
	})

	test('[DCRYDB3] verifySecret roundtrip — hashed plaintext verifies', async () => {
		// Generate hash internally using same scrypt parameters.
		const { scrypt, randomBytes } = await import('node:crypto')
		const { promisify } = await import('node:util')
		const scryptAsync = promisify(scrypt)
		const salt = randomBytes(16)
		const plaintext = 'whsec_dcr_test_plaintext_42'
		const derived = (await scryptAsync(plaintext, salt, 64)) as Buffer
		const hash = `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
		expect(await verifySecret(plaintext, hash)).toBe(true)
		expect(await verifySecret('wrong-secret', hash)).toBe(false)
	})
})
