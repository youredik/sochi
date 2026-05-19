/**
 * Unit tests for migrate.ts canon Q2 2026 hardening (2026-05-19).
 *
 * Covers two exported seams:
 *   - applyServerlessCompat: pure string-rewrite, must downgrade ANY PT>24H
 *     к PT24H so YC Serverless Tier A (hours≤24, storage=0) accepts CHANGEFEED.
 *   - executeWithSchemeRetry: mock-driven test of stankoff-canon retry loop
 *     (linear 30+15s×n, 8 retries, substring match only retries rate-limit).
 *
 * Pure unit tests — NO YDB driver needed. Mock sql tag returns Promise.
 */
import { describe, expect, test } from 'bun:test'
import {
	applyServerlessCompat,
	executeWithSchemeRetry,
	flattenIssueMessages,
	isIdempotentError,
} from './migrate.ts'

/**
 * Build realistic YDBError-shaped object. Real @ydbjs/error emits:
 *   { message: 'SCHEME_ERROR, Issues: ERROR(<code>): <category>',
 *     code: <numeric>,
 *     issues: [ { message: '<category>', issueCode, severity, issues: [
 *       { message: 'At function: KiAlterTable!', severity, issues: [
 *         { message: '<actionable phrase>', severity } ] } ] } ] }
 * The actionable phrase ALWAYS lives 2-3 levels deep — top-level `.message`
 * is the SchemeShard generic category, never the actionable text.
 */
function makeYdbError(topCategory: string, nestedPhrase: string, code = 400070): Error {
	const err = new Error(
		`${topCategory}, Issues: ERROR(1030): ${topCategory.split('_')[0]} annotation`,
	)
	;(err as Error & { code?: number; issues?: unknown[] }).code = code
	;(err as Error & { code?: number; issues?: unknown[] }).issues = [
		{
			message: 'Execution',
			issueCode: 1060,
			severity: 1,
			issues: [
				{
					message: 'At function: KiAlterTable!',
					severity: 1,
					issues: [{ message: nestedPhrase, severity: 1 }],
				},
			],
		},
	]
	return err
}

describe('flattenIssueMessages — recursive YDBError walker', () => {
	test('plain Error: returns .message', () => {
		expect(flattenIssueMessages(new Error('boom'))).toBe('boom')
	})

	test('null / undefined / non-object: empty or string-cast', () => {
		expect(flattenIssueMessages(null)).toBe('')
		expect(flattenIssueMessages(undefined)).toBe('')
		expect(flattenIssueMessages(42)).toBe('42')
		expect(flattenIssueMessages('raw string')).toBe('raw string')
	})

	test('YDBError 3-level nested: concatenates all messages', () => {
		const err = makeYdbError('SCHEME_ERROR', 'Column "x" already exists')
		const flat = flattenIssueMessages(err)
		expect(flat).toContain('SCHEME_ERROR')
		expect(flat).toContain('Execution')
		expect(flat).toContain('At function: KiAlterTable!')
		expect(flat).toContain('Column "x" already exists')
	})

	test('separator | between levels', () => {
		const err = makeYdbError('SCHEME_ERROR', 'already exists')
		expect(flattenIssueMessages(err).split(' | ').length).toBeGreaterThanOrEqual(3)
	})

	test('issues array nested in array: recurses through', () => {
		const err = {
			message: 'top',
			issues: [{ message: 'mid', issues: [{ message: 'bottom' }] }],
		}
		expect(flattenIssueMessages(err)).toBe('top | mid | bottom')
	})

	test('empty issues array: just top message', () => {
		const err = { message: 'top', issues: [] }
		expect(flattenIssueMessages(err)).toBe('top')
	})

	test('object without message field still walks issues', () => {
		const err = { issues: [{ message: 'deep' }] }
		expect(flattenIssueMessages(err)).toBe('deep')
	})
})

