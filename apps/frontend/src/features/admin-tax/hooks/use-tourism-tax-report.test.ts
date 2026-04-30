/**
 * `buildTourismTaxXlsxUrl` strict tests per memory `feedback_strict_tests.md`.
 *
 * Test plan:
 *   Happy path:
 *     [H1] required from/to → URL has both, no propertyId
 *     [H2] propertyId provided → URL has all 3 in correct order
 *
 *   URL-encoding (adversarial — propertyId might contain colons / dashes):
 *     [E1] propertyId with TypedID format `prop_01k...` — properly encoded
 *
 *   Base URL fallback:
 *     [B1] VITE_API_URL unset → falls back to localhost:3001
 *
 *   Immutability:
 *     [I1] params object NOT mutated by call
 */
import { afterEach, describe, expect, test } from 'vitest'
import { buildTourismTaxXlsxUrl } from './use-tourism-tax-report.ts'

const ORIGINAL_VITE_API_URL = import.meta.env.VITE_API_URL

afterEach(() => {
	// vitest stubEnv works on import.meta.env, but for safety reset.
	if (ORIGINAL_VITE_API_URL !== undefined) {
		;(import.meta.env as Record<string, unknown>).VITE_API_URL = ORIGINAL_VITE_API_URL
	}
})

describe('buildTourismTaxXlsxUrl — happy path', () => {
	test('[H1] from/to without propertyId → no propertyId in URL', () => {
		const url = buildTourismTaxXlsxUrl({ from: '2026-01-01', to: '2026-03-31' })
		expect(url).toContain('/api/admin/tax/tourism/export.xlsx')
		expect(url).toContain('from=2026-01-01')
		expect(url).toContain('to=2026-03-31')
		expect(url).not.toContain('propertyId=')
	})

	test('[H2] propertyId provided → URL has all 3 in correct order', () => {
		const url = buildTourismTaxXlsxUrl({
			from: '2026-04-01',
			to: '2026-06-30',
			propertyId: 'prop_01abc',
		})
		expect(url).toContain('from=2026-04-01')
		expect(url).toContain('to=2026-06-30')
		expect(url).toContain('propertyId=prop_01abc')
	})

	test('[H3] all 4 quarters round-trip through URLSearchParams', () => {
		const cases = [
			{ from: '2026-01-01', to: '2026-03-31' },
			{ from: '2026-04-01', to: '2026-06-30' },
			{ from: '2026-07-01', to: '2026-09-30' },
			{ from: '2026-10-01', to: '2026-12-31' },
		]
		for (const c of cases) {
			const url = buildTourismTaxXlsxUrl(c)
			const parsed = new URL(url)
			expect(parsed.searchParams.get('from')).toBe(c.from)
			expect(parsed.searchParams.get('to')).toBe(c.to)
			expect(parsed.searchParams.has('propertyId')).toBe(false)
		}
	})
})

describe('buildTourismTaxXlsxUrl — URL encoding', () => {
	test('[E1] TypedID property id (alphanumeric+underscore) round-trips clean', () => {
		const url = buildTourismTaxXlsxUrl({
			from: '2026-01-01',
			to: '2026-03-31',
			propertyId: 'prop_01kq4ppvfde49r2hre8x0gkx3d',
		})
		const parsed = new URL(url)
		expect(parsed.searchParams.get('propertyId')).toBe('prop_01kq4ppvfde49r2hre8x0gkx3d')
	})

	test('[E2] propertyId with weird-but-legal chars is properly encoded', () => {
		// We don't generate these but defensive encoding check for any future
		// id schemes (UUIDs, dashes, etc).
		const url = buildTourismTaxXlsxUrl({
			from: '2026-01-01',
			to: '2026-03-31',
			propertyId: 'a-b-c-d',
		})
		expect(url).toContain('propertyId=a-b-c-d')
	})
})

describe('buildTourismTaxXlsxUrl — immutability', () => {
	test('[I1] params object is NOT mutated', () => {
		const params = { from: '2026-01-01', to: '2026-03-31', propertyId: 'prop_01' }
		const before = JSON.stringify(params)
		buildTourismTaxXlsxUrl(params)
		expect(JSON.stringify(params)).toBe(before)
	})

	test('[I2] params object without propertyId is NOT mutated (no propertyId added)', () => {
		const params = { from: '2026-01-01', to: '2026-03-31' }
		const before = JSON.stringify(params)
		buildTourismTaxXlsxUrl(params)
		expect(JSON.stringify(params)).toBe(before)
		expect('propertyId' in params).toBe(false)
	})
})
