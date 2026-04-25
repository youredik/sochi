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
