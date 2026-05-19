/**
 * DemoInboxSmsAdapter — strict unit tests (P3, 2026-05-19).
 *
 * Coverage:
 *   - happy path: send → captured → getLatest
 *   - phone normalization (spaces, dashes, parens stripped)
 *   - invalid phone → permanent error без capture
 *   - empty body → permanent error
 *   - TTL expiry — old captures filtered
 *   - per-recipient ring buffer cap (MAX_PER_RECIPIENT)
 *   - global LRU cap (MAX_TOTAL_RECIPIENTS)
 *   - cross-test isolation via clear()
 *   - getLatest returns null for unknown phone
 */

import { describe, expect, test } from 'bun:test'
import {
	DemoInboxSmsAdapter,
	DEFAULT_TTL_MS,
	MAX_PER_RECIPIENT,
	MAX_TOTAL_RECIPIENTS,
} from './demo-inbox-sms-adapter.ts'

describe('DemoInboxSmsAdapter — send', () => {
	test('happy path — captures + returns sent messageId', async () => {
		const adapter = new DemoInboxSmsAdapter()
		const result = await adapter.send({ to: '+79991234567', body: 'OTP: 1234' })
		expect(result.kind).toBe('sent')
		if (result.kind === 'sent') {
			expect(result.messageId).toMatch(/^demo-sms-/)
		}
		const captured = adapter.getLatest('+79991234567')
		expect(captured?.body).toBe('OTP: 1234')
	})

	test('phone normalization — strips spaces / dashes / parens', async () => {
		const adapter = new DemoInboxSmsAdapter()
		await adapter.send({ to: '+7 (999) 123-45-67', body: 'Hello' })
		const captured = adapter.getLatest('+79991234567')
		expect(captured?.body).toBe('Hello')
		expect(captured?.to).toBe('+79991234567')
	})

	test('international phones accepted (E.164 format)', async () => {
		const adapter = new DemoInboxSmsAdapter()
		const result = await adapter.send({ to: '+12025550100', body: 'Hi' })
		expect(result.kind).toBe('sent')
		expect(adapter.getLatest('+12025550100')?.body).toBe('Hi')
	})

	test('invalid phone → permanent error без capture', async () => {
		const adapter = new DemoInboxSmsAdapter()
		// Missing +
		const r1 = await adapter.send({ to: '79991234567', body: 'X' })
		expect(r1.kind).toBe('permanent')
		// Too short
		const r2 = await adapter.send({ to: '+7999', body: 'X' })
		expect(r2.kind).toBe('permanent')
		// Letters mixed
		const r3 = await adapter.send({ to: '+7abc1234567', body: 'X' })
		expect(r3.kind).toBe('permanent')
		// Empty string
		const r4 = await adapter.send({ to: '', body: 'X' })
		expect(r4.kind).toBe('permanent')
		expect(adapter.recipientCount()).toBe(0)
	})

	test('CRLF in phone canonicalized via \\s strip (defense-in-depth)', async () => {
		// normalizePhoneE164 strips \s (incl. CR/LF/TAB) before E.164 validation.
		// Result: CRLF stripped к canonical phone — captured safely. Downstream
		// uses normalized value, NEVER raw — CRLF never propagates к header
		// smuggle surface.
		const adapter = new DemoInboxSmsAdapter()
		const r = await adapter.send({ to: '+7999\r\n1234567', body: 'X' })
		expect(r.kind).toBe('sent')
		// Captured phone is canonical (CRLF stripped).
		const captured = adapter.getLatest('+79991234567')
		expect(captured?.body).toBe('X')
		expect(captured?.to).toBe('+79991234567')
		expect(captured?.to).not.toContain('\r')
		expect(captured?.to).not.toContain('\n')
	})

	test('empty body rejected', async () => {
		const adapter = new DemoInboxSmsAdapter()
		const result = await adapter.send({ to: '+79991234567', body: '' })
		expect(result.kind).toBe('permanent')
	})
})

describe('DemoInboxSmsAdapter — TTL', () => {
	test('expired captures filtered', async () => {
		let now = 1_000_000
		const adapter = new DemoInboxSmsAdapter({
			now: () => now,
			ttlMs: 1000,
		})
		await adapter.send({ to: '+79991234567', body: 'Fresh' })
		expect(adapter.getLatest('+79991234567')?.body).toBe('Fresh')
		now += 1500 // past TTL
		expect(adapter.getLatest('+79991234567')).toBeNull()
	})

	test('latest non-expired returned when multiple captures', async () => {
		let now = 1_000_000
		const adapter = new DemoInboxSmsAdapter({
			now: () => now,
			ttlMs: 10_000,
		})
		await adapter.send({ to: '+79991234567', body: 'First' })
		now += 1000
		await adapter.send({ to: '+79991234567', body: 'Second' })
		expect(adapter.getLatest('+79991234567')?.body).toBe('Second')
	})

	test('default TTL is 5 minutes', () => {
		expect(DEFAULT_TTL_MS).toBe(5 * 60 * 1000)
	})
})

describe('DemoInboxSmsAdapter — bounded memory', () => {
	test('per-recipient ring buffer cap', async () => {
		const adapter = new DemoInboxSmsAdapter()
		for (let i = 0; i < MAX_PER_RECIPIENT + 5; i++) {
			await adapter.send({ to: '+79991234567', body: `msg-${i}` })
		}
		// Should have only MAX_PER_RECIPIENT (oldest dropped)
		const latest = adapter.getLatest('+79991234567')
		expect(latest?.body).toBe(`msg-${MAX_PER_RECIPIENT + 4}`)
	})

	test('global LRU evicts oldest recipient at cap', async () => {
		const adapter = new DemoInboxSmsAdapter()
		// Fill к cap
		for (let i = 0; i < MAX_TOTAL_RECIPIENTS; i++) {
			const phone = `+7999${String(i).padStart(7, '0')}`
			await adapter.send({ to: phone, body: 'x' })
		}
		expect(adapter.recipientCount()).toBe(MAX_TOTAL_RECIPIENTS)
		// One more — first phone evicted
		await adapter.send({ to: '+71111111111', body: 'new' })
		expect(adapter.recipientCount()).toBe(MAX_TOTAL_RECIPIENTS)
		expect(adapter.getLatest('+79990000000')).toBeNull() // first phone evicted
		expect(adapter.getLatest('+71111111111')?.body).toBe('new')
	})
})

describe('DemoInboxSmsAdapter — lookup invariants', () => {
	test('getLatest returns null for unknown phone', () => {
		const adapter = new DemoInboxSmsAdapter()
		expect(adapter.getLatest('+79999999999')).toBeNull()
	})

	test('getLatest returns null for malformed lookup', () => {
		const adapter = new DemoInboxSmsAdapter()
		expect(adapter.getLatest('not-a-phone')).toBeNull()
	})

	test('clear() resets all buckets', async () => {
		const adapter = new DemoInboxSmsAdapter()
		await adapter.send({ to: '+79991234567', body: 'x' })
		expect(adapter.recipientCount()).toBe(1)
		adapter.clear()
		expect(adapter.recipientCount()).toBe(0)
		expect(adapter.getLatest('+79991234567')).toBeNull()
	})

	test('different phones isolated in buckets', async () => {
		const adapter = new DemoInboxSmsAdapter()
		await adapter.send({ to: '+79991234567', body: 'A' })
		await adapter.send({ to: '+79997654321', body: 'B' })
		expect(adapter.getLatest('+79991234567')?.body).toBe('A')
		expect(adapter.getLatest('+79997654321')?.body).toBe('B')
	})
})
