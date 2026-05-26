/**
 * Demo SMS inbox route — strict tests (P3, 2026-05-19).
 *
 * Coverage:
 *   - happy path: 200 with captured body
 *   - empty inbox: 200 with body=null
 *   - invalid phone: 400 with structured error
 *   - disabled route: 404 (production posture)
 *   - phone normalization in response (canonical form)
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { __resetDemoInboxSms, initDemoInboxSms } from '../../workers/lib/demo-inbox-sms-adapter.ts'
import { createDemoSmsInboxRoutes } from './sms-inbox.routes.ts'

afterEach(() => {
	__resetDemoInboxSms()
})

describe('createDemoSmsInboxRoutes — disabled', () => {
	test('404 for every request when enabled=false', async () => {
		const app = createDemoSmsInboxRoutes({ enabled: false })
		const res = await app.fetch(new Request('http://test/sms-inbox?phone=%2B79991234567'))
		expect(res.status).toBe(404)
		const json = (await res.json()) as { error: { code: string } }
		expect(json.error.code).toBe('NOT_FOUND')
	})
})

describe('createDemoSmsInboxRoutes — enabled', () => {
	test('empty inbox returns 200 with body=null', async () => {
		const app = createDemoSmsInboxRoutes({ enabled: true })
		const res = await app.fetch(new Request('http://test/sms-inbox?phone=%2B79991234567'))
		expect(res.status).toBe(200)
		const json = (await res.json()) as { data: { phone: string; body: null } }
		expect(json.data.body).toBeNull()
	})

	test('happy path returns captured body', async () => {
		// Round 13 phase B SMS shield + Round 14 self-review #5 fix: use
		// Россвязь reserved-test prefix `+7 000` (per `reserved-test-ranges.ts`
		// canon). Non-reserved-test phones rejected by adapter shield —
		// previous fixture `+79991234567` (real Russian mobile shape) was
		// rejected post-Round-13, causing 1 fail-local-pass-CI flake until
		// caught by Run #112+#113 SC empirical evidence.
		const inbox = initDemoInboxSms()
		await inbox.send({ to: '+70001234567', body: 'OTP: 1234' })
		const app = createDemoSmsInboxRoutes({ enabled: true })
		const res = await app.fetch(new Request('http://test/sms-inbox?phone=%2B70001234567'))
		expect(res.status).toBe(200)
		const json = (await res.json()) as { data: { phone: string; body: string } }
		expect(json.data.body).toBe('OTP: 1234')
		expect(json.data.phone).toBe('+70001234567')
	})

	test('phone normalized к canonical form (spaces stripped)', async () => {
		// Same Round 13 SMS shield — use `+7 000` reserved-test prefix.
		const inbox = initDemoInboxSms()
		await inbox.send({ to: '+7 000 123 45 67', body: 'Hi' })
		const app = createDemoSmsInboxRoutes({ enabled: true })
		// Query string with same formatted phone (URL-encoded spaces).
		const res = await app.fetch(
			new Request('http://test/sms-inbox?phone=%2B7%20000%20123%2045%2067'),
		)
		expect(res.status).toBe(200)
		const json = (await res.json()) as { data: { phone: string; body: string } }
		expect(json.data.phone).toBe('+70001234567') // canonical
		expect(json.data.body).toBe('Hi')
	})

	test('invalid phone format → 400', async () => {
		const app = createDemoSmsInboxRoutes({ enabled: true })
		// No leading + → Zod refine rejects
		const res = await app.fetch(new Request('http://test/sms-inbox?phone=79991234567'))
		expect(res.status).toBe(400)
	})

	test('missing phone query param → 400', async () => {
		const app = createDemoSmsInboxRoutes({ enabled: true })
		const res = await app.fetch(new Request('http://test/sms-inbox'))
		expect(res.status).toBe(400)
	})

	test('CRLF in phone stripped by normalization (canonical hygiene)', async () => {
		// URL-decoded value contains \r\n; normalizePhoneE164 strips \s (incl.
		// CR/LF/TAB) before E.164 validation. Result: canonical phone returned,
		// CRLF never propagates downstream. Safe-by-design — не header smuggle
		// surface because we use NORMALIZED value, not raw query.
		const app = createDemoSmsInboxRoutes({ enabled: true })
		const res = await app.fetch(new Request('http://test/sms-inbox?phone=%2B7999%0D%0A1234567'))
		expect(res.status).toBe(200)
		const json = (await res.json()) as { data: { phone: string } }
		expect(json.data.phone).toBe('+79991234567') // canonical (CRLF stripped)
		expect(json.data.phone).not.toContain('\r')
		expect(json.data.phone).not.toContain('\n')
	})
})
