import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { closeDriver, readyDriver } from './db/index.ts'
import { env } from './env.ts'
import { logger } from './logger.ts'

async function main(): Promise<void> {
	// Pre-warm YDB connection so /health/db is fast on first call.
	await readyDriver()

	const server = serve(
		{
			fetch: app.fetch,
			port: env.PORT,
		},
		(info) => {
			logger.info({ port: info.port, env: env.NODE_ENV }, 'Backend listening')
		},
	)

	const shutdown = async (signal: string): Promise<void> => {
		logger.info({ signal }, 'Shutting down')
		server.close()
		await closeDriver()
		process.exit(0)
	}

	process.on('SIGINT', () => {
		shutdown('SIGINT').catch((err) => {
			logger.error({ err }, 'Shutdown error')
			process.exit(1)
		})
	})
	process.on('SIGTERM', () => {
		shutdown('SIGTERM').catch((err) => {
			logger.error({ err }, 'Shutdown error')
			process.exit(1)
		})
	})
}

main().catch((err) => {
	logger.error({ err }, 'Fatal startup error')
	process.exit(1)
})
