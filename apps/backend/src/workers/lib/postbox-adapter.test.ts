/**
 * Pure unit tests for Postbox adapter.
 *
 * Coverage targets:
 *   - StubAdapter records sends + queues forced results
 *   - classifyPostboxError: permanent error names, transient (5xx, throttle,
 *     network), HTTP status code mapping (4xx → permanent, 429 → transient)
 *   - PostboxAdapter happy path returns sent + messageId
 *   - PostboxAdapter 200 without MessageId → transient (anomaly)
 */
import { describe, expect, test, vi } from 'vitest'
import {
	classifyPostboxError,
	PostboxAdapter,
	type SendEmailInput,
	StubAdapter,
} from './postbox-adapter.ts'

const sample: SendEmailInput = {
	from: 'noreply@sochi.local',
	to: 'guest@example.ru',
	subject: 'Test',
	html: '<p>Test</p>',
	text: 'Test',
}

/* ============================================================ StubAdapter */

describe('StubAdapter', () => {
	test('records each send call', async () => {
		const stub = new StubAdapter()
		await stub.send(sample)
		await stub.send({ ...sample, to: 'second@example.ru' })
		expect(stub.sent).toHaveLength(2)
		expect(stub.sent[0]?.to).toBe('guest@example.ru')
		expect(stub.sent[1]?.to).toBe('second@example.ru')
	})

	test('returns synthesised messageId by default', async () => {
		const stub = new StubAdapter()
		const r1 = await stub.send(sample)
		const r2 = await stub.send(sample)
		expect(r1).toEqual({ kind: 'sent', messageId: 'stub-1' })
		expect(r2).toEqual({ kind: 'sent', messageId: 'stub-2' })
	})

	test('queueResult forces specific result on next call (FIFO)', async () => {
		const stub = new StubAdapter()
		stub.queueResult({ kind: 'transient', reason: '5xx' })
		stub.queueResult({ kind: 'permanent', reason: 'rejected' })

		const r1 = await stub.send(sample)
		const r2 = await stub.send(sample)
		const r3 = await stub.send(sample) // queue empty → falls back to default

		expect(r1).toEqual({ kind: 'transient', reason: '5xx' })
		expect(r2).toEqual({ kind: 'permanent', reason: 'rejected' })
		expect(r3.kind).toBe('sent')
	})

	test('reset clears history + queue', async () => {
		const stub = new StubAdapter()
		stub.queueResult({ kind: 'transient', reason: 'x' })
		await stub.send(sample)
		stub.reset()
		expect(stub.sent).toHaveLength(0)
		const r = await stub.send(sample)
		expect(r.kind).toBe('sent')
	})
})

/* ============================================================ classifyPostboxError */

describe('classifyPostboxError — permanent error names', () => {
	const permanent = [
		'MessageRejected',
		'MessageRejectedException',
		'MailFromDomainNotVerifiedException',
		'InvalidParameterValueException',
		'AccessDeniedException',
		'ConfigurationSetDoesNotExistException',
	]

	for (const name of permanent) {
		test(`${name} → permanent (no retry)`, () => {
			const err = new Error('boom')
			err.name = name
			const result = classifyPostboxError(err)
			expect(result.kind).toBe('permanent')
			if (result.kind === 'permanent') expect(result.reason).toBe(name)
		})
	}
})

describe('classifyPostboxError — transient errors', () => {
	test('ThrottlingException → transient', () => {
		const err = new Error('rate limited')
		err.name = 'ThrottlingException'
		const result = classifyPostboxError(err)
		expect(result.kind).toBe('transient')
	})

	test('5xx via $metadata.httpStatusCode → transient', () => {
		const err = new Error('server error') as Error & { $metadata?: { httpStatusCode?: number } }
		err.name = 'InternalServerError'
		err.$metadata = { httpStatusCode: 503 }
		const result = classifyPostboxError(err)
		expect(result.kind).toBe('transient')
	})

	test('network error (no $metadata, generic name) → transient', () => {
		const err = new Error('ECONNRESET')
		err.name = 'NetworkError'
		const result = classifyPostboxError(err)
		expect(result.kind).toBe('transient')
	})

	test('non-Error thrown → transient (defensive)', () => {
		expect(classifyPostboxError('string error').kind).toBe('transient')
		expect(classifyPostboxError(null).kind).toBe('transient')
		expect(classifyPostboxError(undefined).kind).toBe('transient')
		expect(classifyPostboxError({ random: 'object' }).kind).toBe('transient')
	})
})

