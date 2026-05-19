import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata'
import { Driver } from '@ydbjs/core'
import { env } from '../env.ts'
import { logger } from '../logger.ts'

/**
 * YDB driver — exported synchronously so that `query(driver)` (in db/index.ts)
 * can be a top-level const. The driver is not yet "ready" at import time;
 * call `readyDriver()` once during startup before serving traffic.
 *
 * Credentials selection (Q2 2026 canon):
 *   - Local dev (`YDB_METADATA_CREDENTIALS` unset): AnonymousCredentialsProvider —
 *     local single-node YDB Docker accepts unauthenticated traffic.
 *   - YC Serverless Container (`YDB_METADATA_CREDENTIALS=1`):
 *     MetadataCredentialsProvider polls 169.254.169.254 для IAM token —
 *     canonical for in-cloud workloads, no SA key files.
 */
const credentialsProvider =
	env.YDB_METADATA_CREDENTIALS === '1' || env.YDB_METADATA_CREDENTIALS === 'true'
		? new MetadataCredentialsProvider()
		: new AnonymousCredentialsProvider()

export const driver = new Driver(env.YDB_CONNECTION_STRING, {
	credentialsProvider,
})

export async function readyDriver(timeoutMs = 10_000): Promise<void> {
	await driver.ready(AbortSignal.timeout(timeoutMs))
	logger.info({ endpoint: env.YDB_CONNECTION_STRING }, 'YDB driver ready')
}

export async function closeDriver(): Promise<void> {
	await driver.close()
	logger.info('YDB driver closed')
}
