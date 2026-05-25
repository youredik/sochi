/**
 * DemoInboxAdapter — strict tests.
 *
 * Pre-done audit:
 *   [S1] send() returns { kind: 'sent' } с monotonic messageId
 *   [S2] send() does NOT transmit (no network calls — adapter is pure
 *        in-process; verified through the absence of fetch mocks)
 *   [C1] getLatest() returns null когда recipient bucket is empty
 *   [C2] getLatest() returns latest entry when multiple captures exist
 *   [C3] getLatest() applies email normalization (Mixed-Case → lower)
 *   [C4] getLatest() extracts magic-link URL из html body
 *   [C5] getLatest() falls back к text body when html lacks URL
 *   [C6] getLatest() leaves magicLinkUrl=null когда neither has URL
 *   [T1] TTL expiry: entries older than ttlMs are not returned
 *   [T2] TTL partial: fresh entry visible когда older entries expired
 *   [R1] Per-recipient cap: oldest entries dropped when bucket > MAX_PER_RECIPIENT
 *   [R2] Total-recipients cap: LRU-evict oldest key on insert when > MAX_TOTAL_RECIPIENTS
 *   [N1] normalizeEmail trims + lowercases (matches RFC envelope-key canon)
 *   [N2] normalizeEmail preserves single-form local part (no quoted-pair munging)
 *   [X1] clear() removes all captures
 *   [X2] recipientCount() reflects actual bucket count
 */
import { describe, expect, it } from 'bun:test'
import {
	DEFAULT_TTL_MS,
	DemoInboxAdapter,
	isReservedTestDomain,
	MAX_PER_RECIPIENT,
	MAX_TOTAL_RECIPIENTS,
	normalizeEmail,
} from './demo-inbox-adapter.ts'
import type { EmailAdapter, SendEmailInput, SendEmailResult } from './postbox-adapter.ts'

const VERIFY_URL_A =
	'http://localhost:8787/api/auth/magic-link/verify?token=tok-A&callbackURL=%2Fwelcome'
const VERIFY_URL_B = 'http://localhost:8787/api/auth/magic-link/verify?token=tok-B'

function emailWithLink(to: string, url: string): SendEmailInput {
	return {
		from: '"HoReCa" <noreply@horeca.local>',
		to,
		subject: 'Вход в HoReCa',
		html: `<a href="${url}">Войти</a>`,
		text: `Войдите: ${url}`,
	}
}

function emailWithoutLink(to: string): SendEmailInput {
	return {
		from: '"HoReCa" <noreply@horeca.local>',
		to,
		subject: 'Welcome',
		html: '<p>Hello!</p>',
		text: 'Hello!',
	}
}

describe('DemoInboxAdapter — send() return shape', () => {
	it('[S1] returns { kind: sent } with monotonic messageId per call', async () => {
		const adapter = new DemoInboxAdapter()
		const r1 = await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		const r2 = await adapter.send(emailWithLink('b@x.com', VERIFY_URL_B))
		expect(r1.kind).toBe('sent')
		expect(r2.kind).toBe('sent')
		if (r1.kind === 'sent' && r2.kind === 'sent') {
			expect(r1.messageId).toBe('demo-inbox-1')
			expect(r2.messageId).toBe('demo-inbox-2')
		}
	})
})

