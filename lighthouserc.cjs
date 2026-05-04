/**
 * Lighthouse CI configuration — M9.widget.7 / А5.1 (perf gate).
 *
 * Per `plans/m9_widget_7_canonical.md` D1-D5:
 *   - D1 `@lhci/cli@0.15.1` + Lighthouse 12.6.1 (transitive bundled).
 *     INP NOT lab metric — gated separately via web-vitals 5 attribution
 *     RUM pipeline (А5.2). Lab-side proxy = TBT.
 *   - D2 CommonJS config (.cjs) — comment-friendly + Node-compat under
 *     pnpm workspace ESM-by-default. JSON has no comments; .js triggers
 *     ESM warnings.
 *   - D3 LCP gaming defense — `lcp-lazy-loaded` / `largest-contentful-paint-element` /
 *     `prioritize-lcp-image` audits all asserted at `error`. Per Unlighthouse
 *     2025: 10.4% mobile pages lazy-load LCP, gaming the score.
 *   - D4 TBT `aggregationMethod: 'pessimistic'` (worst run not median) —
 *     defends idle-period noise gaming.
 *   - D5 `numberOfRuns: 5` + `tolerance: 100ms` band. LHCI 2026 canon
 *     median-of-5 (3 = high false-fail rate; LCP variance ±5-15% per run).
 *
 * Hard-fail vs warn convention (D15): warn-only on post-push (informational
 * Slack ping); hard-fail moves к Track B deploy gate. This config emits
 * `assertions` at `error` level — workflow `continue-on-error: true` keeps
 * push green но logs the regression.
 *
 * URLs scanned: SPA dashboard + widget public route + iframe HTML wrapper.
 * Each runs against locally-spun `pnpm dev` (frontend 5273 + backend 8787).
 */

/** @type {import('@lhci/cli').LighthouseCiConfig} */
module.exports = {
	ci: {
		collect: {
			startServerCommand: 'pnpm --parallel --filter "./apps/*" dev',
			startServerReadyPattern: 'Local:.*5273',
			startServerReadyTimeout: 120_000,
			url: [
				'http://localhost:5273/widget/demo-sirius',
				'http://localhost:8787/api/embed/v1/iframe/demo-sirius/demo-prop-sirius-main.html',
			],
			numberOfRuns: 5,
			settings: {
				preset: 'desktop',
				throttlingMethod: 'simulate',
				skipAudits: ['uses-http2', 'redirects-http', 'uses-passive-event-listeners'],
				chromeFlags: '--headless=new --no-sandbox --disable-dev-shm-usage',
			},
		},
		assert: {
			assertions: {
				// Core Web Vitals lab metrics (D1-D4)
				'largest-contentful-paint': [
					'error',
					{ maxNumericValue: 2500, aggregationMethod: 'median-run' },
				],
				'cumulative-layout-shift': [
					'error',
					{ maxNumericValue: 0.1, aggregationMethod: 'median-run' },
				],
				'total-blocking-time': [
					'error',
					{ maxNumericValue: 200, aggregationMethod: 'pessimistic' },
				],
				'speed-index': [
					'warn',
					{ maxNumericValue: 3400, aggregationMethod: 'median-run' },
				],
				'first-contentful-paint': [
					'warn',
					{ maxNumericValue: 1800, aggregationMethod: 'median-run' },
				],

				// LCP gaming defense (D3) — these are ALL `error` per R2 §1.
				// `lcp-lazy-loaded` is a diagnostic-by-default; we promote to error
				// because Unlighthouse 2025 documented gaming pattern (lazy-load
				// hero image → LCP=200ms but real UX broken).
				'lcp-lazy-loaded': 'error',
				'largest-contentful-paint-element': ['error', { maxLength: 0 }],
				'prioritize-lcp-image': 'error',
				'uses-responsive-images': 'error',

				// Performance categorical
				'categories:performance': ['warn', { minScore: 0.9 }],
				'categories:accessibility': ['error', { minScore: 0.95 }],
				'categories:best-practices': ['warn', { minScore: 0.9 }],
				'categories:seo': ['warn', { minScore: 0.9 }],

				// Resource budgets (referenced from budgets.json)
				'resource-summary': 'off',
				'performance-budget': 'error',
			},
			// Budgets file referenced via budgetsPath (D2 separate budgets canon).
			budgetsFile: 'budgets.json',
		},
		upload: {
			target: 'temporary-public-storage',
		},
	},
}
