/**
 * Per-IP rate limiting для anti-enumeration + anti-abuse на JIT signup paths
 * (Sprint C+ Round 6 2026-05-24 — Security red team P0 vector #2).
 *
 * Attack vector закрытый этим middleware:
 *   1. Visitor → /api/auth/sign-in/magic-link с throwaway email
 *   2. BA `disableSignUp: false` + `organizationLimit: 5` allows JIT user
 *      creation + 5 free organizations each
 *   3. Bot loops 100 emails → 500 orgs → 500 × Vision rate-limit-per-tenant
 *      quota (30/min) = 15k Vision calls/min = ₽10k+/min YC bill
 *
 * Mitigation: per-IP rate-limit BEFORE BA captcha gate (which only fires on
 * the magic-link path itself, after BA's handler is invoked). Edge limit
 * drops floods before captcha pipeline expense.
 *
 * Buckets:
 *   - `magicLinkRateLimit`: 5 magic-link sends / 10 min / IP. Legitimate user
 *     рассылает 1 link, опционально retry × 2-3. 5 enough headroom; 10/min
 *     would admit enumeration. Window 10 min compresses bot cost vs admitting
 *     burst-then-quiet patterns.
 *   - `orgCreateRateLimit`: 3 org creates / hour / IP. Legitimate user — 1 org
 *     on signup. New hotels = rare event. Bot needing 100 orgs takes 33 hours
 *     vs minutes уoriginally — economic disincentive.
 *
 * Storage: in-memory MemoryStore (default). Single-instance YC Serverless
 * Container OK; multi-instance limits per-replica (acceptable since burst
 * attacker would need to traverse load-balancer hashing).
 *
 * IP extraction: right-most-trusted-proxy canon (B11 2026-05-19) via shared
 * `widget-rate-limit.extractClientIp`. RFC 7239/XFF rightmost-untrusted wins.
 */
import type { Context } from 'hono'
import { rateLimiter } from 'hono-rate-limiter'
import type { AppEnv } from '../factory.ts'
import { extractClientIp } from './widget-rate-limit.ts'

const MAGIC_LINK_RATE_LIMIT_MESSAGE = {
	error: {
		code: 'RATE_LIMITED',
		message:
			'Слишком много попыток входа. Подождите 10 минут и попробуйте снова. Если вы не запрашивали ссылку — кто-то другой пытается войти под вашим адресом.',
	},
} as const

const ORG_CREATE_RATE_LIMIT_MESSAGE = {
	error: {
		code: 'RATE_LIMITED',
		message:
			'Слишком много создаваемых организаций. Подождите час и попробуйте снова. Связь: hi@sepshn.ru.',
	},
} as const

function magicLinkKey(c: Context<AppEnv>): string {
	return `ml:${extractClientIp(c)}`
}

function orgCreateKey(c: Context<AppEnv>): string {
	return `org:${extractClientIp(c)}`
}

/**
 * 5 magic-link sends / 10 min / IP. Bursting bots get 429; UA-distinct
 * legitimate user рассылает 1 link + ~2-3 retries без surfacing 429.
 */
export const magicLinkRateLimit = rateLimiter<AppEnv>({
	windowMs: 10 * 60_000,
	limit: 5,
	keyGenerator: magicLinkKey,
	standardHeaders: 'draft-7',
	statusCode: 429,
	message: MAGIC_LINK_RATE_LIMIT_MESSAGE,
})

/**
 * 3 organization creates / hour / IP. Legitimate operator создаёт 1 org
 * on signup; chain hotel owner может create несколько в течение часа но
 * не больше 3 (manual onboarding gate). Bot needing N orgs throttled
 * к economic non-viability.
 */
export const orgCreateRateLimit = rateLimiter<AppEnv>({
	windowMs: 60 * 60_000,
	limit: 3,
	keyGenerator: orgCreateKey,
	standardHeaders: 'draft-7',
	statusCode: 429,
	message: ORG_CREATE_RATE_LIMIT_MESSAGE,
})

/** Test-only — exposed for unit-test of key generation. */
export const __testAuthSignupRateLimitInternals = {
	magicLinkKey,
	orgCreateKey,
}
