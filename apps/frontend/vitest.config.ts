import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: 'frontend',
		globals: false,
		passWithNoTests: true,
		include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
		exclude: ['src/**/*.e2e.test.ts'],
	},
})
