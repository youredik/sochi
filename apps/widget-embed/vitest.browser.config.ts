/**
 * Browser-mode vitest config — Vitest 4 Browser Mode + Playwright provider.
 *
 * Run via `pnpm --filter @horeca/widget-embed test:browser`. Discovers
 * `*.browser.test.ts` in `src/`. Real Chromium runs the test, so Shadow DOM
 * + lit-html templates + custom-element registration all execute in actual
 * browser context (not happy-dom).
 *
 * Per `plans/m9_widget_6_canonical.md` §D14 — `@vitest/browser-playwright`
 * is the canonical 2026 provider for component-level Lit tests. `vitest-browser-lit`
 * supplies the canonical `render(html\`<my-element>\`)` helper.
 *
 * NOT discovered by root `pnpm test:serial` (which iterates
 * `projects: ['apps/*', 'packages/*']` against the default config above)
 * because that runs in a forks pool and Browser Mode imports would crash.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	test: {
		name: 'widget-embed:browser',
		include: ['src/**/*.browser.test.ts'],
		browser: {
			enabled: true,
			headless: true,
			provider: playwright(),
			instances: [{ browser: 'chromium' }],
		},
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
})
