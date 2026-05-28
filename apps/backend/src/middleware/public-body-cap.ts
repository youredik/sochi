/**
 * Public-endpoint body-size cap — Round 14.6.4 adversarial sweep #5 2026-05-29.
 *
 * Applied as middleware BEFORE `c.req.json()` / `c.req.text()` invocations on
 * anonymous-reachable Hono routes. Hono's `bodyLimit` throws `HTTPException(413)`
 * which the global `onError` handler now passes through verbatim (см.
 * `errors/on-error.ts` HTTPException branch — added same Round, same day).
 *
 * **Why 64 KB:** typical CloudEvents envelope is 8-16 KB; OAuth DCR registration
 * payload (RFC 7591) is < 4 KB; MCP JSON-RPC requests typically < 8 KB.
 * 64 KB = 4-8× safety margin, lets through legit requests with comfortable
 * headroom but cuts off JSON-bomb / quadratic-blowup / BigInt-CPU-burn attack
 * vectors at the transport layer.
 *
 * **Anonymous-reachable surfaces that MUST use this** (audit gate — keep this
 * list authoritative):
 *   - `/api/_mock-ota/yandex/*` (demo OTA receiver)
 *   - `/api/_mock-ota/ostrovok/*` (demo OTA receiver)
 *   - `/api/_mock-ota/admin/*` (admin token-gated, но защита в глубину)
 *   - `/api/oauth/register` (RFC 7591 DCR — by spec ANONYMOUS)
 *   - `/api/mcp/rpc` (JSON-RPC 2.0 over HTTP)
 *
 * **Webhook receivers** (`/api/channel/webhooks/:channelId`) use an inline
 * size check inside the handler body (см. `webhook.routes.ts` WHR16) instead
 * of this middleware — that path needs the raw bytes BEFORE size cap для
 * Standard Webhooks signature verification.
 *
 * Canon: `feedback_systematic_halfmeasure_pattern_2026_05_28` adversarial-sweep
 * methodology + Hono 4.x body-limit canonical pattern.
 */

import { bodyLimit } from 'hono/body-limit'

export const MAX_PUBLIC_BODY_BYTES = 64 * 1024

/** Hono middleware factory — apply via `.use('/*', publicBodyCap())`. */
export const publicBodyCap = () => bodyLimit({ maxSize: MAX_PUBLIC_BODY_BYTES })
