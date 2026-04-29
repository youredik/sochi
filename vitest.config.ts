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
			// coverage. History:
			//   M5e.3.5      — 39/47/31/39 (initial floor)
			//   M6.7+M6.8    — 47/53/36/47 (measured 48.99/54.55/37.19/48.48)
			//   M9.widget.1  — measured 62.95/64.01/56.35/63.94 (above plan §10 target 50/55/40/50)
			//   M9.widget.2  — measured 64.27/64.03/56.97/63.24 (post-screen-1) → bump floor
			// Stretch goal остаётся 75/65/70/75 — достижимо когда component
			// tests покроют sheet/route files (vitest-browser-mode когда GA).
			thresholds: {
				lines: 60,
				branches: 60,
				functions: 55,
				statements: 60,
			},
		},
	},
})
