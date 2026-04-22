import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: 'backend',
		globals: false,
		passWithNoTests: true,
		include: ['src/**/*.test.ts'],
	},
})
