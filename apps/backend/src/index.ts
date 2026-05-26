import { serve } from '@hono/node-server'
// `./app.ts` NOT statically imported here — its top-level side-effects (CDC
// consumer start, demo seeding) would fire BEFORE applyMigrations(). Use
// dynamic import after migration in main() to fix ordering.
import { closeDriver, readyDriver, sql } from './db/index.ts'
import { applyMigrations } from './db/migrate.ts'
import { env } from './env.ts'
import { assertProductionReady, listAdapters } from './lib/adapters/index.ts'
import {
	assertNoDemoInProduction,
	assertProductionCaptchaConfigured,
} from './lib/production-guards.ts'
import { createShutdownHandler } from './lib/shutdown.ts'
import { logger } from './logger.ts'

async function main(): Promise<void> {
	// Pre-warm YDB connection so /health/db is fast on first call.
	await readyDriver()

	// Apply YDB migrations as init step (Q2 2026 canon — см. db/migrate.ts).
	// MUST run BEFORE app.ts dynamic import: app.ts side-effects (CDC consumers,
	// demo seeding) hit YDB at module-load — would crash на empty schema.
	//
	// Sprint C+ Round 6 P1 fix 2026-05-24 (Performance scale architect):
	// RUN_MIGRATIONS env-gate. Runtime container can skip applier entirely
	// (cold-start: 3.6s → ~50ms) когда деплой job уже applied migrations.
	// Default=true сохраняет backward compat — operator explicitly sets
	// RUN_MIGRATIONS=false на runtime container env.
	if (env.RUN_MIGRATIONS) {
		const migrationResult = await applyMigrations({
			sql,
			log: (msg) => logger.info({ phase: 'migrate' }, msg),
		})
		logger.info(
			{
				phase: 'migrate',
				total: migrationResult.totalMigrations,
				newlyApplied: migrationResult.newlyApplied,
				alreadyAtHead: migrationResult.alreadyAtHead,
			},
			'YDB migrations complete',
		)
	} else {
		logger.info({ phase: 'migrate' }, 'RUN_MIGRATIONS=false — skipping applier (detached path)')
	}

	// Dynamic import AFTER migrations — fires app.ts side-effects with schema
	// in place. Bypasses ES module static-import ordering trap.
	const { app, stopApp, demoBootPromise } = await import('./app.ts')

	// Round 12 polish — await demo channel-infra seed BEFORE binding listener.
	// Closes the 100 ms cold-start race window Round 10 P0-1 had acknowledged
	// (webhook receiver returning 401/403 before seed populated webhookSecret +
	// channelConnection). In production this is a `Promise.resolve()` no-op
	// (env-gated branch in app.ts).
	await demoBootPromise

	// Sandbox / Production gate (see env.ts APP_MODE comment). Importing
	// `app.ts` above triggered every adapter factory's `registerAdapter()`
	// call as a top-level side-effect, so by this point the registry is
	// populated. We refuse to start in production with any non-live adapter
	// (unless explicitly whitelisted via APP_MODE_PERMITTED_MOCK_ADAPTERS).
	if (env.APP_MODE === 'production') {
		assertNoDemoInProduction(env)
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

	// Single-owner SIGTERM/SIGINT teardown via testable factory (see lib/shutdown.ts).
	const shutdown = createShutdownHandler({
		server,
		closeDriver,
		stopApp,
		exit: (code) => process.exit(code),
		logger,
	})

	process.once('SIGINT', () => {
		shutdown('SIGINT').catch((err) => {
			logger.error({ err }, 'Shutdown error')
			process.exit(1)
		})
	})
	process.once('SIGTERM', () => {
		shutdown('SIGTERM').catch((err) => {
			logger.error({ err }, 'Shutdown error')
			process.exit(1)
		})
	})
}

main().catch((err) => {
	// Canon Q2 2026 (2026-05-19): emit BOTH the structured pino record
	// (JSON consumers see `err.message` + stack in payload) AND a raw stderr
	// blob so YC Logging's text-format render preserves the actual failure
	// detail. Pino's `msg` field is what surfaces в «text» view — a bare
	// «Fatal startup error» там без err.message is operationally useless
	// когда wrapped migrate.ts error carries statement-index + YDB issues.
	const msg = err instanceof Error ? err.message : String(err)
	logger.error({ err }, `Fatal startup error: ${msg.split('\n')[0]}`)
	process.stderr.write(`\n=== FATAL STARTUP ERROR ===\n${msg}\n`)
	if (err instanceof Error && err.stack) {
		process.stderr.write(`=== STACK ===\n${err.stack}\n=== END ===\n`)
	}
	process.exit(1)
})
