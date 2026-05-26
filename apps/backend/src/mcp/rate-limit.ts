/**
 * Round 14 self-review #3 — MCP rate-limit middleware (cost runaway defense).
 *
 * Two-tier rate limit на `/api/mcp/rpc`:
 *
 *   1. **`mcpRpcRateLimit`** — broad limiter (120 req/min/IP) on all JSON-RPC
 *      traffic. Cap chosen mirroring `demoInboxRateLimiter` canon (1Hz polling
 *      × 2 headroom). Prevents wholesale `/rpc` flooding.
 *
 *   2. **`mcpAiRateLimit`** — strict secondary limiter (10 calls / 5 min / IP)
 *      gating only `tools/call` requests targeting `sepshn.ai.*` tools.
 *      AI tools incur real upstream cost per invocation (Yandex AI Studio
 *      0.20-0.80₽/1K tokens). Without this gate any attacker can drain the
 *      monthly budget. 10/5min = 2880/day/IP worst-case ≈ 230₽/day worst-case
 *      per attacker IP — bounded.
 *
 * Storage: in-memory MemoryStore (same as sibling `demoInboxRateLimiter`).
 * Multi-replica YC Serverless deployment OK для now (single container default);
 * Phase-2 = Unstorage carry-forward.
 *
 * IP extraction: shared `extractClientIp` (right-most-trusted-proxy canon
 * per `feedback_token_bucket_upstream_canon_2026_05_24`).
 */
import type { Context, MiddlewareHandler } from 'hono'
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

const MCP_AI_RATE_LIMIT_MESSAGE = {
	jsonrpc: '2.0',
	id: null,
	error: {
		code: -32029,
		message:
			'AI-tool rate-limit exceeded — sepshn.ai.* tools are budget-gated к 10 calls/5min/IP. Wait and retry.',
	},
} as const

function mcpRpcKey(c: Context<AppEnv>): string {
	return extractClientIp(c)
}

/** Broad MCP RPC rate-limit — 120 req/min/IP. */
export const mcpRpcRateLimit: MiddlewareHandler<AppEnv> = rateLimiter<AppEnv>({
	windowMs: 60_000,
	limit: 120,
	keyGenerator: mcpRpcKey,
	standardHeaders: 'draft-7',
	statusCode: 429,
	message: MCP_RATE_LIMIT_MESSAGE,
})

const aiRateLimitMiddleware = rateLimiter<AppEnv>({
	windowMs: 5 * 60_000,
	limit: 10,
	keyGenerator: (c) => `ai:${extractClientIp(c)}`,
	standardHeaders: 'draft-7',
	statusCode: 429,
	message: MCP_AI_RATE_LIMIT_MESSAGE,
})

/**
 * Run AI-specific rate-limit gate INSIDE the POST handler (after JSON parse +
 * tool name inspection) and return the 429 response if limit hit, else
 * `undefined` to let the handler continue. hono-rate-limiter is middleware-style
 * (calls `next()`), so we wrap it to capture/short-circuit.
 */
export async function mcpAiRateLimit(c: Context<AppEnv>): Promise<Response | undefined> {
	let nextCalled = false
	let blocked: Response | undefined
	await aiRateLimitMiddleware(c, async () => {
		nextCalled = true
	})
	if (!nextCalled) {
		// hono-rate-limiter wrote the 429 response into c.res directly when the
		// limiter aborted the chain without calling next() — clone и return so
		// the route handler short-circuits.
		blocked = c.res.clone()
	}
	return blocked
}
