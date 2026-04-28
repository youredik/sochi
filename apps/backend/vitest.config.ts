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
		// hookTimeout default 10s недостаточно для setupTestDb/teardownTestDb
		// под YDB load когда test:serial прогоняет 130+ файлов подряд (sustained
		// pressure на shared YDB instance). 30s даёт запас на инициализацию
		// connection pool + cleanup на медленных запусках. Default testTimeout
		// (5s per test) сохраняется — actual test bodies не должны быть медленными.
		// Memory: feedback_test_serial_for_pre_push.md.
		hookTimeout: 30_000,
	},
})
