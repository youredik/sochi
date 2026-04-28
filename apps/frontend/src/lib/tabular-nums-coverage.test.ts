/**
 * tabular-nums coverage — strict grep-test (M9.6 plan canon).
 *
 * Vite `import.meta.glob({ as: 'raw' })` reads source files at build-time
 * (no node:fs in SPA — biome `noRestrictedImports` enforced). Each entry =
 * raw text of a file matched by glob. We grep tabular-nums usage в financial
 * components against regression.
 *
 * Pre-done audit:
 *   [T1] Money component (visible span) uses tabular-nums
 *   [T2] MoneyInput display uses tabular-nums
 *   [T3] receivables-table uses tabular-nums (≥2 occurrences)
 *   [T4] receivables KPI cards use tabular-nums (≥3 occurrences)
 *   [T5] refund-sheet financial dl rows use tabular-nums (≥3 occurrences)
 *
 * **Note:** index.css `.tabular-nums` declaration verified implicitly via
 * any successful React render — если utility класс отсутствует в @layer,
 * Tailwind compilation fails OR computed style mismatches. Source-grep CSS
 * declaration redundant + Vite `?raw` doesn't load CSS plugin output.
 */
import { describe, expect, it } from 'vitest'

const FINANCIAL_FILES = import.meta.glob<string>(
	[
		'../components/money.tsx',
		'../features/receivables/components/receivables-table.tsx',
		'../features/receivables/components/kpi-cards.tsx',
		'../features/folios/components/refund-sheet.tsx',
	],
	{ query: '?raw', import: 'default', eager: true },
)

function getSrc(suffix: string): string {
	const entry = Object.entries(FINANCIAL_FILES).find(([k]) => k.endsWith(suffix))
	if (!entry) throw new Error(`Source not found: ${suffix}`)
	return entry[1]
}

describe('tabular-nums coverage — financial component regressions guard', () => {
	it('[T1] Money component (visible span) uses tabular-nums', () => {
		const src = getSrc('money.tsx')
		expect(src).toMatch(/className=\{cn\('tabular-nums/)
	})

	it('[T2] MoneyInput display uses tabular-nums', () => {
		const src = getSrc('money.tsx')
		expect(src).toMatch(/text-2xl tabular-nums/)
	})

	it('[T3] receivables-table money + days use tabular-nums (≥2)', () => {
		const src = getSrc('receivables-table.tsx')
		expect(src.match(/tabular-nums/g)?.length).toBeGreaterThanOrEqual(2)
	})

	it('[T4] receivables KPI cards use tabular-nums (≥3)', () => {
		const src = getSrc('kpi-cards.tsx')
		expect(src.match(/tabular-nums/g)?.length).toBeGreaterThanOrEqual(3)
	})

	it('[T5] refund-sheet financial dl rows use tabular-nums (≥3)', () => {
		const src = getSrc('refund-sheet.tsx')
		expect(src.match(/tabular-nums/g)?.length).toBeGreaterThanOrEqual(3)
	})
})