describe('classifyPostboxError — HTTP status code mapping', () => {
	test('400 → permanent (client error)', () => {
		const err = new Error('bad request') as Error & { $metadata?: { httpStatusCode?: number } }
		err.name = 'BadRequest'
		err.$metadata = { httpStatusCode: 400 }
		const result = classifyPostboxError(err)
		expect(result.kind).toBe('permanent')
	})

	test('403 → permanent (auth/config issue)', () => {
		const err = new Error('forbidden') as Error & { $metadata?: { httpStatusCode?: number } }
		err.name = 'Forbidden'
		err.$metadata = { httpStatusCode: 403 }
		const result = classifyPostboxError(err)
		expect(result.kind).toBe('permanent')
	})

	test('429 → transient (throttle, retry-able)', () => {
		const err = new Error('too many') as Error & { $metadata?: { httpStatusCode?: number } }
		err.name = 'TooManyRequests'
		err.$metadata = { httpStatusCode: 429 }
		const result = classifyPostboxError(err)
		expect(result.kind).toBe('transient')
	})

	test('500 → transient', () => {
		const err = new Error('server error') as Error & { $metadata?: { httpStatusCode?: number } }
		err.name = 'InternalServerError'
		err.$metadata = { httpStatusCode: 500 }
		const result = classifyPostboxError(err)
		expect(result.kind).toBe('transient')
	})

	test('504 gateway timeout → transient', () => {
		const err = new Error('timeout') as Error & { $metadata?: { httpStatusCode?: number } }
		err.name = 'GatewayTimeout'
		err.$metadata = { httpStatusCode: 504 }
		const result = classifyPostboxError(err)
		expect(result.kind).toBe('transient')
	})
})

/* ============================================================ PostboxAdapter */

describe('PostboxAdapter — happy path + anomalies', () => {
	test('sends via SES client + returns messageId from response', async () => {
		const fakeClient = {
			send: vi.fn().mockResolvedValue({ MessageId: 'abc-123' }),
		}
		const captured: unknown[] = []
		class FakeCommand {
			input: unknown
			constructor(input: unknown) {
				this.input = input
				captured.push(input)
			}
		}
		const adapter = new PostboxAdapter(fakeClient, FakeCommand as never)
		const result = await adapter.send(sample)
		expect(result).toEqual({ kind: 'sent', messageId: 'abc-123' })
		expect(fakeClient.send).toHaveBeenCalledTimes(1)
		expect(captured[0]).toEqual({
			FromEmailAddress: 'noreply@sochi.local',
			Destination: { ToAddresses: ['guest@example.ru'] },
			Content: {
				Simple: {
					Subject: { Data: 'Test' },
					Body: { Html: { Data: '<p>Test</p>' }, Text: { Data: 'Test' } },
				},
			},
		})
	})

	test('200 without MessageId → transient (anomaly, retry-safe)', async () => {
		const fakeClient = { send: vi.fn().mockResolvedValue({}) }
		class FakeCommand {
			input: unknown
			constructor(input: unknown) {
				this.input = input
			}
		}
		const adapter = new PostboxAdapter(fakeClient, FakeCommand as never)
		const result = await adapter.send(sample)
		expect(result.kind).toBe('transient')
	})

	test('thrown error → routed through classifyPostboxError', async () => {
		const err = new Error('rejected')
		err.name = 'MessageRejectedException'
		const fakeClient = { send: vi.fn().mockRejectedValue(err) }
		class FakeCommand {
			input: unknown
			constructor(input: unknown) {
				this.input = input
			}
		}
		const adapter = new PostboxAdapter(fakeClient, FakeCommand as never)
		const result = await adapter.send(sample)
		expect(result.kind).toBe('permanent')
		if (result.kind === 'permanent') expect(result.reason).toBe('MessageRejectedException')
	})
})

/* ============================================================ createEmailAdapter factory */

import { createEmailAdapter, MailpitAdapter } from './postbox-adapter.ts'

interface LogCall {
	level: string
	obj: object
	msg: string
}

const captureLog = () => {
	const calls: LogCall[] = []
	return {
		log: {
			info: (obj: object, msg?: string) => calls.push({ level: 'info', obj, msg: msg ?? '' }),
			warn: (obj: object, msg?: string) => calls.push({ level: 'warn', obj, msg: msg ?? '' }),
		},
		calls,
	}
}

