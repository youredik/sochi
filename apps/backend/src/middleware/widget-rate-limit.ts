/**
 * Per-IP rate limiting для public widget POST routes (M9.widget.4 / D6).
 *
 * Two stacked limiters per Vercel 2026 anti-abuse canon:
 *   - **Burst**: 10 requests / 60s / (IP, tenantSlug) — protects against
 *     double-click + bots scraping availability+pricing endpoints
 *   - **Steady**: 100 requests / 1h / (IP, tenantSlug) — caps prolonged
 *     campaigns from same client without affecting legitimate retry waves
 *
 * Key = IP + tenantSlug. Per-propertyId granularity не реалистична: rate-limit
 * фaers перед zValidator, body еще не parsed; URL only contains slug. Plan
 * §6 D6 "per slug+propertyId" redacted к "per slug" (sufficient anti-abuse;
 * propertyId added later through Idempotency-Key dedup separately).
 *
 * Storage: in-memory `MemoryStore` (default). Single-instance YC Serverless
 * Container OK; multi-instance requires Redis/Unstorage carry-forward.
 *
 * IP extraction (B7 fix 2026-05-19): right-most-trusted-proxy canon via shared
 * `lib/net/client-ip.ts` `resolveClientIpSync`. Supersedes legacy leftmost-wins
 * which admitted CVE-2025-68949-class XFF spoofing for rate-limit bypass. The
 * sync variant skips `getConnInfo` TCP-peer lookup (hono-rate-limiter
 * `keyGenerator` is sync) и right-walks XFF instead. Production deploys behind
 * Yandex Cloud ALB get the full canon via TRUSTED_PROXY_CIDRS env.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { rateLimiter } from 'hono-rate-limiter'
import { env } from '../env.ts'
import type { AppEnv } from '../factory.ts'
import { resolveClientIpSync } from '../lib/net/client-ip.ts'

/**
 * Extract client IP via right-most-trusted-proxy canon (sync variant —
 * `keyGenerator` cannot await). Returns `'anonymous'` if no IP determinable.
 *
 * Constructs a `Headers` object from the two relevant fields the canon
 * consumes (`x-forwarded-for` + `x-real-ip`) rather than relying на
 * `c.req.raw.headers` — keeps the surface compatible с structural Hono
 * Context mocks used в unit tests.
 */
export function extractClientIp(c: Context<AppEnv>): string {
	const headers = new Headers()
	const xff = c.req.header('x-forwarded-for')
	if (xff) headers.set('x-forwarded-for', xff)
	const xri = c.req.header('x-real-ip')
	if (xri) headers.set('x-real-ip', xri)
	return resolveClientIpSync(headers, env.TRUSTED_PROXY_CIDRS)
}

function widgetRateLimitKey(c: Context<AppEnv>): string {
	const ip = extractClientIp(c)
	const slug = c.req.param('tenantSlug') ?? 'unknown'
	return `${ip}::${slug}`
}

const RATE_LIMIT_MESSAGE = {
	error: {
		code: 'RATE_LIMITED',
		message:
			'Слишком много запросов. Подождите минуту и попробуйте снова. Если повторяется — свяжитесь с гостиницей напрямую.',
	},
} as const

/**
 * Burst rate-limiter — 10 req/min/(IP+slug). Mounted FIRST (cheapest reject
 * before steady-state check). Fires 429 with `Retry-After` header.
 */
export const widgetBurstRateLimiter = rateLimiter<AppEnv>({
	windowMs: 60_000,
	limit: 10,
	keyGenerator: widgetRateLimitKey,
	standardHeaders: 'draft-7',
	statusCode: 429,
	message: RATE_LIMIT_MESSAGE,
})

/**
 * Steady rate-limiter — 100 req/hr/(IP+slug). Mounted AFTER burst — protects
 * against slow-and-low patterns that wouldn't trip burst window.
 */
export const widgetSteadyRateLimiter = rateLimiter<AppEnv>({
	windowMs: 60 * 60_000,
	limit: 100,
	keyGenerator: widgetRateLimitKey,
	standardHeaders: 'draft-7',
	statusCode: 429,
	message: RATE_LIMIT_MESSAGE,
})

/**
 * Test pass-through limiter — used by integration tests that need to exercise
 * the route without tripping the rate-limit window across many sequential cases.
 * Keeps full middleware chain shape while turning off the gate.
 */
export const noopRateLimiter: MiddlewareHandler<AppEnv> = async (_c, next) => {
	await next()
}

/**
 * Build limiter с custom cap для targeted 429 path tests. Same key generator
 * as production stack — verifies (IP, slug) bucketing semantics.
 */
export function makeTestRateLimiter(opts: {
	limit: number
	windowMs: number
}): MiddlewareHandler<AppEnv> {
	return rateLimiter<AppEnv>({
		windowMs: opts.windowMs,
		limit: opts.limit,
		keyGenerator: widgetRateLimitKey,
		standardHeaders: 'draft-7',
		statusCode: 429,
		message: RATE_LIMIT_MESSAGE,
	})
}

/** Test-only — internals для unit-test of key generation. */
export const __testWidgetRateLimitInternals = {
	extractClientIp,
	widgetRateLimitKey,
}
