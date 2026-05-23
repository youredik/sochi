import { describe, expect, test } from 'bun:test'
import { generateUuid } from './uuid-fallback.ts'

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('generateUuid', () => {
	test('returns valid UUID v4 format', () => {
		const uuid = generateUuid()
		expect(uuid).toMatch(UUID_V4_REGEX)
	})

	test('generates distinct UUIDs across calls', () => {
		const a = generateUuid()
		const b = generateUuid()
		expect(a).not.toBe(b)
	})

	test('fallback path triggered when crypto.randomUUID absent', () => {
		const originalRandomUUID = crypto.randomUUID
		// biome-ignore lint/suspicious/noExplicitAny: ad-hoc nullify для тест fallback path
		;(crypto as any).randomUUID = undefined
		try {
			const uuid = generateUuid()
			expect(uuid).toMatch(UUID_V4_REGEX)
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restore native impl
			;(crypto as any).randomUUID = originalRandomUUID
		}
	})
})
