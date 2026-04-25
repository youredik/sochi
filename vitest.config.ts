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
			// Thresholds = NO-REGRESSION floor. Raise each time a phase adds
			// coverage. Bumped 2026-04-25 после M6.7 + M6.8:
			//   M5e.3.5    — 39/47/31/39 (initial floor)
			//   M6.7+M6.8  — 47/53/36/47 (measured 48.99/54.55/37.19/48.48)
			// Stretch goal остаётся 75/65/70/75 — достижимо когда component
			// tests покроют sheet/route files (vitest-browser-mode когда GA).
			thresholds: {
				lines: 47,
				branches: 53,
				functions: 36,
				statements: 47,
			},
		},
	},
})
