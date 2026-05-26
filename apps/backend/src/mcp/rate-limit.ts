/**
 * Round 14 self-review #4 — MCP rate-limit (cost runaway defense).
 *
 * Two-tier rate limit на `/api/mcp/rpc`:
 *
 *   1. **`mcpRpcRateLimit`** — broad limiter (120 req/min/IP) on all JSON-RPC
 *      traffic. Cap mirrors `demoInboxRateLimiter` canon (1Hz polling × 2
 *      headroom). Mounted via `app.use()` middleware.
 *
 *   2. **`checkAiRateLimit(ip)`** — strict in-memory token bucket (10 calls
 *      / 5 min / IP) gating `tools/call sepshn.ai.*` requests. AI tools incur
 *      real Yandex AI Studio cost — without gate, attacker drains budget.
 *      Inlined into the route handler AFTER body parse + tool name inspection
 *      (middleware can't easily peek into JSON body without consuming the stream).
 *
 * **Round 14 self-review #4 fix**: previous implementation used hono-rate-limiter
 * wrapped в an async middleware-capture helper that did NOT actually block the
 * route (verified empirically: 12 calls returned 200, AI tool fired regardless
 * of bucket state). The helper's `c.res.clone()` produced an empty 200 response
 * instead of the 429 because hono-rate-limiter writes к c.res via the route-
 * handler return path, not via middleware c.res mutation. Switched к explicit
 * in-memory bucket с direct return — testable, predictable, no library quirks.
 *
 * Storage: in-memory `Map`. Single-replica YC Serverless OK для now; Phase-2
 * = Unstorage carry-forward для multi-container deployments.
 *
 * IP extraction: shared `extractClientIp` (right-most-trusted-proxy canon per
 * `feedback_token_bucket_upstream_canon_2026_05_24`).
 */
import type { MiddlewareHandler } from 'hono'
import { rateLimiter } from 'hono-rate-limiter'
import type { AppEnv } from '../factory.ts'
import { extractClientIp } from '../middleware/widget-rate-limit.ts'

const MCP_RATE_LIMIT_MESSAGE = {
	jsonrpc: '2.0',
	id: null,
	error: {
		code: -32029,
		message: 'Слишком много MCP-запросов. Подождите и попробуйте снова.',
	},
} as const

export const MCP_AI_RATE_LIMIT_MESSAGE = {
	jsonrpc: '2.0',
	id: null,
	error: {
		code: -32029,
		message:
			'AI-tool rate-limit exceeded — sepshn.ai.* tools are budget-gated к 10 calls/5min/IP. Wait and retry.',
	},
} as const

function mcpRpcKey(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string {
	return extractClientIp(c)
}

/** Broad MCP RPC rate-limit — 120 req/min/IP. Mounted via `app.use('/rpc', ...)`. */
export const mcpRpcRateLimit: MiddlewareHandler<AppEnv> = rateLimiter<AppEnv>({
	windowMs: 60_000,
	limit: 120,
	keyGenerator: mcpRpcKey,
	standardHeaders: 'draft-7',
	statusCode: 429,
	message: MCP_RATE_LIMIT_MESSAGE,
})

// ─── In-memory AI bucket ─────────────────────────────────────────────────────

interface BucketEntry {
	count: number
	resetAt: number
}

const AI_BUCKET = new Map<string, BucketEntry>()
export const AI_WINDOW_MS = 5 * 60_000
export const AI_LIMIT = 10
const CLEANUP_THRESHOLD = 100

export interface AiRateLimitResult {
	readonly allowed: boolean
	readonly limit: number
	readonly remaining: number
	readonly resetMs: number
}

/**
 * Token-bucket check for AI tool calls. Returns `allowed=false` when bucket
 * exhausted within the 5-minute window. Bucket auto-resets when window expires.
 *
 * Opportunistic cleanup keeps the Map size bounded; full sweep only when ≥100
 * entries (avoid per-call O(n)). Memory cost: ~64 bytes/entry × 1k IPs = 64 KiB.
 */
export function checkAiRateLimit(ip: string, now: number = Date.now()): AiRateLimitResult {
	if (AI_BUCKET.size >= CLEANUP_THRESHOLD) {
		for (const [k, v] of AI_BUCKET) {
			if (v.resetAt <= now) AI_BUCKET.delete(k)
		}
	}
	const key = `ai:${ip}`
	const entry = AI_BUCKET.get(key)
	if (entry === undefined || entry.resetAt <= now) {
		AI_BUCKET.set(key, { count: 1, resetAt: now + AI_WINDOW_MS })
		return { allowed: true, limit: AI_LIMIT, remaining: AI_LIMIT - 1, resetMs: AI_WINDOW_MS }
	}
	if (entry.count >= AI_LIMIT) {
		return { allowed: false, limit: AI_LIMIT, remaining: 0, resetMs: entry.resetAt - now }
	}
	entry.count += 1
	return {
		allowed: true,
		limit: AI_LIMIT,
		remaining: AI_LIMIT - entry.count,
		resetMs: entry.resetAt - now,
	}
}

/** TEST-ONLY — reset bucket for clean test isolation. */
export function __resetAiBucket(): void {
	AI_BUCKET.clear()
}
