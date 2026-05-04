/**
 * Default vitest config — build artifact tests in node pool.
 *
 * Component / W-tests live in `vitest.browser.config.ts` and run only via
 * `pnpm --filter @horeca/widget-embed test:browser`, NOT via root `pnpm test`.
 * This split keeps the root `test:serial` (which discovers via
 * `projects: ['apps/*', 'packages/*']`) from trying to load Browser Mode
 * imports inside a forks pool.
 *
 * Per `plans/m9_widget_6_canonical.md` §D14 — Vitest 4 Browser Mode +
 * `@vitest/browser-playwright` is GA stable since 2025-10-22.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	test: {
		name: 'widget-embed',
		environment: 'node',
		include: ['src/build.test.ts', 'src/**/*.unit.test.ts'],
		exclude: ['src/**/*.browser.test.ts'],
		hookTimeout: 90_000,
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
})