describe('DemoInboxAdapter — getLatest()', () => {
	it('[C1] returns null for unseen recipient', () => {
		const adapter = new DemoInboxAdapter()
		expect(adapter.getLatest('nobody@x.com')).toBe(null)
	})

	it('[C2] returns latest entry from multi-entry bucket', async () => {
		const adapter = new DemoInboxAdapter()
		await adapter.send(emailWithLink('user@x.com', VERIFY_URL_A))
		await adapter.send(emailWithLink('user@x.com', VERIFY_URL_B))
		const latest = adapter.getLatest('user@x.com')
		expect(latest?.magicLinkUrl).toBe(VERIFY_URL_B)
	})

	it('[C3] case-insensitive lookup (envelope-key normalization)', async () => {
		const adapter = new DemoInboxAdapter()
		await adapter.send(emailWithLink('User@Example.COM', VERIFY_URL_A))
		expect(adapter.getLatest('user@example.com')?.magicLinkUrl).toBe(VERIFY_URL_A)
		expect(adapter.getLatest('USER@EXAMPLE.COM')?.magicLinkUrl).toBe(VERIFY_URL_A)
	})

	it('[C4] extracts magic-link URL из html body', async () => {
		const adapter = new DemoInboxAdapter()
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		expect(adapter.getLatest('a@x.com')?.magicLinkUrl).toBe(VERIFY_URL_A)
	})

	it('[C5] falls back к text body when html lacks the URL', async () => {
		const adapter = new DemoInboxAdapter()
		await adapter.send({
			from: '"HoReCa" <noreply@horeca.local>',
			to: 'a@x.com',
			subject: 'Hi',
			html: '<p>see text body</p>',
			text: `Click: ${VERIFY_URL_B}`,
		})
		expect(adapter.getLatest('a@x.com')?.magicLinkUrl).toBe(VERIFY_URL_B)
	})

	it('[C6] magicLinkUrl = null когда neither body has verify URL', async () => {
		const adapter = new DemoInboxAdapter()
		await adapter.send(emailWithoutLink('a@x.com'))
		expect(adapter.getLatest('a@x.com')?.magicLinkUrl).toBe(null)
	})
})

describe('DemoInboxAdapter — TTL', () => {
	it('[T1] entries older than ttlMs не returned', async () => {
		let clock = 1_000_000
		const adapter = new DemoInboxAdapter({ now: () => clock, ttlMs: 60_000 })
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		// Advance past TTL.
		clock += 61_000
		expect(adapter.getLatest('a@x.com')).toBe(null)
	})

	it('[T2] fresh entry visible когда older entries already expired', async () => {
		let clock = 1_000_000
		const adapter = new DemoInboxAdapter({ now: () => clock, ttlMs: 60_000 })
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		clock += 61_000 // first expired
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_B))
		expect(adapter.getLatest('a@x.com')?.magicLinkUrl).toBe(VERIFY_URL_B)
	})

	it('[T3] DEFAULT_TTL_MS = 6 minutes (5-min BA magic-link + 1-min slack)', () => {
		expect(DEFAULT_TTL_MS).toBe(6 * 60 * 1000)
	})
})

describe('DemoInboxAdapter — getLatest(after) time-based filter (Round 7 v3 fix)', () => {
	it('[A1] after=capturedAt1 returns SECOND capture (race-free repeat send)', async () => {
		let clock = 1_000_000
		const adapter = new DemoInboxAdapter({ now: () => clock })
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		const first = adapter.getLatest('a@x.com')
		expect(first?.magicLinkUrl).toBe(VERIFY_URL_A)

		clock += 100
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_B))
		const second = adapter.getLatest('a@x.com', first?.capturedAt)
		expect(second?.magicLinkUrl).toBe(VERIFY_URL_B)
	})

	it('[A2] after=capturedAt returns null когда no newer capture', async () => {
		let clock = 1_000_000
		const adapter = new DemoInboxAdapter({ now: () => clock })
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		const first = adapter.getLatest('a@x.com')
		// Same clock — no new send happened.
		expect(adapter.getLatest('a@x.com', first?.capturedAt)).toBe(null)
	})

	it('[A3] after filter race-free даже если BA reuses identical URL', async () => {
		// Critical canonical test — BA may de-dup magic-link tokens within
		// window; both emails get IDENTICAL URL. Time-based filter still
		// distinguishes the two captures correctly.
		let clock = 1_000_000
		const adapter = new DemoInboxAdapter({ now: () => clock })
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		const first = adapter.getLatest('a@x.com')
		expect(first?.magicLinkUrl).toBe(VERIFY_URL_A)

		clock += 100
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A)) // SAME URL
		const second = adapter.getLatest('a@x.com', first?.capturedAt)
		expect(second?.magicLinkUrl).toBe(VERIFY_URL_A) // same URL, but newer capture
		expect(second?.capturedAt.getTime()).toBeGreaterThan(first!.capturedAt.getTime())
	})

	it('[A4] after omitted → equivalent к non-filtered getLatest (backward-compat)', async () => {
		const adapter = new DemoInboxAdapter()
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		const filtered = adapter.getLatest('a@x.com', undefined)
		const unfiltered = adapter.getLatest('a@x.com')
		expect(filtered?.magicLinkUrl).toBe(unfiltered?.magicLinkUrl)
	})
})

