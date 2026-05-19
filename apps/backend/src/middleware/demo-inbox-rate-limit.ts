/**
 * Per-IP rate limiter for public demo-inbox routes (`/api/public/demo/inbox` +
 * `/api/public/demo/sms-inbox`).
 *
 * Why a dedicated middleware (not widget-rate-limit):
 *   - Widget limiter keys on `(IP, tenantSlug)`; demo inbox has no slug parameter.
 *   - Demo inbox is anonymous, polled at 1Hz by the demo prospect's browser —
 *     60 req/min/IP is the canonical legitimate rate. Cap chosen to admit 2×
 *     headroom for retries / clock skew while bounding worst-case DoS.
 *
 * Storage: in-memory MemoryStore (default). Single-instance YC Serverless
 * Container deployment OK; multi-replica = key federation via Unstorage carry-
 * forward (future).
 *
 * IP extraction: leftmost `X-Forwarded-For` per canonical YC ALB header,
 * fallback `X-Real-IP`, fallback `'anonymous'` (matches widget canon).
 */
import type { Context, MiddlewareHandler } from 'hono'
import { rateLimiter } from 'hono-rate-limiter'
import type { AppEnv } from '../factory.ts'
import { extractClientIp } from './widget-rate-limit.ts'

const DEMO_INBOX_RATE_LIMIT_MESSAGE = {
	error: {
		code: 'RATE_LIMITED',
		message: 'Слишком много запросов к demo-инбоксу. Подождите минуту и попробуйте снова.',
	},
} as const

function demoInboxRateLimitKey(c: Context<AppEnv>): string {
	return extractClientIp(c)
}

/**
 * 120 req/min/IP — 1Hz polling canon × 2 headroom. Mounted в front of
 * /api/public/demo/* routes so the inbox handlers do not waste CPU on
 * floods. Returns 429 + `Retry-After`.
 */
export const demoInboxRateLimiter = rateLimiter<AppEnv>({
	windowMs: 60_000,
	limit: 120,
	keyGenerator: demoInboxRateLimitKey,
	standardHeaders: 'draft-7',
	statusCode: 429,
	message: DEMO_INBOX_RATE_LIMIT_MESSAGE,
})

/**
 * Test pass-through limiter — keep route shape без tripping the window
 * during many sequential cases.
 */
export const noopDemoInboxRateLimiter: MiddlewareHandler<AppEnv> = async (_c, next) => {
	await next()
}

/** Test-only — exposed for unit-test of key generation. */
export const __testDemoInboxRateLimitInternals = {
	demoInboxRateLimitKey,
}
