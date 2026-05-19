/**
 * Strict unit tests для evaluateReadiness (B7 info-leak fix, 2026-05-19).
 *
 * Pins the public payload shape so any future regression к leaking exception
 * messages / adapter names through the response body breaks here.
 */

import { describe, expect, test } from 'bun:test'
import { evaluateReadiness, type ReadinessProbeInput } from './readiness.ts'

interface LoggedCall {
	obj: Record<string, unknown>
	msg?: string | undefined
}

function makeLogger() {
	const calls: LoggedCall[] = []
	return {
		calls,
		error: (obj: Record<string, unknown>, msg?: string) => {
			calls.push({ obj, msg })
		},
	}
}

function makeInput(overrides: Partial<ReadinessProbeInput>): ReadinessProbeInput {
	return {
		appMode: 'sandbox',
		permittedMockAdapters: [],
		adapters: [],
		probeYdb: async () => true,
		logger: { error: () => undefined },
		...overrides,
	}
}

describe('evaluateReadiness — happy path', () => {
	test('YDB ok + no offending adapters → status=ok, 200, all checks pass', async () => {
		const result = await evaluateReadiness(makeInput({}))
		expect(result.status).toBe('ok')
		expect(result.statusCode).toBe(200)
		expect(result.checks).toEqual([
			{ name: 'ydb', ok: true },
			{ name: 'adapters', ok: true },
		])
	})

	test('sandbox mode permits mock/sandbox adapters (no offender check)', async () => {
		const result = await evaluateReadiness(
			makeInput({
				appMode: 'sandbox',
				adapters: [
					{ name: 'payment.stub', mode: 'mock' },
					{ name: 'email.demo-inbox', mode: 'mock' },
				],
			}),
		)
		expect(result.status).toBe('ok')
		expect(result.statusCode).toBe(200)
		expect(result.checks.find((c) => c.name === 'adapters')?.ok).toBe(true)
	})

	test('production mode permits whitelisted mock adapters', async () => {
		const result = await evaluateReadiness(
			makeInput({
				appMode: 'production',
				adapters: [{ name: 'email.demo-inbox', mode: 'mock' }],
				permittedMockAdapters: ['email.demo-inbox'],
			}),
		)
		expect(result.statusCode).toBe(200)
	})
})

describe('evaluateReadiness — info-leak defense (CRITICAL — OWASP API3:2023)', () => {
	test('YDB exception → 503 + check shape contains ONLY {name, ok}, NEVER error message', async () => {
		const logger = makeLogger()
		const result = await evaluateReadiness(
			makeInput({
				probeYdb: async () => {
					throw new Error('YDB connection refused at grpc://localhost:2236 (CVE-leak-vector)')
				},
				logger,
			}),
		)
		expect(result.status).toBe('degraded')
		expect(result.statusCode).toBe(503)
		const ydbCheck = result.checks.find((c) => c.name === 'ydb')
		// Public shape: ONLY name + ok. NO error string. NO stack trace.
		expect(ydbCheck).toEqual({ name: 'ydb', ok: false })
		expect(Object.keys(ydbCheck ?? {})).toEqual(['name', 'ok'])
		// But operator detail MUST be in logger.error.
		expect(logger.calls).toHaveLength(1)
		expect((logger.calls[0]?.obj.err as Error).message).toMatch(/CVE-leak-vector/)
	})

	test('YDB returns false → 503 + structured log fired (no exception thrown)', async () => {
		const logger = makeLogger()
		const result = await evaluateReadiness(
			makeInput({
				probeYdb: async () => false,
				logger,
			}),
		)
		expect(result.statusCode).toBe(503)
		expect(result.checks.find((c) => c.name === 'ydb')?.ok).toBe(false)
		expect(logger.calls).toHaveLength(1)
		expect(logger.calls[0]?.obj.check).toBe('ydb')
	})

	test('non-live adapters в production → 503 + check shape NO offender names, NO error', async () => {
		const logger = makeLogger()
		const result = await evaluateReadiness(
			makeInput({
				appMode: 'production',
				adapters: [
					{ name: 'payment.stub', mode: 'mock' },
					{ name: 'vision.mock-ocr', mode: 'mock' },
					{ name: 'sms.demo-inbox', mode: 'mock' },
				],
				permittedMockAdapters: [],
				logger,
			}),
		)
		expect(result.status).toBe('degraded')
		expect(result.statusCode).toBe(503)
		const adaptersCheck = result.checks.find((c) => c.name === 'adapters')
		// Public shape pinned: name + ok ONLY.
		expect(adaptersCheck).toEqual({ name: 'adapters', ok: false })
		expect(Object.keys(adaptersCheck ?? {})).toEqual(['name', 'ok'])
		// Adapter inventory leaks к operator log, NOT response body.
		expect(logger.calls).toHaveLength(1)
		expect(logger.calls[0]?.obj.offenderCount).toBe(3)
		expect(logger.calls[0]?.obj.offenderNames).toEqual([
			'payment.stub',
			'vision.mock-ocr',
			'sms.demo-inbox',
		])
	})

	test('serialized public payload contains NO secret-leak strings (defensive sweep)', async () => {
		const result = await evaluateReadiness(
			makeInput({
				appMode: 'production',
				adapters: [{ name: 'payment.stub', mode: 'mock' }],
				probeYdb: async () => {
					throw new Error('Auth failed: token=eyJhbGciOi... shopId=test_secret_leak')
				},
				logger: { error: () => undefined },
			}),
		)
		const serialized = JSON.stringify(result)
		// Adversarial sweep: NONE of these strings may appear в public payload.
		expect(serialized).not.toContain('token=')
		expect(serialized).not.toContain('eyJhbGci')
		expect(serialized).not.toContain('test_secret_leak')
		expect(serialized).not.toContain('Auth failed')
		expect(serialized).not.toContain('payment.stub')
		expect(serialized).not.toContain('offenderNames')
		expect(serialized).not.toContain('offenderCount')
		expect(serialized).not.toContain('error')
	})
})

describe('evaluateReadiness — composite logic', () => {
	test('any single check failure → status degraded + statusCode 503', async () => {
		const result = await evaluateReadiness(
			makeInput({
				appMode: 'production',
				adapters: [{ name: 'payment.stub', mode: 'mock' }],
				probeYdb: async () => true,
			}),
		)
		expect(result.status).toBe('degraded')
		expect(result.statusCode).toBe(503)
		expect(result.checks.find((c) => c.name === 'ydb')?.ok).toBe(true)
		expect(result.checks.find((c) => c.name === 'adapters')?.ok).toBe(false)
	})

	test('sandbox mode tolerates non-live adapters; only YDB fail trips probe', async () => {
		const result = await evaluateReadiness(
			makeInput({
				appMode: 'sandbox',
				adapters: [{ name: 'payment.stub', mode: 'mock' }],
				probeYdb: async () => false,
			}),
		)
		expect(result.status).toBe('degraded')
		expect(result.checks.find((c) => c.name === 'adapters')?.ok).toBe(true)
		expect(result.checks.find((c) => c.name === 'ydb')?.ok).toBe(false)
	})

	test('live-mode adapters never offenders even в production', async () => {
		const result = await evaluateReadiness(
			makeInput({
				appMode: 'production',
				adapters: [
					{ name: 'payment.yookassa', mode: 'live' },
					{ name: 'vision.yandex', mode: 'live' },
				],
			}),
		)
		expect(result.statusCode).toBe(200)
	})
})