describe('isIdempotentError — stankoff partial-apply tolerance (realistic YDBError shape)', () => {
	test('Column already exists (nested 3-level YDBError) → idempotent', () => {
		// EMPIRICAL shape from prod log 2026-05-19 17:44:09: top-level .message
		// is "SCHEME_ERROR, Issues: ERROR(1030): Type annotation" — phrase is
		// deep в issues[].issues[].issues[].message. Top-level match would miss.
		const err = makeYdbError(
			'SCHEME_ERROR',
			'AlterTable : .../organizationProfile Column: "ksrRegistryId" already exists',
		)
		expect(isIdempotentError(err)).toBe(true)
	})

	test('Path already exists (CREATE TABLE replay, nested) → idempotent', () => {
		const err = makeYdbError('SCHEME_ERROR', 'Path already exists: /folio')
		expect(isIdempotentError(err)).toBe(true)
	})

	test('Duplicate consumer name (ALTER TOPIC ADD CONSUMER replay, nested) → idempotent', () => {
		const err = makeYdbError('SCHEME_ERROR', 'Duplicate consumer name: activity_writer')
		expect(isIdempotentError(err)).toBe(true)
	})

	test('plain Error с phrase в top .message (test-only shape) → also idempotent', () => {
		// Defensive: even unrealistic shape should still match.
		expect(isIdempotentError(new Error('AlterTable: Column "x" already exists'))).toBe(true)
	})

	test('SCHEME_ERROR Type annotation БЕЗ idempotent phrase nested → NOT idempotent', () => {
		const err = makeYdbError('SCHEME_ERROR', 'Cannot find table because it does not exist')
		expect(isIdempotentError(err)).toBe(false)
	})

	test('rate-limit error (nested) → NOT idempotent (retryable != idempotent)', () => {
		const err = makeYdbError(
			'GENERIC_ERROR',
			'Request exceeded a limit on the number of schema operations, try again later.',
		)
		expect(isIdempotentError(err)).toBe(false)
	})

	test("non-Error throw → not idempotent (safety: don't silently swallow weird values)", () => {
		expect(isIdempotentError({ weird: true })).toBe(false)
		expect(isIdempotentError(null)).toBe(false)
		expect(isIdempotentError(undefined)).toBe(false)
		expect(isIdempotentError('plain string with already exists in it')).toBe(true) // string cast — substring matches
	})
})

describe('applyServerlessCompat — Tier A retention downgrade', () => {
	test('PT72H → PT24H (the canon trigger)', () => {
		const input = 'RETENTION_PERIOD = Interval("PT72H")'
		expect(applyServerlessCompat(input)).toBe('RETENTION_PERIOD = Interval("PT24H")')
	})

	test('PT24H stays unchanged (already Tier A)', () => {
		const input = 'RETENTION_PERIOD = Interval("PT24H")'
		expect(applyServerlessCompat(input)).toBe(input)
	})

	test('PT12H stays unchanged (below cap)', () => {
		const input = 'RETENTION_PERIOD = Interval("PT12H")'
		expect(applyServerlessCompat(input)).toBe(input)
	})

	test('PT25H downgrades (just over cap)', () => {
		expect(applyServerlessCompat('Interval("PT25H")')).toBe('Interval("PT24H")')
	})

	test('PT168H downgrades (Tier B value rejected on Serverless)', () => {
		expect(applyServerlessCompat('Interval("PT168H")')).toBe('Interval("PT24H")')
	})

	test('multiple intervals in one statement — all downgraded independently', () => {
		const input =
			'WITH (RETENTION_PERIOD = Interval("PT72H"), OTHER = Interval("PT48H"), KEEP = Interval("PT6H"))'
		const expected =
			'WITH (RETENTION_PERIOD = Interval("PT24H"), OTHER = Interval("PT24H"), KEEP = Interval("PT6H"))'
		expect(applyServerlessCompat(input)).toBe(expected)
	})

	test('whitespace tolerance: Interval(  "PT72H"  )', () => {
		expect(applyServerlessCompat('Interval(  "PT72H"  )')).toBe('Interval("PT24H")')
	})

	test('non-Interval text untouched', () => {
		const input = 'CREATE TABLE booking (col Utf8 NOT NULL)'
		expect(applyServerlessCompat(input)).toBe(input)
	})

	test('TTL clauses also downgraded (canon: ANY PT>24H)', () => {
		// TTL on tables uses different units (P730D days), but if someone writes
		// hours, we still downgrade. P730D is unaffected (regex requires PT…H).
		expect(applyServerlessCompat('WITH (TTL = Interval("P730D") ON createdAt)')).toBe(
			'WITH (TTL = Interval("P730D") ON createdAt)',
		)
		expect(applyServerlessCompat('TTL = Interval("PT100H")')).toBe('TTL = Interval("PT24H")')
	})

	test('PT0H — unusual but valid Tier A, untouched', () => {
		expect(applyServerlessCompat('Interval("PT0H")')).toBe('Interval("PT0H")')
	})
})