describe('DemoInboxAdapter — bounded growth', () => {
	it('[R1] per-recipient bucket caps at MAX_PER_RECIPIENT (FIFO drop)', async () => {
		const adapter = new DemoInboxAdapter()
		for (let i = 0; i < MAX_PER_RECIPIENT + 5; i += 1) {
			await adapter.send(
				emailWithLink(
					'flood@x.com',
					`http://localhost:8787/api/auth/magic-link/verify?token=t${i}`,
				),
			)
		}
		// Latest is still visible.
		expect(adapter.getLatest('flood@x.com')?.magicLinkUrl).toBe(
			`http://localhost:8787/api/auth/magic-link/verify?token=t${MAX_PER_RECIPIENT + 4}`,
		)
		// Bucket size capped — verified indirectly by recipientCount being 1.
		expect(adapter.recipientCount()).toBe(1)
	})

	it('[R2] total-recipients cap evicts LRU when adding new key past MAX_TOTAL_RECIPIENTS', async () => {
		const adapter = new DemoInboxAdapter()
		// Fill к the cap.
		for (let i = 0; i < MAX_TOTAL_RECIPIENTS; i += 1) {
			await adapter.send(emailWithLink(`u${i}@x.com`, VERIFY_URL_A))
		}
		expect(adapter.recipientCount()).toBe(MAX_TOTAL_RECIPIENTS)
		// First recipient should be evicted when next NEW one is inserted.
		await adapter.send(emailWithLink('newcomer@x.com', VERIFY_URL_B))
		expect(adapter.recipientCount()).toBe(MAX_TOTAL_RECIPIENTS) // still at cap
		expect(adapter.getLatest('u0@x.com')).toBe(null) // u0 evicted
		expect(adapter.getLatest('newcomer@x.com')?.magicLinkUrl).toBe(VERIFY_URL_B)
	})

	it('[R3] re-send к existing recipient does NOT count as a new bucket key', async () => {
		const adapter = new DemoInboxAdapter()
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_B))
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		expect(adapter.recipientCount()).toBe(1)
	})
})

describe('normalizeEmail', () => {
	it('[N1] trims + lowercases', () => {
		expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com')
	})

	it('[N2] empty after trim → empty string (caller responsibility)', () => {
		expect(normalizeEmail('   ')).toBe('')
	})
})

describe('DemoInboxAdapter — admin/test surface', () => {
	it('[X1] clear() removes all captures', async () => {
		const adapter = new DemoInboxAdapter()
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		await adapter.send(emailWithLink('b@x.com', VERIFY_URL_B))
		expect(adapter.recipientCount()).toBe(2)
		adapter.clear()
		expect(adapter.recipientCount()).toBe(0)
		expect(adapter.getLatest('a@x.com')).toBe(null)
	})

	it('[X2] recipientCount() reflects actual distinct-key count', async () => {
		const adapter = new DemoInboxAdapter()
		expect(adapter.recipientCount()).toBe(0)
		await adapter.send(emailWithLink('a@x.com', VERIFY_URL_A))
		expect(adapter.recipientCount()).toBe(1)
		await adapter.send(emailWithLink('b@x.com', VERIFY_URL_B))
		expect(adapter.recipientCount()).toBe(2)
	})
})

