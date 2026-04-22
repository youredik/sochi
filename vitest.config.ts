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
			thresholds: {
				lines: 75,
				branches: 65,
				functions: 70,
				statements: 75,
			},
		},
	},
})
