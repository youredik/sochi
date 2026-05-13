/**
 * tabular-nums coverage — strict grep-test (M9.6 plan canon).
 *
 * Reads source files at test-time via Bun-native `Bun.file()` and greps
 * `tabular-nums` usage in financial components against regression.
 *
 * Phase 16 (2026-05-13): migrated from Vite's `import.meta.glob({ as: 'raw' })`
 * (build-time, Vite-only — Bun #6060 still open for implementation) to
 * `Bun.file(...).text()` + `import.meta.dir` (Bun-native). Universal under
 * bun:test, no `node:fs` (which biome forbids in SPA per architecture rule
 * `noRestrictedImports`).
 *
 * Pre-done audit:
 *   [T1] Money component (visible span) uses tabular-nums
 *   [T2] MoneyInput display uses tabular-nums
 *   [T3] receivables-table uses tabular-nums (≥2 occurrences)
 *   [T4] receivables KPI cards use tabular-nums (≥3 occurrences)
 *   [T5] refund-sheet financial dl rows use tabular-nums (≥3 occurrences)
 *
 * **Note:** index.css `.tabular-nums` declaration verified implicitly via
 * any successful React render — if the utility class is missing from
 * @layer, Tailwind compilation fails OR computed style mismatches.
 * Source-grep CSS declaration redundant.
 */
import { describe, expect, it } from 'bun:test'

const DIR = import.meta.dir

async function readSrc(rel: string): Promise<string> {
	return await Bun.file(`${DIR}/${rel}`).text()
}

describe('tabular-nums coverage — financial component regressions guard', () => {
	it('[T1] Money component (visible span) uses tabular-nums', async () => {
		const src = await readSrc('../components/money.tsx')
		expect(src).toMatch(/className=\{cn\('tabular-nums/)
	})

	it('[T2] MoneyInput display uses tabular-nums', async () => {
		const src = await readSrc('../components/money.tsx')
		expect(src).toMatch(/text-2xl tabular-nums/)
	})

	it('[T3] receivables-table money + days use tabular-nums (≥2)', async () => {
		const src = await readSrc('../features/receivables/components/receivables-table.tsx')
		expect(src.match(/tabular-nums/g)?.length).toBeGreaterThanOrEqual(2)
	})

	it('[T4] receivables KPI cards use tabular-nums (≥3)', async () => {
		const src = await readSrc('../features/receivables/components/kpi-cards.tsx')
		expect(src.match(/tabular-nums/g)?.length).toBeGreaterThanOrEqual(3)
	})

	it('[T5] refund-sheet financial dl rows use tabular-nums (≥3)', async () => {
		const src = await readSrc('../features/folios/components/refund-sheet.tsx')
		expect(src.match(/tabular-nums/g)?.length).toBeGreaterThanOrEqual(3)
	})
})