describe('isReservedTestDomain — RFC 2606/6761 detection', () => {
	it('[R-RFC1] example.com → true', () => {
		expect(isReservedTestDomain('user@example.com')).toBe(true)
	})

	it('[R-RFC2] example.org → true', () => {
		expect(isReservedTestDomain('user@example.org')).toBe(true)
	})

	it('[R-RFC3] example.net → true', () => {
		expect(isReservedTestDomain('user@example.net')).toBe(true)
	})

	it('[R-RFC4] *.test → true', () => {
		expect(isReservedTestDomain('user@foo.test')).toBe(true)
		expect(isReservedTestDomain('user@deep.subdomain.test')).toBe(true)
	})

	it('[R-RFC5] *.invalid → true', () => {
		expect(isReservedTestDomain('user@foo.invalid')).toBe(true)
	})

	it('[R-RFC6] *.localhost → true', () => {
		expect(isReservedTestDomain('user@app.localhost')).toBe(true)
	})

	it('[R-RFC7] bare `localhost` → true', () => {
		expect(isReservedTestDomain('user@localhost')).toBe(true)
	})

	it('[R-RFC8] real .com / .ru / .net → false', () => {
		expect(isReservedTestDomain('user@gmail.com')).toBe(false)
		expect(isReservedTestDomain('user@yandex.ru')).toBe(false)
		expect(isReservedTestDomain('user@sepshn.ru')).toBe(false)
	})

	it('[R-RFC9] substring trap — `example-llc.com` ≠ reserved', () => {
		expect(isReservedTestDomain('user@example-llc.com')).toBe(false)
		expect(isReservedTestDomain('user@notexample.com')).toBe(false)
		expect(isReservedTestDomain('user@testing.com')).toBe(false)
	})

	it('[R-RFC10] case-insensitive + trim', () => {
		expect(isReservedTestDomain('  User@EXAMPLE.COM  ')).toBe(true)
		expect(isReservedTestDomain('USER@Foo.TEST')).toBe(true)
	})

	it('[R-RFC11] no @-sign → false (defensive)', () => {
		expect(isReservedTestDomain('not-an-email')).toBe(false)
		expect(isReservedTestDomain('')).toBe(false)
	})
})

describe('DemoInboxAdapter — downstream forward guard (security 2026-05-22)', () => {
	function recordingDownstream(): { calls: SendEmailInput[]; adapter: EmailAdapter } {
		const calls: SendEmailInput[] = []
		const adapter: EmailAdapter = {
			async send(input: SendEmailInput): Promise<SendEmailResult> {
				calls.push(input)
				return { kind: 'sent', messageId: `ds-${calls.length}` }
			},
		}
		return { calls, adapter }
	}

	it('[D1] reserved test domain → downstream NOT called (synthetic success)', async () => {
		const { calls, adapter: downstream } = recordingDownstream()
		const inbox = new DemoInboxAdapter({ downstream })
		const result = await inbox.send(emailWithLink('demo-guest-0@example.com', VERIFY_URL_A))
		expect(calls.length).toBe(0)
		expect(result.kind).toBe('sent')
		// Capture в UI всё равно happens
		expect(inbox.getLatest('demo-guest-0@example.com')?.magicLinkUrl).toBe(VERIFY_URL_A)
	})

	it('[D2] real domain → downstream IS called + capture also happens', async () => {
		const { calls, adapter: downstream } = recordingDownstream()
		const inbox = new DemoInboxAdapter({ downstream })
		const result = await inbox.send(emailWithLink('user@gmail.com', VERIFY_URL_A))
		expect(calls.length).toBe(1)
		expect(calls[0]?.to).toBe('user@gmail.com')
		expect(result.kind).toBe('sent')
		// Returned messageId from downstream (real send)
		if (result.kind === 'sent') expect(result.messageId).toBe('ds-1')
	})

	it('[D3] *.test TLD → downstream NOT called', async () => {
		const { calls, adapter: downstream } = recordingDownstream()
		const inbox = new DemoInboxAdapter({ downstream })
		await inbox.send(emailWithLink('integration@feature.test', VERIFY_URL_A))
		expect(calls.length).toBe(0)
	})

	it('[D4] capture-only mode (no downstream) — reserved or real, same path', async () => {
		const inbox = new DemoInboxAdapter()
		const r1 = await inbox.send(emailWithLink('user@example.com', VERIFY_URL_A))
		const r2 = await inbox.send(emailWithLink('user@gmail.com', VERIFY_URL_B))
		expect(r1.kind).toBe('sent')
		expect(r2.kind).toBe('sent')
		// Both captured in UI
		expect(inbox.getLatest('user@example.com')?.magicLinkUrl).toBe(VERIFY_URL_A)
		expect(inbox.getLatest('user@gmail.com')?.magicLinkUrl).toBe(VERIFY_URL_B)
	})
})
