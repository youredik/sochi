import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the YDB integration db-tests (`*.db.test.ts`).
 *
 * WHY a separate runner (not `bun test`): these tests open REAL gRPC/HTTP-2
 * connections to local YDB. Bun 1.3.14's `bun test` http2 client mis-handles
 * new `ClientHttp2Session` creation (numeric `authority` TypeError) → the
 * error-path tests abort. Production runs on **Node 24** (`@hono/node-server`),
 * where gRPC/HTTP-2 is rock-solid; running these tests on Node via Vitest makes
 * them execute on the SAME runtime as prod and eliminates the Bun-only defect.
 *
 * The fast unit/logic suites stay on `bun test` (faster). Bun also remains the
 * package manager + dev runtime. See memory `feedback_bun_test_http2_grpc_*`.
 *
 * Vite transforms TS (esbuild), so Node's native type-stripping limits (enums,
 * namespaces) don't apply — full TS works. Workspace packages (`@horeca/*`)
 * resolve via pnpm symlinks under Node.
 */
export default defineConfig({
	test: {
		include: ['src/**/*.db.test.ts'],
		// Same test-env defaults bun loaded via `bunfig.toml [test] preload` —
		// sets TZ=Europe/Moscow + placeholder env so `env.ts` Zod validation
		// passes instead of `process.exit(1)` on import. (We deliberately do NOT
		// preload the driver-mock: db-tests need the REAL YDB driver.)
		setupFiles: ['./src/tests/env-defaults.ts'],
		// Fail-fast guard: abort if the local dev backend (port 8787) is running,
		// because its CDC consumers process rows these tests seed into the shared
		// local YDB and corrupt assertions (silent flakes — root-caused 2026-05-30;
		// see guard-shared-ydb.ts). Integration tests must own their database; this
		// turns a silent flake into a loud, actionable failure. No-op in CI.
		globalSetup: ['./src/tests/guard-shared-ydb.ts'],
		// Match the per-file `jest.setTimeout(60_000)` the bun suite used.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// Real local single-node YDB has a bounded session pool. db-setup creates
		// ONE driver per worker (maxSize 50). Use process forks (clean gRPC state
		// per worker) and cap them so concurrent files don't exhaust YDB sessions.
		// Integration tests touch a shared local YDB → run them SEQUENTIALLY
		// (2026 canon: integration sequential, unit parallel). Forks pool for clean
		// gRPC state per file. (The earlier folio-balance / backfill flakes were NOT
		// parallelism or @ydbjs bugs — they were the dev backend's CDC consumers
		// contaminating the shared YDB; the guard above closes that. Sequential is
		// still the right call for a shared single-node YDB.)
		pool: 'forks',
		fileParallelism: false,
		// Integration tests touch shared tenant ranges — keep file-level isolation
		// but don't randomize, for reproducible YDB contention behaviour.
		sequence: { shuffle: false },
		reporters: ['default'],
	},
})
