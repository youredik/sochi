import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { closeDriver, readyDriver } from './db/index.ts'
import { env } from './env.ts'
import { assertProductionReady, listAdapters } from './lib/adapters/index.ts'
import { logger } from './logger.ts'

/**
 * Symmetric to `[N1]` localhost canon in `captcha-gate.ts`: production MUST
 * have captcha actually configured. Without this guard a missed env var
 * would silently disable email-enumeration protection on the public surface
 * — the gate falls through to `reason: 'disabled'` and every magic-link
 * request goes ungated. Demo deployments (`DEMO_DEPLOYMENT=true`) are
 * exempt — they're publicly friction-free by design per `[[demo_strategy]]`.
 */
function assertProductionCaptchaConfigured(e: typeof env): void {
	if (e.DEMO_DEPLOYMENT) return
	if (e.SMARTCAPTCHA_SERVER_KEY && e.SMARTCAPTCHA_SERVER_KEY.length > 0) return
	throw new Error(
		'Refusing to start in APP_MODE=production: SMARTCAPTCHA_SERVER_KEY is unset and DEMO_DEPLOYMENT=false. ' +
			'Either configure SmartCaptcha (see env.ts SMARTCAPTCHA_SERVER_KEY) or flip DEMO_DEPLOYMENT=true for public demo builds.',
	)
}

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
		assertProductionCaptchaConfigured(env)
	}
	logger.info(
		{
			appMode: env.APP_MODE,
			adapters: listAdapters().map((a) => ({ name: a.name, mode: a.mode })),
		},
		'Adapter registry ready',
	)

	// Dev-only mock visibility — surfaces «forgot to restart after editing .env»
	// trap immediately on startup instead of при первом live-зависимом запросе
	// (Node's `--env-file-if-exists` reads .env once at process start; unlike
	// Bun's `--watch`, it is NOT reactive to .env edits). If user wants live
	// DaData but the dev server была started before `DADATA_API_KEY` landed
	// в `.env`, this warning fires and a single Ctrl+C / restart fixes it.
	if (env.NODE_ENV === 'development' && env.APP_MODE === 'sandbox') {
		if (!env.DADATA_API_KEY) {
			logger.warn(
				'DaData runs в mock-режиме: DADATA_API_KEY is unset. Mock returns canonical ' +
					'demo set only (Сочи/Сириус/Красная Поляна) — real ИНН lookups will ' +
					'return null. Set DADATA_API_KEY в .env and restart the backend ' +
					'(Node --env-file is non-reactive to .env edits).',
			)
		}
	}

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