describe('executeWithSchemeRetry — stankoff canon rate-limit handling', () => {
	const RATE_LIMIT_MSG =
		'Request exceeded a limit on the number of schema operations, try again later.'

	type MockCall = { stmt: string }
	function makeMockSql(responses: Array<Error | 'ok'>) {
		const calls: MockCall[] = []
		let i = 0
		const unsafe = (s: string) => ({ __unsafe: s })
		const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
			// Reconstruct the executed text (best-effort) for trace.
			calls.push({ stmt: strings.raw.join('') })
			const r = responses[i++]
			if (!r) throw new Error('mock: out of responses')
			if (r === 'ok') return Promise.resolve()
			return Promise.reject(r)
		}
		// QueryClient's `sql` is a tagged template with `.unsafe()` member.
		// We mimic minimal shape needed by executeWithSchemeRetry.
		;(tag as { unsafe?: typeof unsafe }).unsafe = unsafe
		return { sql: tag as unknown as Parameters<typeof executeWithSchemeRetry>[0], calls }
	}

	test('happy path: first attempt succeeds, zero retries', async () => {
		const { sql, calls } = makeMockSql(['ok'])
		const logs: string[] = []
		await executeWithSchemeRetry(
			sql,
			'CREATE TABLE x (a Utf8, PRIMARY KEY (a))',
			(m) => logs.push(m),
			'0001.sql',
			1,
		)
		expect(calls.length).toBe(1)
		// No retry log because attempt=0 succeeded.
		expect(logs.find((l) => l.includes('schema-rate-limit hit'))).toBeUndefined()
		expect(logs.find((l) => l.includes('succeeded after'))).toBeUndefined()
	})

	test('non-retryable error (e.g. SCHEME_ERROR) throws immediately, no retry', async () => {
		const schemeError = new Error('SCHEME_ERROR, Issues: ERROR(1030): Type annotation')
		const { sql, calls } = makeMockSql([schemeError])
		const logs: string[] = []
		await expect(
			executeWithSchemeRetry(sql, 'BAD DDL', (m) => logs.push(m), '0004.sql', 2),
		).rejects.toThrow('SCHEME_ERROR')
		expect(calls.length).toBe(1) // No retry — just one attempt
	})

	test('rate-limit error retries via stankoff backoff schedule', async () => {
		// Need to inject fake timer that resolves setTimeout immediately so
		// test doesn't actually wait 30+45+60 = 135s.
		const originalSetTimeout = globalThis.setTimeout
		globalThis.setTimeout = ((fn: () => void) => {
			fn()
			return 0 as unknown as ReturnType<typeof setTimeout>
		}) as typeof setTimeout
		try {
			// REALISTIC nested YDBError — phrase deep in issues, not top message.
			const rateLimit = makeYdbError('GENERIC_ERROR', RATE_LIMIT_MSG)
			const { sql, calls } = makeMockSql([rateLimit, rateLimit, rateLimit, 'ok'])
			const logs: string[] = []
			await executeWithSchemeRetry(
				sql,
				'CREATE TABLE y (a Utf8, PRIMARY KEY (a))',
				(m) => logs.push(m),
				'0015.sql',
				5,
			)
			expect(calls.length).toBe(4) // initial + 3 retries
			// Should have 3 «schema-rate-limit hit» logs (one per retry kick-off).
			const retryLogs = logs.filter((l) => l.includes('schema-rate-limit hit'))
			expect(retryLogs.length).toBe(3)
			// Final success log.
			expect(logs.some((l) => l.includes('succeeded after 3 retry(ies)'))).toBe(true)
			// Stankoff exact delays: 30s, 45s, 60s for first 3 retries.
			expect(retryLogs[0]).toContain('в 30s')
			expect(retryLogs[1]).toContain('в 45s')
			expect(retryLogs[2]).toContain('в 60s')
		} finally {
			globalThis.setTimeout = originalSetTimeout
		}
	})

	test('rate-limit exhausts MAX_RETRIES (8) — throws final error', async () => {
		const originalSetTimeout = globalThis.setTimeout
		globalThis.setTimeout = ((fn: () => void) => {
			fn()
			return 0 as unknown as ReturnType<typeof setTimeout>
		}) as typeof setTimeout
		try {
			const rateLimit = makeYdbError('GENERIC_ERROR', RATE_LIMIT_MSG)
			// 9 attempts (initial + 8 retries) all fail.
			const responses = Array.from({ length: 9 }, () => rateLimit)
			const { sql, calls } = makeMockSql(responses)
			const logs: string[] = []
			// Realistic YDBError top .message is "GENERIC_ERROR, ..." — phrase is
			// nested. Assert on top-level message (что .rejects.toThrow видит).
			await expect(
				executeWithSchemeRetry(
					sql,
					'CREATE TABLE z (a Utf8, PRIMARY KEY (a))',
					(m) => logs.push(m),
					'0026.sql',
					1,
				),
			).rejects.toThrow('GENERIC_ERROR')
			expect(calls.length).toBe(9) // 1 initial + 8 retries
			expect(logs.filter((l) => l.includes('schema-rate-limit hit')).length).toBe(8)
		} finally {
			globalThis.setTimeout = originalSetTimeout
		}
	})

	test('rate-limit followed by SCHEME_ERROR — bails on second error без exhausting retries', async () => {
		const originalSetTimeout = globalThis.setTimeout
		globalThis.setTimeout = ((fn: () => void) => {
			fn()
			return 0 as unknown as ReturnType<typeof setTimeout>
		}) as typeof setTimeout
		try {
			const rateLimit = makeYdbError('GENERIC_ERROR', RATE_LIMIT_MSG)
			const schemeError = makeYdbError('SCHEME_ERROR', 'malformed DDL keyword expected')
			const { sql, calls } = makeMockSql([rateLimit, schemeError])
			const logs: string[] = []
			await expect(
				executeWithSchemeRetry(sql, 'CREATE TABLE bad (...)', (m) => logs.push(m), '0099.sql', 1),
			).rejects.toThrow('SCHEME_ERROR')
			expect(calls.length).toBe(2) // initial rate-limit + one retry that hit SCHEME_ERROR
		} finally {
			globalThis.setTimeout = originalSetTimeout
		}
	})

	test('non-Error throws are handled without crashing message extraction', async () => {
		const { sql, calls } = makeMockSql([{ weird: 'not-an-error' } as unknown as Error])
		const logs: string[] = []
		await expect(
			executeWithSchemeRetry(
				sql,
				'CREATE TABLE w (a Utf8, PRIMARY KEY (a))',
				(m) => logs.push(m),
				'0100.sql',
				1,
			),
		).rejects.toEqual({ weird: 'not-an-error' })
		expect(calls.length).toBe(1) // not retried because non-Error has no .message
	})

	test('idempotent error «Column already exists» (REALISTIC nested YDBError) logs skip и returns без throw', async () => {
		// Realistic YDBError: top .message = 'SCHEME_ERROR...' (NOT 'already exists').
		// flattenIssueMessages must walk issues to find the phrase.
		const colExists = makeYdbError(
			'SCHEME_ERROR',
			'AlterTable : .../organizationProfile Column: "ksrRegistryId" already exists',
		)
		const { sql, calls } = makeMockSql([colExists])
		const logs: string[] = []
		// Should NOT throw — stankoff canon partial-apply tolerance.
		await executeWithSchemeRetry(
			sql,
			'ALTER TABLE organizationProfile ADD COLUMN ksrRegistryId Utf8',
			(m) => logs.push(m),
			'0027.sql',
			1,
		)
		expect(calls.length).toBe(1) // no retry — idempotent skip is final
		expect(logs.some((l) => l.includes('idempotent skip'))).toBe(true)
	})

	test('idempotent «Path already exists» (CREATE TABLE replay) skipped', async () => {
		const pathExists = new Error('Path already exists: /folio')
		const { sql, calls } = makeMockSql([pathExists])
		await executeWithSchemeRetry(sql, 'CREATE TABLE folio (...)', () => {}, '0007.sql', 1)
		expect(calls.length).toBe(1)
	})

	test('idempotent «Duplicate consumer name» (ALTER TOPIC ADD CONSUMER replay) skipped', async () => {
		const dup = new Error('Duplicate consumer name: activity_writer')
		const { sql, calls } = makeMockSql([dup])
		await executeWithSchemeRetry(
			sql,
			'ALTER TOPIC `booking/booking_events` ADD CONSUMER activity_writer',
			() => {},
			'0005.sql',
			1,
		)
		expect(calls.length).toBe(1)
	})

	test('rate-limit linear delays match stankoff seed.ts:74-104 exactly', async () => {
		// Spy on setTimeout to capture delay values.
		const originalSetTimeout = globalThis.setTimeout
		const captured: number[] = []
		globalThis.setTimeout = ((fn: () => void, ms: number) => {
			captured.push(ms)
			fn()
			return 0 as unknown as ReturnType<typeof setTimeout>
		}) as typeof setTimeout
		try {
			const rateLimit = makeYdbError('GENERIC_ERROR', RATE_LIMIT_MSG)
			const { sql } = makeMockSql([
				rateLimit,
				rateLimit,
				rateLimit,
				rateLimit,
				rateLimit,
				rateLimit,
				rateLimit,
				rateLimit,
				'ok',
			])
			await executeWithSchemeRetry(sql, 'noop', () => {}, 'test.sql', 1)
			// Stankoff exact: 30, 45, 60, 75, 90, 105, 120, 135 seconds.
			expect(captured).toEqual([30_000, 45_000, 60_000, 75_000, 90_000, 105_000, 120_000, 135_000])
		} finally {
			globalThis.setTimeout = originalSetTimeout
		}
	})
})
