/**
 * Process lifecycle / draining flag — single source of truth for «this instance
 * is shutting down» so the readiness probe + the request guard react to SIGTERM
 * the instant it lands, BEFORE the YDB driver is torn down.
 *
 * Why this exists (root-cause canon 2026-05-30, verified against yandex.cloud
 * docs + @ydbjs@6 source):
 *   - YC Serverless Containers expose NO readiness probe and NO app-controlled
 *     «stop routing to me» signal. Routing is 100% platform-controlled.
 *   - On a revision deploy the OLD instance keeps receiving HTTP for ~2-3 s
 *     AFTER it gets SIGTERM (docs are silent on the deploy drain path — observed
 *     empirically in the demo-funnel smoke + prod logs).
 *   - `@ydbjs@6 Driver.close()` is immediate and does NOT drain in-flight
 *     queries; a request that lands mid-shutdown hits a dead gRPC channel and
 *     throws raw «Channel has been shut down» → HTTP 500 (observed: demo-funnel
 *     smoke [E2] lost magic-link + a real prospect's signup would be stranded).
 *
 * This flag lets the app convert that race into a graceful outcome:
 *   1. A request guard returns 503 + Retry-After for late traffic (retryable;
 *      the platform/Envoy re-issues to the live new revision) instead of a 500
 *      from a dead driver — the YDB query is never even attempted.
 *   2. `/health/ready` flips to 503 — consumed by our CI deploy-verify gate to
 *      know the instance is draining (YC itself ignores it, but the gate polls
 *      `/health` build-SHA to wait out the drain before smoke).
 *
 * Deliberately a module-level boolean (process-global) — there is exactly one
 * process lifecycle. Test isolation via `__resetLifecycleForTesting()` per the
 * bun-test `__resetForTesting()` canon.
 */

let draining = false

/** Mark the process as draining — called first thing in the SIGTERM/SIGINT handler. */
export function beginDraining(): void {
	draining = true
}

/** True once SIGTERM/SIGINT teardown has begun. */
export function isDraining(): boolean {
	return draining
}

/** Test-only reset — bun-test canon `__resetForTesting()`. */
export function __resetLifecycleForTesting(): void {
	draining = false
}

/**
 * Health endpoints stay reachable while draining: liveness (/health/live) MUST
 * keep returning 200 so YC does not treat the process as dead, and /health/ready
 * returns its own draining 503. Everything else is 503'd.
 */
export const DRAIN_EXEMPT_PATH_PREFIX = '/health'

/**
 * Decision for the drain guard middleware: should this request get a retryable
 * 503 because we're shutting down? True only when draining AND the path is not a
 * health endpoint. Pure (draining injectable) so the decision is unit-testable
 * without standing up the Hono app or its CDC side-effects.
 */
export function shouldRejectWhileDraining(path: string, draining: boolean = isDraining()): boolean {
	return draining && !path.startsWith(DRAIN_EXEMPT_PATH_PREFIX)
}
