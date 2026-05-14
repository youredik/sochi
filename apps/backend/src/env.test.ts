/**
 * Env-schema parsing tests — verifies non-trivial transforms.
 *
 * The schema is exported from `./env.ts`; the runtime `env` instance is parsed
 * once at module load against `process.env`. These tests exercise the parser
 * with synthetic inputs, NOT the runtime singleton.
 */
import { describe, expect, it } from 'bun:test'
import { booleanEnv, envSchema } from './env.ts'

const REQUIRED_FIELDS = {
	YDB_CONNECTION_STRING: 'grpc://localhost:2236/local',
	BETTER_AUTH_SECRET: 'a'.repeat(32),
	BETTER_AUTH_URL: 'http://localhost:8787',
	S3_ENDPOINT: 'http://localhost:9000',
	S3_ACCESS_KEY_ID: 'minio',
	S3_SECRET_ACCESS_KEY: 'minio123',
	S3_BUCKET: 'horeca',
	EMAIL_FROM_ADDRESS: 'noreply@example.local',
}

describe('envSchema', () => {
	describe('APP_MODE', () => {
		it('defaults to "sandbox" when unset', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS })
			expect(env.APP_MODE).toBe('sandbox')
		})

		it('accepts "sandbox"', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS, APP_MODE: 'sandbox' })
			expect(env.APP_MODE).toBe('sandbox')
		})

		it('accepts "production"', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS, APP_MODE: 'production' })
			expect(env.APP_MODE).toBe('production')
		})

		it('rejects "staging" (must be sandbox or production)', () => {
			expect(() => envSchema.parse({ ...REQUIRED_FIELDS, APP_MODE: 'staging' })).toThrowError(
				/APP_MODE/,
			)
		})

		it('rejects empty string', () => {
			expect(() => envSchema.parse({ ...REQUIRED_FIELDS, APP_MODE: '' })).toThrow()
		})
	})

	describe('APP_MODE_PERMITTED_MOCK_ADAPTERS', () => {
		it('defaults to empty array when unset', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS })
			expect(env.APP_MODE_PERMITTED_MOCK_ADAPTERS).toEqual([])
		})

		it('parses single name without commas', () => {
			const env = envSchema.parse({
				...REQUIRED_FIELDS,
				APP_MODE_PERMITTED_MOCK_ADAPTERS: 'epgu.stub',
			})
			expect(env.APP_MODE_PERMITTED_MOCK_ADAPTERS).toEqual(['epgu.stub'])
		})

		it('splits on commas', () => {
			const env = envSchema.parse({
				...REQUIRED_FIELDS,
				APP_MODE_PERMITTED_MOCK_ADAPTERS: 'epgu.stub,vision.stub',
			})
			expect(env.APP_MODE_PERMITTED_MOCK_ADAPTERS).toEqual(['epgu.stub', 'vision.stub'])
		})

		it('trims whitespace around each entry', () => {
			const env = envSchema.parse({
				...REQUIRED_FIELDS,
				APP_MODE_PERMITTED_MOCK_ADAPTERS: ' epgu.stub , vision.stub ',
			})
			expect(env.APP_MODE_PERMITTED_MOCK_ADAPTERS).toEqual(['epgu.stub', 'vision.stub'])
		})

		it('drops empty segments from extra commas', () => {
			const env = envSchema.parse({
				...REQUIRED_FIELDS,
				APP_MODE_PERMITTED_MOCK_ADAPTERS: 'a,,b,,,c,',
			})
			expect(env.APP_MODE_PERMITTED_MOCK_ADAPTERS).toEqual(['a', 'b', 'c'])
		})

		it('returns empty array for whitespace-only input', () => {
			const env = envSchema.parse({
				...REQUIRED_FIELDS,
				APP_MODE_PERMITTED_MOCK_ADAPTERS: '   ',
			})
			// "   " split on ',' = ["   "], trimmed = [""], filtered = []
			expect(env.APP_MODE_PERMITTED_MOCK_ADAPTERS).toEqual([])
		})

		it('returns frozen-shape array (Array, not string)', () => {
			const env = envSchema.parse({
				...REQUIRED_FIELDS,
				APP_MODE_PERMITTED_MOCK_ADAPTERS: 'a',
			})
			// type-check at runtime that transform happened
			expect(Array.isArray(env.APP_MODE_PERMITTED_MOCK_ADAPTERS)).toBe(true)
		})
	})

	describe('NODE_ENV', () => {
		it('defaults to "development"', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS })
			expect(env.NODE_ENV).toBe('development')
		})

		it('accepts "production" / "test"', () => {
			expect(envSchema.parse({ ...REQUIRED_FIELDS, NODE_ENV: 'production' }).NODE_ENV).toBe(
				'production',
			)
			expect(envSchema.parse({ ...REQUIRED_FIELDS, NODE_ENV: 'test' }).NODE_ENV).toBe('test')
		})
	})

	describe('POSTBOX_ENABLED — regression: "false" must parse to false (not true)', () => {
		// Root-cause of the silent magic-link drop on 2026-05-14: zod's
		// `z.coerce.boolean()` reads `"false"` as truthy (JS `Boolean("false")
		// === true`), the factory enters the Postbox branch, finds no
		// credentials, and falls back to `StubAdapter` — emails never reach
		// Mailpit. Guarded here so re-introducing `z.coerce.boolean()`
		// fails the suite.
		it('POSTBOX_ENABLED="false" → false', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS, POSTBOX_ENABLED: 'false' })
			expect(env.POSTBOX_ENABLED).toBe(false)
		})

		it('POSTBOX_ENABLED="0" → false', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS, POSTBOX_ENABLED: '0' })
			expect(env.POSTBOX_ENABLED).toBe(false)
		})

		it('POSTBOX_ENABLED="true" → true', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS, POSTBOX_ENABLED: 'true' })
			expect(env.POSTBOX_ENABLED).toBe(true)
		})

		it('POSTBOX_ENABLED unset → false (default)', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS })
			expect(env.POSTBOX_ENABLED).toBe(false)
		})
	})

	describe('DEMO_DEPLOYMENT — same coercion canon as POSTBOX_ENABLED', () => {
		it('DEMO_DEPLOYMENT="false" → false', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS, DEMO_DEPLOYMENT: 'false' })
			expect(env.DEMO_DEPLOYMENT).toBe(false)
		})

		it('DEMO_DEPLOYMENT="true" → true', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS, DEMO_DEPLOYMENT: 'true' })
			expect(env.DEMO_DEPLOYMENT).toBe(true)
		})

		it('DEMO_DEPLOYMENT unset → false', () => {
			const env = envSchema.parse({ ...REQUIRED_FIELDS })
			expect(env.DEMO_DEPLOYMENT).toBe(false)
		})
	})

	describe('booleanEnv helper — accepted spellings + rejection', () => {
		const schema = booleanEnv(false)

		it.each([
			['true', true],
			['TRUE', true],
			['True', true],
			['1', true],
			['yes', true],
			['YES', true],
			[true, true],
			['false', false],
			['FALSE', false],
			['0', false],
			['no', false],
			[false, false],
			['', false], // empty string falls back to default
			['  true  ', true], // surrounding whitespace tolerated
			['  false  ', false],
		])('input %p → %p', (input, expected) => {
			expect(schema.parse(input)).toBe(expected)
		})

		it('uses provided default when input is undefined', () => {
			expect(booleanEnv(false).parse(undefined)).toBe(false)
			expect(booleanEnv(true).parse(undefined)).toBe(true)
		})

		it('uses provided default when input is empty string', () => {
			expect(booleanEnv(true).parse('')).toBe(true)
		})

		it('rejects unrecognised string with clear error', () => {
			expect(() => schema.parse('maybe')).toThrowError(/Expected boolean env/)
			expect(() => schema.parse('tru')).toThrowError(/Expected boolean env/)
		})

		it('rejects non-string non-boolean values', () => {
			expect(() => schema.parse(123)).toThrow()
			expect(() => schema.parse({})).toThrow()
			expect(() => schema.parse([])).toThrow()
		})
	})

	describe('NODE_ENV vs APP_MODE — independence (M8.0 prep canon)', () => {
		it('NODE_ENV=production + APP_MODE=sandbox is a valid combination (staging build)', () => {
			const env = envSchema.parse({
				...REQUIRED_FIELDS,
				NODE_ENV: 'production',
				APP_MODE: 'sandbox',
			})
			expect(env.NODE_ENV).toBe('production')
			expect(env.APP_MODE).toBe('sandbox')
		})

		it('NODE_ENV=development + APP_MODE=production parses (caller asserts gate)', () => {
			// Schema accepts the combination; the production gate is enforced
			// at startup (`assertProductionReady()` in index.ts), not here.
			const env = envSchema.parse({
				...REQUIRED_FIELDS,
				NODE_ENV: 'development',
				APP_MODE: 'production',
			})
			expect(env.NODE_ENV).toBe('development')
			expect(env.APP_MODE).toBe('production')
		})
	})
})
