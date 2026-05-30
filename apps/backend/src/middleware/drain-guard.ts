import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../factory.ts'
import { shouldRejectWhileDraining } from '../lib/lifecycle.ts'

/**
 * Drain guard (2026-05-30) — once SIGTERM has flipped the lifecycle flag, reject
 * NEW non-health traffic with a retryable 503 + `Retry-After` BEFORE any handler
 * issues a YDB query.
 *
 * Why (root-cause canon, verified vs yandex.cloud docs + @ydbjs@6 source): YC
 * Serverless Containers keep routing to the OLD instance for ~2-3 s after it
 * receives SIGTERM (no readiness probe / no «stop routing me» signal), and
 * `@ydbjs@6 Driver.close()` does NOT drain in-flight queries. Without this guard
 * a late request hits a dead gRPC channel → raw «Channel has been shut down» =
 * HTTP 500 (observed: demo-funnel smoke [E2] lost magic-link + a real prospect's
 * signup would be stranded mid-deploy). A 503 is retryable — the platform/Envoy
 * re-issues to the live new revision, and the YDB query is never even attempted.
 *
 * `/health*` is exempt (see `shouldRejectWhileDraining`): liveness must stay 200
 * so YC does not treat the process as dead; `/health/ready` returns its own
 * draining 503 used by the CI deploy-verify gate.
 */
export const drainGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (shouldRejectWhileDraining(c.req.path)) {
		c.header('Retry-After', '2')
		return c.json(
			{
				error: {
					code: 'SERVICE_DRAINING',
					message: 'Сервис перезапускается, повторите запрос через пару секунд',
				},
			},
			503,
		)
	}
	return next()
}