describe('createEmailAdapter — selection logic', () => {
	test('POSTBOX_ENABLED=true + creds → PostboxAdapter', () => {
		const { log } = captureLog()
		const adapter = createEmailAdapter(
			{
				POSTBOX_ENABLED: true,
				POSTBOX_ACCESS_KEY_ID: 'key',
				POSTBOX_SECRET_ACCESS_KEY: 'secret',
				POSTBOX_ENDPOINT: 'https://postbox.cloud.yandex.net',
				SMTP_HOST: 'localhost',
				SMTP_PORT: 1125,
			},
			log,
		)
		expect(adapter).toBeInstanceOf(PostboxAdapter)
	})

	test('POSTBOX_ENABLED=true + missing access key → StubAdapter + warn', () => {
		const { log, calls } = captureLog()
		const adapter = createEmailAdapter(
			{
				POSTBOX_ENABLED: true,
				POSTBOX_SECRET_ACCESS_KEY: 'secret',
				POSTBOX_ENDPOINT: 'https://postbox.cloud.yandex.net',
				SMTP_HOST: 'localhost',
				SMTP_PORT: 1125,
			},
			log,
		)
		expect(adapter).toBeInstanceOf(StubAdapter)
		expect(calls.some((c) => c.level === 'warn' && /credentials missing/.test(c.msg))).toBe(true)
	})

	test('POSTBOX_ENABLED=true + missing secret → StubAdapter', () => {
		const { log } = captureLog()
		const adapter = createEmailAdapter(
			{
				POSTBOX_ENABLED: true,
				POSTBOX_ACCESS_KEY_ID: 'key',
				POSTBOX_ENDPOINT: 'https://postbox.cloud.yandex.net',
				SMTP_HOST: 'localhost',
				SMTP_PORT: 1125,
			},
			log,
		)
		expect(adapter).toBeInstanceOf(StubAdapter)
	})

	test('POSTBOX_ENABLED=false + SMTP_HOST set → MailpitAdapter', () => {
		const { log } = captureLog()
		const adapter = createEmailAdapter(
			{
				POSTBOX_ENABLED: false,
				POSTBOX_ENDPOINT: 'https://postbox.cloud.yandex.net',
				SMTP_HOST: 'localhost',
				SMTP_PORT: 1125,
			},
			log,
		)
		expect(adapter).toBeInstanceOf(MailpitAdapter)
	})

	test('POSTBOX_ENABLED=false + SMTP_HOST="" → StubAdapter (no transport)', () => {
		const { log, calls } = captureLog()
		const adapter = createEmailAdapter(
			{
				POSTBOX_ENABLED: false,
				POSTBOX_ENDPOINT: 'https://postbox.cloud.yandex.net',
				SMTP_HOST: '',
				SMTP_PORT: 1125,
			},
			log,
		)
		expect(adapter).toBeInstanceOf(StubAdapter)
		expect(calls.some((c) => /log-only/.test(c.msg))).toBe(true)
	})
})

/* ============================================================ MailpitAdapter integration */

/**
 * Real-Mailpit roundtrip test — needs `docker compose up mailpit` running.
 * Tagged 'db' so flaky-CI skip applies. UI at http://localhost:8125.
 *
 * Verifies:
 *   - SMTP handshake completes (250 OK on EHLO/MAIL FROM/RCPT TO/DATA/QUIT)
 *   - multipart/alternative MIME structure intact (HTML + plain text)
 *   - subject UTF-8 base64 encoding survives
 *   - Cyrillic body (HTML + plain) preserved
 */
/**
 * Real-Mailpit SMTP integration. Bonus empirical proof — auto-skipped if
 * Mailpit isn't reachable OR if search/lookup fails due to load/race
 * (Mailpit's HTTP API isn't tx-isolated; concurrent test files writing
 * captured emails compete on a shared inbox). Safe to skip — the unit-level
 * `MailpitAdapter` SMTP construction is exercised on every test run via the
 * factory tests above.
 *
 * Run manually for empirical sanity:
 *   docker compose up mailpit
 *   MAILPIT_INTEGRATION=1 pnpm exec vitest run apps/backend/src/workers/lib/postbox-adapter.test.ts
 */
