import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { closeDriver, readyDriver } from './db/index.ts'
import { env } from './env.ts'
import { assertProductionReady, listAdapters } from './lib/adapters/index.ts'
import { logger } from './logger.ts'

async function main(): Promise<void> {
	// Pre-warm YDB connection so /health/db is fast on first call.
	await readyDriver()

	// Sandbox / Production gate (see env.ts APP_MODE comment). Importing
	// `app.ts` above triggered every adapter factory's `registerAdapter()`
	// call as a top-level side-effect, so by this point the registry is
	// populated. We refuse to start in production with any non-live adapter
	// (unless explicitly whitelisted via APP_MODE_PERMITTED_MOCK_ADAPTERS).
	if (env.APP_MODE === 'production') {
		assertProductionReady({ permittedMockAdapters: env.APP_MODE_PERMITTED_MOCK_ADAPTERS })
	}
	logger.info(
		{
			appMode: env.APP_MODE,
			adapters: listAdapters().map((a) => ({ name: a.name, mode: a.mode })),
		},
		'Adapter registry ready',
	)

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
