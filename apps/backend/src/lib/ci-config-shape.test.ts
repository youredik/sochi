/**
 * Lighthouse CI config + size-limit + budgets shape verification — A5.1 strict tests.
 *
 * Per `plans/m9_widget_7_canonical.md` D1-D5 + D10:
 *   - Verify lighthouserc.cjs has REQUIRED assertions at correct severity
 *   - Verify numberOfRuns=5 (D5 LHCI canon median-of-5)
 *   - Verify TBT aggregationMethod='pessimistic' (D4)
 *   - Verify lcp-lazy-loaded asserted at error (D3 gaming defense)
 *   - Verify size-limit budgets cover SPA index + widget chunks
 *   - Verify budgets.json shape valid (paths + timings + resourceSizes)
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// apps/backend/src/lib → repo root (4 levels up).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

interface LhciAssertionMap {
	readonly [key: string]: string | [string, Record<string, unknown>]
}

interface LhciConfig {
	readonly ci: {
		readonly collect: { numberOfRuns: number; url: string[]; settings: Record<string, unknown> }
		readonly assert: { assertions: LhciAssertionMap; budgetsFile: string }
		readonly upload: { target: string }
	}
}

async function loadLhci(): Promise<LhciConfig> {
	const cfg = (await import(path.join(REPO_ROOT, 'lighthouserc.cjs'))) as { default: LhciConfig }
	return cfg.default
}

describe('Lighthouse CI config (lighthouserc.cjs)', () => {
	it('[LHC1] numberOfRuns=5 (D5 LHCI canon median-of-5)', async () => {
		const cfg = await loadLhci()
		expect(cfg.ci.collect.numberOfRuns).toBe(5)
	})

	it('[LHC2] urls cover both SPA widget + iframe HTML wrapper surfaces', async () => {
		const cfg = await loadLhci()
		const urls = cfg.ci.collect.url.join('|')
		expect(urls).toContain('/widget/demo-sirius')
		expect(urls).toContain('/api/embed/v1/iframe/demo-sirius')
	})

	it('[LHC3] LCP gaming defense — lcp-lazy-loaded at error level (D3, R2 §1)', async () => {
		const cfg = await loadLhci()
		expect(cfg.ci.assert.assertions['lcp-lazy-loaded']).toBe('error')
		expect(cfg.ci.assert.assertions['prioritize-lcp-image']).toBe('error')
		expect(cfg.ci.assert.assertions['uses-responsive-images']).toBe('error')
	})

	it('[LHC4] TBT aggregationMethod=pessimistic (D4 worst-run)', async () => {
		const cfg = await loadLhci()
		const tbt = cfg.ci.assert.assertions['total-blocking-time']
		expect(Array.isArray(tbt)).toBe(true)
		const tbtTuple = tbt as [string, Record<string, unknown>]
		expect(tbtTuple[0]).toBe('error')
		expect(tbtTuple[1].aggregationMethod).toBe('pessimistic')
		expect(tbtTuple[1].maxNumericValue).toBe(200)
	})

	it('[LHC5] LCP threshold 2500ms median-run', async () => {
		const cfg = await loadLhci()
		const lcp = cfg.ci.assert.assertions['largest-contentful-paint']
		expect(Array.isArray(lcp)).toBe(true)
		const lcpTuple = lcp as [string, Record<string, unknown>]
		expect(lcpTuple[0]).toBe('error')
		expect(lcpTuple[1].maxNumericValue).toBe(2500)
		expect(lcpTuple[1].aggregationMethod).toBe('median-run')
	})

	it('[LHC6] budgetsFile points to budgets.json', async () => {
		const cfg = await loadLhci()
		expect(cfg.ci.assert.budgetsFile).toBe('budgets.json')
	})
})

interface BudgetEntry {
	readonly path: string
	readonly resourceSizes: ReadonlyArray<{ resourceType: string; budget: number }>
	readonly resourceCounts: ReadonlyArray<{ resourceType: string; budget: number }>
	readonly timings: ReadonlyArray<{ metric: string; budget: number }>
}

describe('budgets.json (D2 separate budgets canon)', () => {
	const raw = readFileSync(path.join(REPO_ROOT, 'budgets.json'), 'utf-8')
	const budgets = JSON.parse(raw) as ReadonlyArray<BudgetEntry>

	it('[BG1] entries cover /widget/* + /api/embed/v1/iframe/*', () => {
		const paths = budgets.map((b) => b.path)
		expect(paths).toContain('/widget/*')
		expect(paths).toContain('/api/embed/v1/iframe/*')
	})

	it('[BG2] iframe budget tighter than SPA widget (smaller surface)', () => {
		const iframe = budgets.find((b) => b.path === '/api/embed/v1/iframe/*')
		const widget = budgets.find((b) => b.path === '/widget/*')
		expect(iframe).toBeDefined()
		expect(widget).toBeDefined()
		const iframeTotal = iframe?.resourceSizes.find((r) => r.resourceType === 'total')?.budget ?? 0
		const widgetTotal = widget?.resourceSizes.find((r) => r.resourceType === 'total')?.budget ?? 0
		expect(iframeTotal).toBeLessThan(widgetTotal)
	})

	it('[BG3] both budgets ban third-party scripts (resourceCount 0)', () => {
		for (const b of budgets) {
			const tp = b.resourceCounts.find((r) => r.resourceType === 'third-party')
			expect(tp?.budget).toBe(0)
		}
	})

	it('[BG4] LCP budget ≤2500ms на каждом surface', () => {
		for (const b of budgets) {
			const lcp = b.timings.find((t) => t.metric === 'largest-contentful-paint')
			expect(lcp).toBeDefined()
			expect(lcp?.budget).toBeLessThanOrEqual(2500)
		}
	})
})

interface SizeLimitEntry {
	readonly name: string
	readonly path: string
	readonly limit: string
	readonly gzip: boolean
}

describe('.size-limit.json (D10 SPA + widget bundle budgets)', () => {
	const raw = readFileSync(path.join(REPO_ROOT, '.size-limit.json'), 'utf-8')
	const entries = JSON.parse(raw) as ReadonlyArray<SizeLimitEntry>

	it('[SZ1] covers SPA index + widget facade + lazy chunks', () => {
		const names = entries.map((e) => e.name)
		expect(names).toContain('SPA index (initial chunk)')
		expect(names).toContain('Widget facade (embed.js)')
		expect(names).toContain('Widget lazy chunk (booking-flow.js)')
	})

	it('[SZ2] widget facade pinned at 15 KB (existing canon preserved)', () => {
		const facade = entries.find((e) => e.name === 'Widget facade (embed.js)')
		expect(facade?.limit).toBe('15 KB')
		expect(facade?.gzip).toBe(true)
	})

	it('[SZ3] widget lazy chunk pinned at 80 KB (existing canon preserved)', () => {
		const lazy = entries.find((e) => e.name === 'Widget lazy chunk (booking-flow.js)')
		expect(lazy?.limit).toBe('80 KB')
		expect(lazy?.gzip).toBe(true)
	})

	it('[SZ4] all entries measure gzipped (NOT raw)', () => {
		for (const e of entries) {
			expect(e.gzip).toBe(true)
		}
	})
})
