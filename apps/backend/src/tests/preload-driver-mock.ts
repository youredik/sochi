/**
 * Bun test preload — mock YDB driver to avoid eager gRPC connection.
 *
 * Problem: `src/db/driver.ts` calls `new Driver(YDB_CONNECTION_STRING)` at
 * module load. Tests that transitively import this (через app.ts → routes →
 * middleware) trigger gRPC ListEndpoints к localhost:2236. Локально OK
 * (docker-compose YDB); в CI test:fast — ECONNREFUSED → test fails при
 * первом query.
 *
 * Solution (canon 2026-05-20 research): `mock.module()` в SEPARATE preload
 * entry — заменить driver до того как app code его импортирует. Per Bun docs:
 * «If you mock a module that's already been imported, the original module
 * body will still have been evaluated». Поэтому MUST be в preload, не в
 * beforeAll.
 *
 * Tests которые нуждаются в реальном YDB driver (`*.db.test.ts`) запускаются
 * отдельно через `test:db` script (без этого preload) — canon
 * `feedback_test_loop_canon.md`.
 *
 * Wire-up: `apps/backend/bunfig.toml` `[test] preload = [..., this file]`.
 */

import { mock } from 'bun:test'

const fakeDriver = {
	ready: async () => {},
	close: async () => {},
	queryClient: {
		// Minimal stub — tests using fake services won't reach here.
		begin: async () => {
			throw new Error('YDB driver mocked — use *.db.test.ts for real-driver coverage')
		},
	},
} as unknown as import('@ydbjs/core').Driver

mock.module('../db/driver.ts', () => ({
	driver: fakeDriver,
	readyDriver: async () => {},
	closeDriver: async () => {},
}))