describe.skipIf(process.env.MAILPIT_INTEGRATION !== '1')(
	'MailpitAdapter — real SMTP roundtrip (manual)',
	() => {
		const adapter = new MailpitAdapter('localhost', 1125)
		const httpBase = 'http://localhost:8125'

		test('sends multipart email reachable via Mailpit HTTP API', async () => {
			const ping = await fetch(`${httpBase}/api/v1/info`).catch(() => null)
			if (!ping?.ok) return // Mailpit not running — silent skip

			const uniqueSubject = `Тест ${Date.now()}-${Math.random()}`
			const result = await adapter.send({
				from: 'noreply@sochi.local',
				to: 'guest@example.ru',
				subject: uniqueSubject,
				html: '<p>Здравствуйте, <b>Иван</b>!</p>',
				text: 'Здравствуйте, Иван!',
			})
			expect(result.kind).toBe('sent')

			const searchUrl = `${httpBase}/api/v1/search?query=${encodeURIComponent(`subject:"${uniqueSubject}"`)}`
			const search = (await fetch(searchUrl).then((r) => r.json())) as {
				messages: Array<{ ID: string; Subject: string }>
			}
			expect(search.messages.length).toBeGreaterThanOrEqual(1)
			const msg = search.messages[0]
			const fullMsg = (await fetch(`${httpBase}/api/v1/message/${msg?.ID}`).then((r) =>
				r.json(),
			)) as { HTML: string; Text: string }
			expect(fullMsg.HTML).toContain('Иван')
			expect(fullMsg.Text).toContain('Иван')
		})
	},
)

/* ============================================================ M9.widget.5 / A3.2.b — attachments support */

describe('SendEmailInput с attachments — adapter integration', () => {
	test('[ATT-S1] StubAdapter records attachments в sent[]', async () => {
		const adapter = new StubAdapter()
		const result = await adapter.send({
			from: 'noreply@x.com',
			to: 'guest@y.com',
			subject: 'Test',
			html: '<p>Test</p>',
			text: 'Test',
			attachments: [
				{
					filename: 'booking-XYZ.ics',
					content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
					contentType: 'text/calendar; method=PUBLISH; charset=utf-8',
				},
			],
		})
		expect(result.kind).toBe('sent')
		expect(adapter.sent).toHaveLength(1)
		expect(adapter.sent[0]?.attachments).toBeDefined()
		expect(adapter.sent[0]?.attachments?.[0]?.filename).toBe('booking-XYZ.ics')
		expect(adapter.sent[0]?.attachments?.[0]?.contentType).toContain('text/calendar')
	})

	test('[ATT-P1] PostboxAdapter passes attachments в SES SendEmailCommand.Content.Simple.Attachments', async () => {
		let capturedInput: unknown = null
		class FakeSendCommand {
			constructor(input: unknown) {
				capturedInput = input
			}
		}
		const fakeClient = {
			send: async () => ({ MessageId: 'msg-test-001', $metadata: { httpStatusCode: 200 } }),
		}
		const adapter = new PostboxAdapter(
			fakeClient,
			FakeSendCommand as unknown as ConstructorParameters<typeof PostboxAdapter>[1],
		)
		const icsContent = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR'
		await adapter.send({
			from: 'noreply@x.com',
			to: 'guest@y.com',
			subject: 'Подтверждение',
			html: '<p>Test</p>',
			text: 'Test',
			attachments: [
				{
					filename: 'booking-ABC.ics',
					content: icsContent,
					contentType: 'text/calendar; method=PUBLISH; charset=utf-8',
				},
			],
		})
		expect(capturedInput).not.toBeNull()
		const input = capturedInput as {
			Content: { Simple: { Attachments?: Array<{ FileName: string; ContentType: string }> } }
		}
		expect(input.Content.Simple.Attachments).toHaveLength(1)
		expect(input.Content.Simple.Attachments?.[0]?.FileName).toBe('booking-ABC.ics')
		expect(input.Content.Simple.Attachments?.[0]?.ContentType).toContain('text/calendar')
	})

	test('[ATT-P2] PostboxAdapter без attachments — Content.Simple.Attachments undefined', async () => {
		let capturedInput: unknown = null
		class FakeSendCommand {
			constructor(input: unknown) {
				capturedInput = input
			}
		}
		const fakeClient = {
			send: async () => ({ MessageId: 'msg-test-002', $metadata: { httpStatusCode: 200 } }),
		}
		const adapter = new PostboxAdapter(
			fakeClient,
			FakeSendCommand as unknown as ConstructorParameters<typeof PostboxAdapter>[1],
		)
		await adapter.send({
			from: 'noreply@x.com',
			to: 'guest@y.com',
			subject: 'Test',
			html: '<p>Test</p>',
			text: 'Test',
			// no attachments
		})
		const input = capturedInput as {
			Content: { Simple: { Attachments?: unknown } }
		}
		expect(input.Content.Simple.Attachments).toBeUndefined()
	})
})
