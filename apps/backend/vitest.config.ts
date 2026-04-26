import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: 'backend',
		globals: false,
		passWithNoTests: true,
		include: ['src/**/*.test.ts'],
		// Populate process.env defaults so tests that import `env.ts` (directly
		// or via middleware) don't fail with `process.exit(1)` on schema validation.
		setupFiles: ['src/tests/env-defaults.ts'],
	},
})
