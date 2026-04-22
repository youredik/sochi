import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { env } from '../env.ts'
import { logger } from '../logger.ts'

/**
 * YDB driver — exported synchronously so that `query(driver)` (in db/index.ts)
 * can be a top-level const. The driver is not yet "ready" at import time;
 * call `readyDriver()` once during startup before serving traffic.
 *
 * In dev we connect with anonymous credentials to a local single-node YDB.
 * In prod on Yandex Cloud, credentials come from metadata service automatically
 * (set YDB_METADATA_CREDENTIALS=1 — the driver picks them up without code changes).
 */
export const driver = new Driver(env.YDB_CONNECTION_STRING, {
	credentialsProvider: new AnonymousCredentialsProvider(),
})

export async function readyDriver(timeoutMs = 10_000): Promise<void> {
	await driver.ready(AbortSignal.timeout(timeoutMs))
	logger.info({ endpoint: env.YDB_CONNECTION_STRING }, 'YDB driver ready')
}

export async function closeDriver(): Promise<void> {
	await driver.close()
	logger.info('YDB driver closed')
}
