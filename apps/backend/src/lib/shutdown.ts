/**
 * Graceful shutdown handler factory (B7 fix, 2026-05-19).
 *
 * Single owner of the SIGTERM/SIGINT teardown sequence. Previously `app.ts`
 * registered a fire-and-forget `void stopApp()` AND `index.ts` did its own
 * `server.close() → closeDriver() → process.exit(0)` without awaiting — race
 * killed CDC consumers mid-flush, replaying messages on every restart.
 *
 * Canonical order:
 *   1. stopApp()      — drain CDC consumers, broadcast SSE shutdown, stop crons
 *   2. server.close() — refuse new connections, finish in-flight requests
 *   3. closeDriver()  — release YDB session pool only AFTER writes flushed
 *   4. exit(0)        — clean exit
 *
 * `shuttingDown` re-entry guard collapses second SIGTERM (k8s/ALB may redeliver
 * during slow drain) к no-op so we never double-execute stopApp / close /
 * closeDriver.
 *
 * DI-shaped: every external dep injected so the handler is testable without
 * spawning a real server / DB / process. `index.ts main()` wires real values.
 */

export interface ShutdownDeps {
	server: { close(): void }
	closeDriver: () => Promise<void>
	stopApp: () => Promise<void>
	exit: (code: number) => never
	logger: {
		info: (obj: Record<string, unknown>, msg?: string) => void
		error: (obj: Record<string, unknown>, msg?: string) => void
	}
}

export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
	let shuttingDown = false
	return async (signal: string): Promise<void> => {
		if (shuttingDown) return
		shuttingDown = true
		deps.logger.info({ signal }, 'Shutting down')
		try {
			await deps.stopApp()
		} catch (err) {
			deps.logger.error({ err }, 'stopApp failed during shutdown')
		}
		deps.server.close()
		await deps.closeDriver()
		deps.exit(0)
	}
}
