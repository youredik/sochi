/**
 * Shared YDB connection for repo integration tests.
 *
 * Connects to local YDB (docker-compose: grpc://localhost:2236/local).
 * Override with YDB_CONNECTION_STRING env var (e.g. in CI).
 *
 * ## Why a SEPARATE driver (not the production global `db/index.ts` one)
 * Empirically (2026-05-30): under `bun test`, a `Driver` created at MODULE-LOAD
 * time (the global `db/index.ts` singleton) resolves a different `@ydbjs/core`
 * client surface than `@ydbjs/query` uses at query time — its internal
 * `createClient` reads back `undefined` → `driver.createClient is not a function`.
 * A `Driver` constructed at RUNTIME inside `setupTestDb()` (after the test
 * runtime is initialized) binds the correct client and works. Hence repos under
 * test take an injected `sql` (`createXxxRepo(getTestSql())`); code that uses the
 * global `sql` directly (e.g. `resolveTenantBySlug`) must accept it via DI so the
 * test can pass this working client.
 *
 * One Driver per worker process (singleton), reused across all test files —
 * 62 db-test files each creating their own Driver exhausted the YDB session pool
 * (default 50/Driver × 62 >> node cap) → flaky 400140 "Transaction not found".
 *
 * Usage:
 *   import { getTestSql, setupTestDb, teardownTestDb } from '../tests/db-setup.ts'
 *   beforeAll(async () => { await setupTestDb() })
 *   afterAll(async () => { await teardownTestDb() })
 *   const repo = createXxxRepo(getTestSql())
 */
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

const YDB_CONNECTION_STRING = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2236/local'

let driver: Driver | null = null
let sql: ReturnType<typeof query> | null = null

export async function setupTestDb() {
	if (driver && sql) return sql
	driver = new Driver(YDB_CONNECTION_STRING, {
		credentialsProvider: new AnonymousCredentialsProvider(),
	})
	await driver.ready(AbortSignal.timeout(10_000))
	// Match production pool config (apps/backend/src/db/index.ts) — bounded
	// waiter queue (maxSize × waitQueueFactor = 400) gives fast `SessionPoolFullError`
	// under storm instead of unbounded queueing + downstream 400140 NOT_FOUND.
	sql = query(driver, {
		poolOptions: { maxSize: 50, waitQueueFactor: 8 },
	})
	return sql
}

export function getTestSql() {
	if (!sql) throw new Error('Test DB not available — YDB Docker not running')
	return sql
}

export function getTestDriver() {
	if (!driver) throw new Error('Test DB not available — YDB Docker not running')
	return driver
}

export async function teardownTestDb() {
	// No-op: Driver lifecycle is worker-scoped. OS reaps on worker exit.
	// Closing per file would defeat the singleton + cause connection churn.
}
