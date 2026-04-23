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

let driver: Driver | null = null
let sql: ReturnType<typeof query> | null = null

export async function setupTestDb() {
	driver = new Driver(YDB_CONNECTION_STRING, {
		credentialsProvider: new AnonymousCredentialsProvider(),
	})
	await driver.ready(AbortSignal.timeout(10_000))
	sql = query(driver)
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
	if (driver) {
		await driver.close()
		driver = null
		sql = null
	}
}
