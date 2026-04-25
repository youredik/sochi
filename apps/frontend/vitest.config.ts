import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	resolve: {
		alias: {
			// Mirror apps/frontend/vite.config.ts — shadcn components import `@/lib/utils`.
			// Vitest doesn't pick up vite.config alias automatically when running standalone.
			'@': path.resolve(__dirname, './src'),
		},
	},
	test: {
		name: 'frontend',
		globals: false,
		passWithNoTests: true,
		// `happy-dom` for React component tests (M6.7+). Lighter than jsdom;
		// faster cold start; sufficient for our use cases (no `Range` quirks
		// observed). Browser-mode (Playwright provider) deferred to M5f
		// stretch goal per `project_m5_tech_decisions.md` — happy-dom is
		// the pragmatic 2026 stop-gap for shadcn / Radix / TanStack components.
		environment: 'happy-dom',
		include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
		exclude: ['src/**/*.e2e.test.ts'],
	},
})
