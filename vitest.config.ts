import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		passWithNoTests: true,
		projects: ['apps/*', 'packages/*'],
		tags: [
			{
				name: 'db',
				description: 'YDB integration tests requiring Docker',
				timeout: 60_000,
			},
		],
		coverage: {
			provider: 'v8',
			include: ['apps/*/src/**', 'packages/*/src/**'],
			exclude: ['**/*.test.ts', '**/*.test-d.ts', '**/fixtures.*', '**/*.gen.ts'],
			// Thresholds = NO-REGRESSION floor (measured 2026-04-24, gate
			// surfaced via `pnpm coverage` + pre-push). NOT a quality target
			// — 75/65/70/75 is the M5f stretch goal when vitest-browser-mode
			// + component tests land and cover route files (currently 0%
			// because they're React components without isolated tests).
			// Raise this table each time a phase adds coverage.
			thresholds: {
				lines: 39,
				branches: 47,
				functions: 31,
				statements: 39,
			},
		},
	},
})
