/**
 * Shared YDB connection for repo integration tests.
 *
 * Connects to local YDB (docker-compose: grpc://localhost:2236/local).
 * Override with YDB_CONNECTION_STRING env var (e.g. in CI).
 *
 * Usage:
 *   import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
 *   beforeAll(async () => { await setupTestDb() })
 *   afterAll(async () => { await teardownTestDb() })
 *   const repo = createXxxRepo(getTestSql())
 */
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

const YDB_CONNECTION_STRING = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2236/local'

// Worker-scoped Driver: one Driver per Vitest worker process, reused across
// all test files in that worker. Requires `isolate: false` in vitest config —
// otherwise each file gets a fresh module instance and the singleton resets.
// Rationale: empirical 2026-05-12 — 62 db-test files × N parallel workers
// each creating its own Driver in beforeAll exhausted YDB session pool
// (default 50/Driver × 62 drivers >> 1000 sessions/node cap), surfacing as
// flaky 400140 "Transaction not found" mid-handler. One Driver per worker
// keeps pool to N×50, well under cap.
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
	// under storm instead of unbounded queueing + downstream 400140 NOT_FOUND
	// (session/tx GC). @ydbjs/query 6.1.0 release-notes (2026-04-23):
	// "retries acquire a fresh lease per attempt; the transaction context is
	// attempt-scoped, so a dead session no longer poisons subsequent retries."
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
