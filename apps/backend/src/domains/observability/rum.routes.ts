/**
 * RUM ingest routes — M9.widget.7 / A5.2 / D7.
 *
 * `POST /api/rum/v1/web-vitals` — accepts `RumBatchSchema` from frontend, runs
 * 152-ФЗ edge-anonymization (IP truncate via `truncateIp`), pushes to in-memory
 * `RumBuffer` (5000-cap, drop-oldest). YC Monitoring exporter drains the
 * buffer on a 15s interval (wired in `app.ts` startup).
 *
 * **Anti-abuse:**
 *   - Rate-limit: 60 req/min/IP via `rateLimiter` (less aggressive than widget
 *     POST — RUM clients send 1-2 req/s normally; allow burst).
 *   - Body size: zod max(16) batch + per-metric structural caps (max(2048)
 *     for selectors, max(64) for IDs).
 *   - CORS: `'*'` no credentials — RUM is anonymous telemetry; embed widget
 *     on third-party origin must be able to POST.
 *
 * **Response shape:** always `{ ok: true }` 204-equivalent. Never echo the
 * received payload (no oracle for replay attacks). 4xx for invalid body
 * shape only.
 */

import { zValidator } from '@hono/zod-validator'
import { RumBatchSchema, truncateIp } from '@horeca/shared/rum'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { rateLimiter } from 'hono-rate-limiter'
import type { AppEnv } from '../../factory.ts'
import { extractClientIp } from '../../middleware/widget-rate-limit.ts'
import type { RumBuffer } from './rum.repo.ts'

export interface RumRoutesDeps {
	readonly buffer: RumBuffer
	/** Test seam — bypass rate-limiter to exercise route logic */
	readonly disableRateLimit?: boolean
}

const RATE_LIMIT_MESSAGE = {
	error: { code: 'RATE_LIMITED', message: 'Слишком много RUM-метрик. Подождите.' },
} as const

/**
 * Build RUM routes Hono mount. Mounted at `/api/rum` in `app.ts`.
 */
export function createRumRoutes(deps: RumRoutesDeps): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	// Permissive CORS — RUM is anonymous telemetry; embedded widget on third-
	// party origin MUST be able to POST without credentials.
	app.use(
		'*',
		cors({
			origin: '*',
			allowMethods: ['POST', 'OPTIONS'],
			allowHeaders: ['content-type'],
			credentials: false,
			maxAge: 600,
		}),
	)

	if (!deps.disableRateLimit) {
		app.use(
			'/v1/web-vitals',
			rateLimiter<AppEnv>({
				windowMs: 60_000,
				limit: 60,
				keyGenerator: (c) => extractClientIp(c),
				standardHeaders: 'draft-7',
				statusCode: 429,
				message: RATE_LIMIT_MESSAGE,
			}),
		)
	}

	app.post('/v1/web-vitals', zValidator('json', RumBatchSchema), async (c) => {
		const body = c.req.valid('json')
		const truncated = truncateIp(extractClientIp(c))
		for (const metric of body.metrics) {
			deps.buffer.push(metric, truncated)
		}
		return c.json({ ok: true }, 200)
	})

	return app
}
