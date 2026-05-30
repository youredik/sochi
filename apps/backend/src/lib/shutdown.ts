/**
 * Graceful shutdown handler factory (B7 fix 2026-05-19; drain-safe rewrite
 * 2026-05-30).
 *
 * Single owner of the SIGTERM/SIGINT teardown sequence.
 *
 * ## Why the 2026-05-30 rewrite
 *
 * Root cause of demo-funnel smoke [E2] flakiness + a real risk to prospects:
 * during a YC Serverless Container *revision deploy*, the OLD instance keeps
 * receiving HTTP for ~2-3 s AFTER it gets SIGTERM (YC has no readiness probe
 * and no app-controlled «stop routing me» signal — verified vs yandex.cloud
 * docs). The previous handler called `server.close()` (a NON-blocking `void`
 * that only stops NEW connections and does NOT await in-flight) and then
 * IMMEDIATELY `closeDriver()`. `@ydbjs@6 Driver.close()` is synchronous and
 * does NOT drain in-flight queries, so any request still being served (or
 * arriving in the post-SIGTERM routing tail on an Envoy keep-alive connection)
 * hit a dead gRPC channel → raw «Channel has been shut down» = HTTP 500 +
 * a lost magic-link capture.
 *
 * ## Canonical drain-safe order (this file)
 *   1. beginDraining()  — flip the lifecycle flag so the request guard returns
 *                         503 (retryable) for NEW traffic and /health/ready → 503.
 *                         The YDB query is never attempted → 503 not 500.
 *   2. sleep(drainDelayMs) — keep the server + driver FULLY ALIVE during YC's
 *                         post-SIGTERM routing tail (YC long-lived containers
 *                         grant up to 10 min; we spend ~4 s). New requests in
 *                         this window are 503'd by the guard; in-flight finish.
 *   3. stopApp()        — drain CDC consumers, broadcast SSE shutdown, stop crons.
 *   4. closeServer()    — stop accepting + AWAIT in-flight to finish (promisified
 *                         server.close callback) + closeIdleConnections() to drop
 *                         idle keep-alives so Envoy can't reuse them. Bounded by
 *                         serverCloseTimeoutMs so a stuck socket can't hang past
 *                         the grace budget.
 *   5. closeDriver()    — release the YDB driver LAST, only after no request can
 *                         still issue a query.
 *   6. exit(0).
 *
 * `shuttingDown` re-entry guard collapses a second SIGTERM (YC/ALB may redeliver
 * during slow drain) to a no-op so we never double-execute the sequence.
 *
 * DI-shaped: every external dep + the drain delay + an injectable `sleep` are
 * injected so the handler is fully testable without spawning a real server / DB
 * / process / timers. `index.ts main()` wires real values.
 */

/** Default pre-drain delay — research-grounded 3-5 s; well under YC's 10-min budget. */
export const DEFAULT_DRAIN_DELAY_MS = 4000
/** Default bound on awaiting in-flight requests before forcing driver close. */
export const DEFAULT_SERVER_CLOSE_TIMEOUT_MS = 8000

export interface ShutdownDeps {
	server: {
		/** Node http.Server.close — fires the callback once all connections are closed. */
		close(callback?: (err?: Error) => void): void
		/** Node 18.2+/http.Server — drop idle keep-alive sockets so the close callback can settle. */
		closeIdleConnections?: () => void
	}
	closeDriver: () => Promise<void>
	stopApp: () => Promise<void>
	/** Flip the process lifecycle flag (lib/lifecycle.ts `beginDraining`). */
	beginDraining: () => void
	/** Pre-drain delay (ms) — keep serving through YC's post-SIGTERM routing tail. */
	drainDelayMs: number
	/** Injectable sleep — real `setTimeout` in prod, fake/instant in tests. */
	sleep: (ms: number) => Promise<void>
	/** Upper bound on awaiting in-flight requests in closeServer (default 8 s). */
	serverCloseTimeoutMs?: number
	exit: (code: number) => never
	logger: {
		info: (obj: Record<string, unknown>, msg?: string) => void
		error: (obj: Record<string, unknown>, msg?: string) => void
	}
}

/**
 * Stop accepting new connections and AWAIT in-flight requests to finish before
 * resolving. `closeIdleConnections()` drops idle keep-alive sockets (Envoy
 * upstream pool) so `server.close()`'s callback isn't held open by them.
 * Bounded by `serverCloseTimeoutMs` — a wedged socket must not hang teardown
 * past the platform grace budget.
 */
async function closeServer(deps: ShutdownDeps): Promise<void> {
	const closed = new Promise<void>((resolve) => {
		deps.server.close(() => resolve())
	})
	// Drop idle keep-alives AFTER registering close so the close callback can settle.
	deps.server.closeIdleConnections?.()
	const timeoutMs = deps.serverCloseTimeoutMs ?? DEFAULT_SERVER_CLOSE_TIMEOUT_MS
	const timedOut = Symbol('timeout')
	const result = await Promise.race([
		closed.then(() => 'closed' as const),
		deps.sleep(timeoutMs).then(() => timedOut),
	])
	if (result === timedOut) {
		deps.logger.error(
			{ timeoutMs },
			'server.close exceeded timeout — forcing driver close (in-flight may be cut)',
		)
	}
}

export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
	let shuttingDown = false
	return async (signal: string): Promise<void> => {
		if (shuttingDown) return
		shuttingDown = true
		// 1. Flip the lifecycle flag FIRST — request guard now 503s new traffic
		//    (retryable; never issues a YDB query) and /health/ready reports 503.
		deps.beginDraining()
		deps.logger.info({ signal, drainDelayMs: deps.drainDelayMs }, 'Shutting down — draining')
		// 2. Pre-drain: stay fully alive through YC's post-SIGTERM routing tail.
		if (deps.drainDelayMs > 0) {
			await deps.sleep(deps.drainDelayMs)
		}
		// 3. Drain CDC consumers / SSE / crons.
		try {
			await deps.stopApp()
		} catch (err) {
			deps.logger.error({ err }, 'stopApp failed during shutdown')
		}
		// 4. Stop accepting + await in-flight finish + drop idle keep-alives.
		await closeServer(deps)
		// 5. YDB driver LAST — no request can still issue a query.
		await deps.closeDriver()
		// 6. Clean exit.
		deps.exit(0)
	}
}
