import { availableParallelism } from 'node:os'

import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: 'backend',
		globals: false,
		passWithNoTests: true,
		include: ['src/**/*.test.ts'],
		// Cap workers for DB-parallel storm safety: single shared local-ydb,
		// each worker carries its own Driver+pool of 50 sessions. Default
		// `availableParallelism()` (8-12 on Apple Silicon) × 50 = 400-600
		// sessions vs YDB-node cap 1000 — close to ceiling. Cap at 4 leaves
		// headroom + matches 2026 canon (vitest.dev/guide/improving-performance:
		// «If you have an external resource that can't handle concurrent access,
		// lower maxWorkers»). Empirical Phase 15 2026-05-12: without cap = 3%
		// rerun flake; with cap=4 expected 0.
		maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)),
		minWorkers: 1,
		// Required by Vitest 4 when projects have different `maxWorkers`:
		// «Projects … have different 'maxWorkers' but same 'sequence.groupOrder'».
		// Backend runs first (DB tests), then shared+frontend (in-memory).
		sequence: { groupOrder: 1 },
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
		// Spike B 2026-05-12: share module graph across files in same worker
		// so worker-scoped YDB Driver singleton in tests/db-setup.ts actually
		// persists (default isolate:true gives fresh module per file → each
		// file recreates Driver → session pool storm → 400140 flake under
		// parallel file mode). Empirical baseline pending.
		isolate: false,
	},
})
