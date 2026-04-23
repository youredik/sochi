import { getContext, tryGetContext } from 'hono/context-storage'
import type { AppEnv } from './factory.ts'

/**
 * Request-scoped context accessors backed by Node's `AsyncLocalStorage`
 * (via Hono's `contextStorage()` middleware, wired in app.ts).
 *
 * Lets deeply-nested code — repos, background handlers spawned from a request,
 * helpers — read `requestId` / `tenantId` / `logger` without threading them
 * through every function parameter.
 *
 * Rules:
 *   - `requestContext()` throws when called outside a request scope (e.g. at
 *     startup). Use `tryRequestContext()` for optional access.
 *   - Do NOT use this to *pass* data into deeply nested code — that couples the
 *     callee to HTTP semantics. Use it only for observability / audit-level
 *     read access (logging, tracing, audit tags).
 *   - Guaranteed to propagate across `await`, `setTimeout`, `Promise.then`,
 *     and any async boundary that doesn't manually detach the AsyncLocalStorage.
 */
export function requestContext() {
	return getContext<AppEnv>()
}

export function tryRequestContext() {
	return tryGetContext<AppEnv>()
}

/** Convenience: current requestId (outside a request → throws). */
export function currentRequestId(): string {
	return requestContext().var.requestId
}
